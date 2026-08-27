import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const dataRoot = resolve(__dirname, 'data');
const targetDate = '2026-08-26';
const historyStartDate = addDateDays(targetDate, -92);
const projectName = 'yibiao-client';
const dataset = 'agnet_analytics';
const analyticsD1DatabaseName = 'openbidkit-analytics';
const d1PageSize = 1000;
const analyticsBatchSize = 40;
const analyticsRowLimit = 100000;
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

// 将日期偏移指定天数，供历史查询边界使用。
function addDateDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// 解析 .env 中带引号或行尾注释的值。
function parseEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return value;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

// 读取调查脚本上级目录中的 Cloudflare 凭据。
function loadEnv() {
  if (!existsSync(envPath)) {
    throw new Error(`.env file not found: ${envPath}`);
  }
  const source = readFileSync(envPath, 'utf8');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalizedLine.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalizedLine.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    process.env[key] = parseEnvValue(normalizedLine.slice(equalsIndex + 1));
  }
}

// 读取必需环境变量并在缺失时立即停止。
function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// 汇总两类 Cloudflare API 所需的只读凭据。
function readCredentials() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim();
  if (!accountId) throw new Error('Missing environment variable: CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID');
  return {
    accountId,
    analyticsApiToken: requiredEnv('ANALYTICS_API_TOKEN'),
    d1ApiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
    analyticsDatabaseId: String(process.env.ANALYTICS_DB_ID || '').trim(),
  };
}

// 等待 Cloudflare 限流或临时错误恢复。
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// 压缩 SQL 供错误信息展示，避免输出大批客户端标识。
function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

// 请求 Cloudflare 标准 JSON API，支持临时错误重试。
async function requestCloudflareJson(url, { method = 'GET', apiToken, body, source }) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.ok && data?.success) return data;
    const message = `${source} request failed: status=${response.status}; attempt=${attempt}; body=${text.slice(0, 600)}`;
    if (!retryableStatuses.has(response.status) || attempt === 4) throw new Error(message);
    console.warn(`${message}; retrying`);
    await sleep(500 * attempt);
  }
  throw new Error(`${source} request failed after retries`);
}

// 请求 Analytics Engine SQL API，保留服务端返回的采样信息。
async function queryAnalytics(credentials, sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/analytics_engine/sql`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.analyticsApiToken}` },
      body: sql,
    });
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`Analytics Engine returned invalid JSON: ${error.message}`);
      }
    }
    const message = `Analytics Engine query failed: status=${response.status}; attempt=${attempt}; sql=${compactSql(sql)}; body=${text.slice(0, 600)}`;
    if (!retryableStatuses.has(response.status) || attempt === 4) throw new Error(message);
    console.warn(`${message}; retrying`);
    await sleep(500 * attempt);
  }
  throw new Error('Analytics Engine query failed after retries');
}

// 根据数据库名称解析 Analytics D1 数据库 UUID。
async function resolveD1DatabaseId(credentials) {
  if (credentials.analyticsDatabaseId) return credentials.analyticsDatabaseId;
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(analyticsD1DatabaseName)}&per_page=50`;
  const data = await requestCloudflareJson(url, {
    apiToken: credentials.d1ApiToken,
    source: 'D1 database list',
  });
  const database = (data.result || []).find((item) => item.name === analyticsD1DatabaseName);
  if (!database?.uuid) throw new Error(`Unable to find D1 database: ${analyticsD1DatabaseName}`);
  return database.uuid;
}

// 对 D1 执行硬编码的只读 SELECT 查询。
async function queryD1(credentials, databaseId, sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${databaseId}/query`;
  const data = await requestCloudflareJson(url, {
    method: 'POST',
    apiToken: credentials.d1ApiToken,
    body: { sql, params },
    source: 'D1 SELECT',
  });
  const result = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!result || result.success === false) {
    throw new Error(`D1 SELECT failed: ${compactSql(sql)}`);
  }
  return { rows: result.results || [], meta: result.meta || {} };
}

