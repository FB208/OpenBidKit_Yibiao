import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EVENTS, RAW_DATASET } from '../../worker/src/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const dataRoot = resolve(__dirname, 'data', 'repair-2026-08-27-two-ip-cleanup');
const projectName = 'yibiao-client';
const targetDate = '2026-08-27';
const blockedIps = ['124.193.61.30', '64.118.148.223'];
const analyticsDatabaseName = 'openbidkit-analytics';
const applyChanges = process.argv.includes('--apply');

// 解析调查脚本共用的环境变量文件。
function loadEnv() {
  if (!existsSync(envPath)) throw new Error(`.env file not found: ${envPath}`);
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    let value = normalized.slice(equalsIndex + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) process.env[key] = value;
  }
}

// 读取 Cloudflare API 凭据。
function readCredentials() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim();
  const analyticsApiToken = String(process.env.ANALYTICS_API_TOKEN || '').trim();
  const d1ApiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!accountId || !analyticsApiToken || !d1ApiToken) throw new Error('Missing Cloudflare credentials');
  return { accountId, analyticsApiToken, d1ApiToken };
}

// 调用 Cloudflare JSON API。
async function requestCloudflareJson(url, options) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok || !data?.success) throw new Error(`${options.source} failed: ${response.status} ${text.slice(0, 500)}`);
  return data;
}

// 查询 Analytics Engine SQL API。
async function queryAnalytics(credentials, sql) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.analyticsApiToken}` },
    body: sql,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Analytics Engine query failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text).data || [];
}

// 查找生产统计 D1 数据库 UUID。
async function resolveD1DatabaseId(credentials) {
  const explicitId = String(process.env.ANALYTICS_DB_ID || '').trim();
  if (explicitId) return explicitId;
  const data = await requestCloudflareJson(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(analyticsDatabaseName)}&per_page=50`,
    { apiToken: credentials.d1ApiToken, source: 'D1 database list' },
  );
  const database = (data.result || []).find((item) => item.name === analyticsDatabaseName);
  if (!database?.uuid) throw new Error(`Unable to find D1 database: ${analyticsDatabaseName}`);
  return database.uuid;
}

// 对生产 D1 执行单条参数化 SQL。
async function queryD1(credentials, databaseId, sql, params = []) {
  const data = await requestCloudflareJson(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      apiToken: credentials.d1ApiToken,
      body: { sql, params },
      source: 'D1 query',
    },
  );
  const result = Array.isArray(data.result) ? data.result[0] : data.result;
  return { rows: result?.results || [], meta: result?.meta || {} };
}

// 查询当天两个异常出口 IP 产生的全部 Client ID。
async function loadTargetClientIds(credentials) {
  const quotedEvents = [...ALLOWED_EVENTS].map((event) => `'${event}'`).join(', ');
  const quotedIps = blockedIps.map((ip) => `'${ip}'`).join(', ');
  const rows = await queryAnalytics(credentials, `
    SELECT blob7 AS clientId, SUM(_sample_interval) AS eventCount
    FROM ${RAW_DATASET}
    WHERE blob1 = '${projectName}'
      AND blob2 IN (${quotedEvents})
      AND blob7 != ''
      AND blob13 IN (${quotedIps})
      AND formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') = '${targetDate}'
    GROUP BY blob7
    LIMIT 100000
  `);
  return rows.map((row) => String(row.clientId || '')).filter(Boolean).sort();
}

// 备份并选出 D1 中当天首次出现的异常客户端。
async function createBackup(credentials, databaseId, sourceClientIds, runRoot) {
  const idsJson = JSON.stringify(sourceClientIds);
  const totals = await queryD1(credentials, databaseId, 'SELECT * FROM stats_totals WHERE project_name = ?', [projectName]);
  const clients = sourceClientIds.length
    ? await queryD1(credentials, databaseId, `SELECT * FROM stats_clients WHERE project_name = ? AND first_seen_date = ? AND client_id IN (SELECT value FROM json_each(?)) ORDER BY client_id`, [projectName, targetDate, idsJson])
    : { rows: [] };
  const targetIds = clients.rows.map((client) => client.client_id);
  const activity = targetIds.length
    ? await queryD1(credentials, databaseId, `SELECT * FROM stats_client_activity WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, JSON.stringify(targetIds)])
    : { rows: [] };
  const backup = {
    createdAt: new Date().toISOString(),
    projectName,
    targetDate,
    blockedIps,
    sourceClientIds,
    totals: totals.rows,
    clients: clients.rows,
    activity: activity.rows,
  };
  writeFileSync(resolve(runRoot, 'backup.json'), `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  return backup;
}

// 删除异常客户端，并按权威客户端表重算总量和版本客户端数。
async function applyCleanup(credentials, databaseId, backup) {
  const targetIds = backup.clients.map((client) => client.client_id);
  if (targetIds.length) {
    const idsJson = JSON.stringify(targetIds);
    await queryD1(credentials, databaseId, `DELETE FROM stats_client_activity WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, idsJson]);
    await queryD1(credentials, databaseId, `DELETE FROM stats_clients WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, idsJson]);
  }
  const updatedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace('T', ' ');
  await queryD1(credentials, databaseId, `UPDATE stats_totals SET total_clients = (SELECT COUNT(*) FROM stats_clients WHERE project_name = ?), updated_at = ? WHERE project_name = ?`, [projectName, updatedAt, projectName]);
  await queryD1(credentials, databaseId, `UPDATE stats_versions SET client_count = 0, updated_at = ? WHERE project_name = ?`, [updatedAt, projectName]);
  await queryD1(credentials, databaseId, `
    INSERT INTO stats_versions (project_name, version, event_count, client_count, updated_at)
    SELECT project_name, last_active_version, 0, COUNT(*), ? FROM stats_clients
    WHERE project_name = ? AND last_active_version != '' GROUP BY project_name, last_active_version
    ON CONFLICT(project_name, version) DO UPDATE SET client_count = excluded.client_count, updated_at = excluded.updated_at
  `, [updatedAt, projectName]);
  return targetIds;
}

// 准备并按需执行当天异常客户端清理。
async function main() {
  if (process.argv.some((argument, index) => index > 1 && argument !== '--apply')) throw new Error('Only --apply is supported');
  loadEnv();
  const credentials = readCredentials();
  const databaseId = await resolveD1DatabaseId(credentials);
  const sourceClientIds = await loadTargetClientIds(credentials);
  const runRoot = resolve(dataRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runRoot, { recursive: true });
  const backup = await createBackup(credentials, databaseId, sourceClientIds, runRoot);
  console.log(`Prepared cleanup: AE clients=${sourceClientIds.length}, removable D1 clients=${backup.clients.length}`);
  if (!applyChanges) return;
  const removedClientIds = await applyCleanup(credentials, databaseId, backup);
  const remaining = await queryD1(credentials, databaseId, `SELECT COUNT(*) AS count FROM stats_clients WHERE project_name = ? AND first_seen_date = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, targetDate, JSON.stringify(sourceClientIds)]);
  const totals = await queryD1(credentials, databaseId, 'SELECT total_clients AS totalClients FROM stats_totals WHERE project_name = ?', [projectName]);
  const result = {
    completedAt: new Date().toISOString(),
    removedClientIds,
    remainingTargetClients: Number(remaining.rows[0]?.count || 0),
    totalClients: Number(totals.rows[0]?.totalClients || 0),
  };
  writeFileSync(resolve(runRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Cleanup completed: removed=${removedClientIds.length}, remaining=${result.remainingTargetClients}, totalClients=${result.totalClients}`);
  console.log(`Backup and result: ${runRoot}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