// 使用键集分页完整下载客户端生命周期表。
async function downloadAllClients(credentials, databaseId) {
  const rows = [];
  const pageMeta = [];
  let cursor = '';
  while (true) {
    const result = await queryD1(credentials, databaseId, `
      SELECT
        project_name AS projectName,
        client_id AS clientId,
        first_seen_at AS firstSeenAt,
        first_seen_date AS firstSeenDate,
        active_days AS activeDays,
        last_active_date AS lastActiveDate,
        last_active_version AS lastActiveVersion,
        last_access_ip AS lastAccessIp,
        platform,
        arch,
        license_status AS licenseStatus,
        license_plan AS licensePlan,
        license_expires_at AS licenseExpiresAt,
        source_trusted AS sourceTrusted,
        untrusted_reason AS untrustedReason,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM stats_clients
      WHERE project_name = ? AND client_id > ?
      ORDER BY client_id ASC
      LIMIT ?
    `, [projectName, cursor, d1PageSize]);
    rows.push(...result.rows);
    pageMeta.push(result.meta);
    if (result.rows.length < d1PageSize) break;
    cursor = String(result.rows.at(-1)?.clientId || '');
    if (!cursor) throw new Error('D1 client pagination lost its cursor');
  }
  return { rows, pageMeta };
}

// 将数组拆成 Cloudflare SQL 可接受的小批次。
function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

// 转义 Analytics Engine SQL 字符串值。
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// 生成 Analytics Engine 的 IN 条件。
function sqlList(values) {
  return `(${values.map(sqlString).join(', ')})`;
}

// 下载目标新增客户端在 8 月 26 日的原始采样点。
async function downloadCohortEvents(credentials, clientIds) {
  const rows = [];
  let batchNumber = 0;
  for (const batch of chunks(clientIds, analyticsBatchSize)) {
    batchNumber += 1;
    console.log(`Downloading cohort events: batch ${batchNumber}/${Math.ceil(clientIds.length / analyticsBatchSize)}`);
    const result = await queryAnalytics(credentials, `
      SELECT
        formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S', 'Asia/Shanghai') AS eventTime,
        _sample_interval AS sampleInterval,
        blob2 AS event,
        blob3 AS page,
        blob4 AS version,
        blob5 AS platform,
        blob6 AS arch,
        blob7 AS clientId,
        blob8 AS clientCreatedDate,
        blob9 AS dimension9,
        blob10 AS dimension10,
        blob11 AS model,
        blob12 AS requestType,
        blob13 AS ip,
        blob14 AS licenseStatus,
        blob15 AS licensePlan,
        blob16 AS licenseExpiresAt,
        blob17 AS sourceTrusted,
        blob18 AS untrustedReason,
        double1 AS eventUnits,
        double2 AS promptTokens,
        double3 AS completionTokens,
        double4 AS totalTokens
      FROM ${dataset}
      WHERE blob1 = ${sqlString(projectName)}
        AND blob7 IN ${sqlList(batch)}
        AND formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') = ${sqlString(targetDate)}
      LIMIT ${analyticsRowLimit}
    `);
    const batchRows = result.data || [];
    if (batchRows.length >= analyticsRowLimit) {
      throw new Error(`Cohort event batch ${batchNumber} reached row limit ${analyticsRowLimit}`);
    }
    rows.push(...batchRows);
  }
  return rows;
}

// 下载新增客户端 IP 在目标日期前的历史客户端关联。
async function downloadIpHistory(credentials, ips) {
  const rows = [];
  let batchNumber = 0;
  for (const batch of chunks(ips, analyticsBatchSize)) {
    batchNumber += 1;
    console.log(`Downloading IP history: batch ${batchNumber}/${Math.ceil(ips.length / analyticsBatchSize)}`);
    const result = await queryAnalytics(credentials, `
      SELECT
        blob13 AS ip,
        blob7 AS clientId,
        formatDateTime(min(timestamp), '%Y-%m-%d %H:%M:%S', 'Asia/Shanghai') AS firstEventAt,
        formatDateTime(max(timestamp), '%Y-%m-%d %H:%M:%S', 'Asia/Shanghai') AS lastEventAt,
        argMin(blob8, timestamp) AS clientCreatedDate,
        argMax(blob4, timestamp) AS lastVersion,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount,
        SUM(if(blob2 = 'ai_request', double4 * _sample_interval, 0.0)) AS totalTokens
      FROM ${dataset}
      WHERE blob1 = ${sqlString(projectName)}
        AND blob13 IN ${sqlList(batch)}
        AND blob7 != ''
        AND formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') >= ${sqlString(historyStartDate)}
        AND formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') < ${sqlString(targetDate)}
      GROUP BY ip, clientId
      ORDER BY ip ASC, clientId ASC
      LIMIT ${analyticsRowLimit}
    `);
    const batchRows = result.data || [];
    if (batchRows.length >= analyticsRowLimit) {
      throw new Error(`IP history batch ${batchNumber} reached row limit ${analyticsRowLimit}`);
    }
    rows.push(...batchRows);
  }
  return rows;
}

// 将下载结果写成便于逐行处理的 UTF-8 JSONL。
function writeJsonLines(filePath, rows) {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
}

// 计算考虑 Analytics Engine 采样权重后的数值。
function weighted(value, sampleInterval) {
  return Number(value || 0) * Math.max(1, Number(sampleInterval || 1));
}

// 按客户端归集 AI 请求、Token 和访问 IP 证据。
function buildClientSummary(cohort, events, allClients, ipHistory) {
  const eventsByClient = new Map();
  for (const event of events) {
    const clientId = String(event.clientId || '');
    if (!eventsByClient.has(clientId)) eventsByClient.set(clientId, []);
    eventsByClient.get(clientId).push(event);
  }

  const priorD1ByIp = new Map();
  for (const client of allClients) {
    const ip = String(client.lastAccessIp || '');
    if (!ip || String(client.firstSeenDate || '') >= targetDate) continue;
    if (!priorD1ByIp.has(ip)) priorD1ByIp.set(ip, new Set());
    priorD1ByIp.get(ip).add(String(client.clientId || ''));
  }

  const priorAeByIp = new Map();
  for (const row of ipHistory) {
    const ip = String(row.ip || '');
    if (!ip) continue;
    if (!priorAeByIp.has(ip)) priorAeByIp.set(ip, new Set());
    priorAeByIp.get(ip).add(String(row.clientId || ''));
  }

  return cohort.map((client) => {
    const clientEvents = eventsByClient.get(String(client.clientId || '')) || [];
    const ips = new Set(clientEvents.map((event) => String(event.ip || '')).filter(Boolean));
    if (client.lastAccessIp) ips.add(String(client.lastAccessIp));
    let eventCount = 0;
    let aiRequestCount = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let textAiRequestCount = 0;
    let imageAiRequestCount = 0;
    let agentSuccessCount = 0;
    const models = new Set();
    const providers = new Set();
    const endpointHosts = new Set();
    for (const event of clientEvents) {
      const sampleInterval = event.sampleInterval;
      eventCount += weighted(1, sampleInterval);
      if (event.event === 'ai_request') {
        aiRequestCount += weighted(1, sampleInterval);
        promptTokens += weighted(event.promptTokens, sampleInterval);
        completionTokens += weighted(event.completionTokens, sampleInterval);
        totalTokens += weighted(event.totalTokens, sampleInterval);
        if (event.requestType === 'text') textAiRequestCount += weighted(1, sampleInterval);
        if (event.requestType === 'image') imageAiRequestCount += weighted(1, sampleInterval);
        if (event.model) models.add(String(event.model));
        if (event.dimension9) providers.add(String(event.dimension9));
        if (event.dimension10) endpointHosts.add(String(event.dimension10));
      }
      if (event.event === 'agent_runtime' && String(event.dimension9 || '').includes('|success|')) {
        agentSuccessCount += weighted(1, sampleInterval);
      }
    }
    const priorD1ClientIds = new Set();
    const priorAeClientIds = new Set();
    for (const ip of ips) {
      for (const clientId of priorD1ByIp.get(ip) || []) priorD1ClientIds.add(clientId);
      for (const clientId of priorAeByIp.get(ip) || []) priorAeClientIds.add(clientId);
    }
    return {
      ...client,
      ips: [...ips].sort(),
      eventCount,
      aiRequestCount,
      textAiRequestCount,
      imageAiRequestCount,
      promptTokens,
      completionTokens,
      totalTokens,
      hasConfirmedTokenUsage: totalTokens > 0,
      agentSuccessCount,
      models: [...models].sort(),
      providers: [...providers].sort(),
      endpointHosts: [...endpointHosts].sort(),
      priorD1ClientIdsOnSameIp: [...priorD1ClientIds].sort(),
      priorAeClientIdsOnSameIp: [...priorAeClientIds].sort(),
    };
  });
}

// 按 IP 汇总新增客户端和历史客户端的重合关系。
function buildIpSummary(clientSummary) {
  const byIp = new Map();
  for (const client of clientSummary) {
    for (const ip of client.ips) {
      if (!byIp.has(ip)) {
        byIp.set(ip, {
          ip,
          cohortClientIds: new Set(),
          aiClientIds: new Set(),
          tokenPositiveClientIds: new Set(),
          priorD1ClientIds: new Set(),
          priorAeClientIds: new Set(),
        });
      }
      const item = byIp.get(ip);
      item.cohortClientIds.add(client.clientId);
      if (client.aiRequestCount > 0) item.aiClientIds.add(client.clientId);
      if (client.totalTokens > 0) item.tokenPositiveClientIds.add(client.clientId);
      for (const clientId of client.priorD1ClientIdsOnSameIp) item.priorD1ClientIds.add(clientId);
      for (const clientId of client.priorAeClientIdsOnSameIp) item.priorAeClientIds.add(clientId);
    }
  }
  return [...byIp.values()].map((item) => ({
    ip: item.ip,
    cohortClientCount: item.cohortClientIds.size,
    cohortClientIds: [...item.cohortClientIds].sort(),
    aiClientCount: item.aiClientIds.size,
    aiClientIds: [...item.aiClientIds].sort(),
    tokenPositiveClientCount: item.tokenPositiveClientIds.size,
    tokenPositiveClientIds: [...item.tokenPositiveClientIds].sort(),
    priorD1ClientCount: item.priorD1ClientIds.size,
    priorD1ClientIds: [...item.priorD1ClientIds].sort(),
    priorAeClientCount: item.priorAeClientIds.size,
    priorAeClientIds: [...item.priorAeClientIds].sort(),
  })).sort((left, right) => right.cohortClientCount - left.cohortClientCount || left.ip.localeCompare(right.ip));
}

// 生成不含具体 IP 和客户端 ID 的调查总览。
function buildSummary(allClients, cohort, events, clientSummary, ipSummary) {
  const clientsWithIp = clientSummary.filter((client) => client.ips.length > 0);
  const cohortSharedIps = new Set(ipSummary.filter((item) => item.cohortClientCount > 1).map((item) => item.ip));
  const priorOverlapIps = new Set(ipSummary.filter((item) => item.priorD1ClientCount > 0 || item.priorAeClientCount > 0).map((item) => item.ip));
  return {
    projectName,
    targetDate,
    timezone: 'Asia/Shanghai',
    historyStartDate,
    downloadedAt: new Date().toISOString(),
    d1TotalClients: allClients.length,
    cohortClients: cohort.length,
    analyticsEngineRows: events.length,
    cohortClientsWithIp: clientsWithIp.length,
    uniqueCohortIps: ipSummary.length,
    sharedCohortIps: cohortSharedIps.size,
    clientsOnSharedCohortIp: clientSummary.filter((client) => client.ips.some((ip) => cohortSharedIps.has(ip))).length,
    priorOverlapIps: priorOverlapIps.size,
    clientsOnPriorOverlapIp: clientSummary.filter((client) => client.ips.some((ip) => priorOverlapIps.has(ip))).length,
    clientsWithAiRequest: clientSummary.filter((client) => client.aiRequestCount > 0).length,
    clientsWithConfirmedTokenUsage: clientSummary.filter((client) => client.totalTokens > 0).length,
    clientsWithOnlyZeroTokenAiRequests: clientSummary.filter((client) => client.aiRequestCount > 0 && client.totalTokens === 0).length,
    clientsWithoutAiRequest: clientSummary.filter((client) => client.aiRequestCount === 0).length,
    clientsWithAgentSuccess: clientSummary.filter((client) => client.agentSuccessCount > 0).length,
    weightedAiRequestCount: clientSummary.reduce((sum, client) => sum + client.aiRequestCount, 0),
    weightedTotalTokens: clientSummary.reduce((sum, client) => sum + client.totalTokens, 0),
  };
}

// 执行只读下载并把全部产物保存在本次调查目录内。
async function main() {
  loadEnv();
  const credentials = readCredentials();
  const runName = `${targetDate}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = resolve(dataRoot, runName);
  mkdirSync(outputDir, { recursive: true });
  console.log(`Output: ${outputDir}`);
  console.log(`Project: ${projectName}`);
  console.log(`Business date: ${targetDate} Asia/Shanghai`);

  const databaseId = await resolveD1DatabaseId(credentials);
  console.log('Downloading D1 clients...');
  const allClientsResult = await downloadAllClients(credentials, databaseId);
  const allClients = allClientsResult.rows;
  const cohort = allClients.filter((client) => client.firstSeenDate === targetDate);
  writeJsonLines(resolve(outputDir, 'd1-all-clients.jsonl'), allClients);
  writeJsonLines(resolve(outputDir, 'd1-new-clients.jsonl'), cohort);
  console.log(`D1 clients downloaded: total=${allClients.length}, target cohort=${cohort.length}`);

  const clientIds = cohort.map((client) => String(client.clientId || '')).filter(Boolean);
  const cohortEvents = await downloadCohortEvents(credentials, clientIds);
  writeJsonLines(resolve(outputDir, 'analytics-engine-new-client-events.jsonl'), cohortEvents);
  console.log(`Cohort Analytics Engine rows downloaded: ${cohortEvents.length}`);

  const ips = [...new Set([
    ...cohort.map((client) => String(client.lastAccessIp || '')),
    ...cohortEvents.map((event) => String(event.ip || '')),
  ].filter(Boolean))].sort();
  const ipHistory = await downloadIpHistory(credentials, ips);
  writeJsonLines(resolve(outputDir, 'analytics-engine-ip-history.jsonl'), ipHistory);
  console.log(`Historical IP/client rows downloaded: ${ipHistory.length}`);

  const clientSummary = buildClientSummary(cohort, cohortEvents, allClients, ipHistory);
  const ipSummary = buildIpSummary(clientSummary);
  const summary = buildSummary(allClients, cohort, cohortEvents, clientSummary, ipSummary);
  writeJsonLines(resolve(outputDir, 'new-client-summary.jsonl'), clientSummary);
  writeJsonLines(resolve(outputDir, 'ip-summary.jsonl'), ipSummary);
  writeFileSync(resolve(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify({
    status: 'completed',
    targetDate,
    timezone: 'Asia/Shanghai',
    projectName,
    dataset,
    historyStartDate,
    downloadedAt: summary.downloadedAt,
    credentialsFile: envPath,
    credentialsPersisted: false,
    d1DatabaseName: analyticsD1DatabaseName,
    d1PageMeta: allClientsResult.pageMeta,
    files: {
      'd1-all-clients.jsonl': allClients.length,
      'd1-new-clients.jsonl': cohort.length,
      'analytics-engine-new-client-events.jsonl': cohortEvents.length,
      'analytics-engine-ip-history.jsonl': ipHistory.length,
      'new-client-summary.jsonl': clientSummary.length,
      'ip-summary.jsonl': ipSummary.length,
    },
  }, null, 2)}\n`, 'utf8');

  console.log('Download completed.');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
