import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_RUNTIME_MAX_RETRY_COUNT,
  ALLOWED_EVENTS,
  CONFIG_USAGE_FIELDS,
  DATASET,
  RAW_DATASET,
} from '../../worker/src/constants.js';
import { createResourceAnalyticsKey } from '../../worker/src/services/resourceStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const dataRoot = resolve(__dirname, 'data');
const repairRoot = resolve(dataRoot, 'repair-2026-08-26-two-ip-cleanup');
const backupPath = resolve(repairRoot, 'backup.json');
const planPath = resolve(repairRoot, 'plan.json');
const resultPath = resolve(repairRoot, 'result.json');
const projectName = 'yibiao-client';
const targetDate = '2026-08-26';
const blockedIps = ['124.193.61.30', '64.118.148.223'];
const expectedClientCount = 270;
const analyticsDatabaseName = 'openbidkit-analytics';
const resourceDatabaseName = 'openbidkit-resources';
const repairStage = 'repair:exclude-2026-08-26-test-ips';
const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const applyChanges = process.argv.includes('--apply');

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

// 读取调查目录上级的 Cloudflare 凭据文件。
function loadEnv() {
  if (!existsSync(envPath)) throw new Error(`.env file not found: ${envPath}`);
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
    }
  }
}

// 读取必需环境变量。
function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// 汇总 Analytics Engine 与 D1 API 凭据。
function readCredentials() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim();
  if (!accountId) throw new Error('Missing environment variable: CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID');
  return {
    accountId,
    analyticsApiToken: requiredEnv('ANALYTICS_API_TOKEN'),
    d1ApiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
    analyticsDatabaseId: String(process.env.ANALYTICS_DB_ID || '').trim(),
    resourceDatabaseId: String(process.env.RESOURCE_DB_ID || '').trim(),
  };
}

// 等待 Cloudflare 临时错误恢复。
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// 压缩 SQL 供错误日志展示。
function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// 请求 Cloudflare 标准 JSON API并重试临时错误。
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
    const message = `${source} failed: status=${response.status}; attempt=${attempt}; body=${text.slice(0, 800)}`;
    if (!retryableStatuses.has(response.status) || attempt === 4) throw new Error(message);
    console.warn(`${message}; retrying`);
    await sleep(500 * attempt);
  }
  throw new Error(`${source} failed after retries`);
}

// 查询 Analytics Engine SQL API。
async function queryAnalytics(credentials, sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/analytics_engine/sql`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.analyticsApiToken}` },
      body: sql,
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text);
    const message = `Analytics Engine query failed: status=${response.status}; attempt=${attempt}; sql=${compactSql(sql)}; body=${text.slice(0, 800)}`;
    if (!retryableStatuses.has(response.status) || attempt === 4) throw new Error(message);
    console.warn(`${message}; retrying`);
    await sleep(500 * attempt);
  }
  throw new Error('Analytics Engine query failed after retries');
}

// 按名称解析 D1 数据库 UUID。
async function resolveD1DatabaseId(credentials, databaseName, explicitId) {
  if (explicitId) return explicitId;
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=50`;
  const data = await requestCloudflareJson(url, {
    apiToken: credentials.d1ApiToken,
    source: `D1 database list (${databaseName})`,
  });
  const database = (data.result || []).find((item) => item.name === databaseName);
  if (!database?.uuid) throw new Error(`Unable to find D1 database: ${databaseName}`);
  return database.uuid;
}

// 对指定 D1 数据库执行 SQL。
async function queryD1(credentials, databaseId, sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${databaseId}/query`;
  const data = await requestCloudflareJson(url, {
    method: 'POST',
    apiToken: credentials.d1ApiToken,
    body: { sql, params },
    source: `D1 query (${compactSql(sql)})`,
  });
  const result = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!result || result.success === false) throw new Error(`D1 query failed: ${compactSql(sql)}`);
  return { rows: result.results || [], meta: result.meta || {} };
}

// 转义 Analytics Engine SQL 字符串。
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// 生成 Analytics Engine SQL 列表。
function sqlList(values) {
  return `(${values.map(sqlString).join(', ')})`;
}

// 将数值规范为有限数字。
function number(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

// 返回不小于零的整数修复目标。
function targetNumber(value) {
  return Math.max(0, Math.round(number(value)));
}

// 读取 UTF-8 JSONL 文件。
function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// 定位完成的数据下载目录。
function findCompletedDownloadRun() {
  const runs = readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(targetDate))
    .map((entry) => resolve(dataRoot, entry.name))
    .filter((runPath) => existsSync(resolve(runPath, 'manifest.json')))
    .filter((runPath) => JSON.parse(readFileSync(resolve(runPath, 'manifest.json'), 'utf8')).status === 'completed')
    .sort();
  const runPath = runs.at(-1);
  if (!runPath) throw new Error('Completed 2026-08-26 download run not found');
  return runPath;
}

// 读取调查时下载的 401 个新增客户端快照。
function loadDownloadedClients() {
  const runPath = findCompletedDownloadRun();
  return readJsonLines(resolve(runPath, 'd1-new-clients.jsonl'));
}

// 从已确认表格中提取两个异常 IP 对应的 270 个客户端。
function loadTargetClientIds(clients) {
  const ids = clients
    .filter((client) => blockedIps.includes(String(client.lastAccessIp || '')))
    .map((client) => String(client.clientId || ''))
    .filter(Boolean)
    .sort();
  if (ids.length !== expectedClientCount) {
    throw new Error(`Expected ${expectedClientCount} target clients, found ${ids.length}`);
  }
  return ids;
}

// 将 Agent 指标编码字段安全解码。
function decodeMetricPart(value, maxLength) {
  try {
    return decodeURIComponent(String(value || '')).trim().slice(0, maxLength);
  } catch {
    return String(value || '').trim().slice(0, maxLength);
  }
}

// 解析 Agent runtime 的 v2/v3/v4 指标键。
function parseAgentMetricKey(value) {
  const parts = String(value || '').split('|');
  const version = parts[0];
  const isV2 = version === 'v2' && parts.length >= 6;
  const isV3 = version === 'v3' && parts.length >= 7;
  const isV4 = version === 'v4' && parts.length >= 7;
  if (!isV2 && !isV3 && !isV4) return null;
  const offset = isV3 || isV4 ? 1 : 0;
  const runtime = isV3 || isV4 ? decodeMetricPart(parts[1], 40) : 'opencode';
  const status = parts[1 + offset];
  const retryMatch = (isV4 ? /^m(\d+)$/ : /^r(\d+)$/).exec(parts[2 + offset]);
  if (!runtime || !['success', 'failed'].includes(status) || !retryMatch) return null;
  const retryCount = Math.min(isV4 ? 9999 : AGENT_RUNTIME_MAX_RETRY_COUNT, number(retryMatch[1]));
  return {
    runtime,
    status,
    retryKind: isV4 ? 'model' : 'result',
    retryCount,
    provider: decodeMetricPart(parts[3 + offset], 80),
    endpointHost: decodeMetricPart(parts[4 + offset], 120),
    model: decodeMetricPart(parts.slice(5 + offset).join('|'), 160),
  };
}

// 将异常 Agent 指标汇总成 D1 表字段增量。
function buildAgentDeltas(metricRows) {
  const grouped = new Map();
  for (const row of metricRows) {
    const parsed = parseAgentMetricKey(row.metricKey);
    const count = number(row.runCount);
    if (!parsed || count <= 0) continue;
    const key = [parsed.runtime, parsed.provider, parsed.endpointHost, parsed.model].join('\0');
    if (!grouped.has(key)) {
      grouped.set(key, {
        runtime: parsed.runtime,
        provider: parsed.provider,
        endpointHost: parsed.endpointHost,
        model: parsed.model,
        successCount: 0,
        failedCount: 0,
        totalCount: 0,
        resultRetryCount: 0,
        resultRetriedRunCount: 0,
        resultRetrySuccessCount: 0,
        modelRunCount: 0,
        modelRetryCount: 0,
        modelRetriedRunCount: 0,
        modelRetrySuccessCount: 0,
      });
    }
    const target = grouped.get(key);
    if (parsed.status === 'success') target.successCount += count;
    if (parsed.status === 'failed') target.failedCount += count;
    target.totalCount += count;
    if (parsed.retryKind === 'model') {
      target.modelRunCount += count;
      target.modelRetryCount += count * parsed.retryCount;
      if (parsed.retryCount > 0) {
        target.modelRetriedRunCount += count;
        if (parsed.status === 'success') target.modelRetrySuccessCount += count;
      }
    } else {
      target.resultRetryCount += count * parsed.retryCount;
      if (parsed.retryCount > 0) {
        target.resultRetriedRunCount += count;
        if (parsed.status === 'success') target.resultRetrySuccessCount += count;
      }
    }
  }
  return [...grouped.values()];
}

// 根据键字段创建行索引。
function indexRows(rows, fields) {
  return new Map(rows.map((row) => [fields.map((field) => String(row[field] ?? '')).join('\0'), row]));
}

// 从 D1 原值扣除异常增量，得到幂等绝对目标。
function buildCounterTargets(backupRows, badRows, keyFields, countFields) {
  const backupByKey = indexRows(backupRows, keyFields);
  const targets = [];
  for (const badRow of badRows) {
    const key = keyFields.map((field) => String(badRow[field] ?? '')).join('\0');
    const backupRow = backupByKey.get(key);
    if (!backupRow) continue;
    const target = { ...backupRow };
    for (const field of countFields) {
      target[field] = targetNumber(number(backupRow[field]) - number(badRow[field]));
    }
    targets.push(target);
  }
  return targets;
}

// 下载修复前所有受影响 D1 行并固化本地备份。
async function createBackup(credentials, analyticsDatabaseId, resourceDatabaseId, clientIds) {
  const clientIdsJson = JSON.stringify(clientIds);
  const queries = {
    totals: [`SELECT * FROM stats_totals WHERE project_name = ?`, [projectName]],
    daily: [`SELECT * FROM stats_daily WHERE project_name = ? AND activity_date = ?`, [projectName, targetDate]],
    pages: [`SELECT page, view_count AS count FROM stats_pages WHERE project_name = ?`, [projectName]],
    versions: [`SELECT version, event_count AS eventCount, client_count AS clientCount FROM stats_versions WHERE project_name = ?`, [projectName]],
    configs: [`SELECT field_key AS fieldKey, value, report_count AS reportCount FROM stats_configs WHERE project_name = ?`, [projectName]],
    models: [`SELECT request_type AS requestType, provider, endpoint_host AS endpointHost, model, request_count AS requestCount, total_tokens AS totalTokens FROM stats_models WHERE project_name = ?`, [projectName]],
    agents: [`SELECT runtime, provider, endpoint_host AS endpointHost, model, success_count AS successCount, failed_count AS failedCount, total_count AS totalCount, retry_count AS resultRetryCount, retried_run_count AS resultRetriedRunCount, retry_success_count AS resultRetrySuccessCount, model_run_count AS modelRunCount, model_retry_count AS modelRetryCount, model_retried_run_count AS modelRetriedRunCount, model_retry_success_count AS modelRetrySuccessCount FROM stats_agent_runtime WHERE project_name = ?`, [projectName]],
    clients: [`SELECT * FROM stats_clients WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, clientIdsJson]],
    activity: [`SELECT * FROM stats_client_activity WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, clientIdsJson]],
    retention: [`SELECT * FROM stats_retention WHERE project_name = ? AND snapshot_date = ?`, [projectName, targetDate]],
    rollupRuns: [`SELECT * FROM stats_rollup_runs WHERE project_name = ? AND activity_date = ?`, [projectName, targetDate]],
    rollupStages: [`SELECT * FROM stats_rollup_stages WHERE project_name = ? AND activity_date = ?`, [projectName, targetDate]],
  };
  const backup = { createdAt: new Date().toISOString(), projectName, targetDate, blockedIps, clientIds };
  for (const [name, [sql, params]] of Object.entries(queries)) {
    backup[name] = (await queryD1(credentials, analyticsDatabaseId, sql, params)).rows;
  }
  backup.resources = resourceDatabaseId
    ? (await queryD1(credentials, resourceDatabaseId, `SELECT id, click_count AS clickCount FROM resources`, [])).rows
      .map((row) => ({ ...row, analyticsKey: createResourceAnalyticsKey(row.id) }))
    : [];
  if (backup.clients.length !== expectedClientCount) {
    throw new Error(`Expected ${expectedClientCount} D1 target clients, found ${backup.clients.length}`);
  }
  const rollup = backup.rollupRuns[0];
  if (rollup?.status !== 'success') {
    throw new Error(`2026-08-26 rollup is not successful: ${rollup?.status || 'missing'}`);
  }
  writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  return backup;
}

// 查询过滤后当日值及两个异常 IP 对各累计维度的贡献。
async function queryRepairInputs(credentials) {
  const dateCondition = `formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') = ${sqlString(targetDate)}`;
  const projectCondition = `blob1 = ${sqlString(projectName)}`;
  const badCondition = `blob13 IN ${sqlList(blockedIps)}`;
  const allowedEvents = sqlList([...ALLOWED_EVENTS]);
  const configKeys = sqlList(CONFIG_USAGE_FIELDS.map((field) => field.key));
  const queries = {
    filteredDaily: `
      SELECT
        COUNT(DISTINCT blob7) AS activeClients,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${DATASET}
      WHERE ${projectCondition} AND blob2 IN ${allowedEvents} AND ${dateCondition}
    `,
    badDaily: `
      SELECT
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${RAW_DATASET}
      WHERE ${projectCondition} AND blob2 IN ${allowedEvents} AND ${dateCondition} AND ${badCondition}
    `,
    badPages: `SELECT blob3 AS page, SUM(_sample_interval) AS count FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 = 'page_view' AND blob3 != '' AND ${dateCondition} AND ${badCondition} GROUP BY page LIMIT 100000`,
    badVersions: `SELECT if(blob4 = '', '未知版本', blob4) AS version, SUM(_sample_interval) AS eventCount FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 IN ${allowedEvents} AND ${dateCondition} AND ${badCondition} GROUP BY version LIMIT 100000`,
    badConfigs: `SELECT blob9 AS fieldKey, blob10 AS value, SUM(_sample_interval) AS reportCount FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 = 'config_usage' AND blob9 IN ${configKeys} AND blob10 != '' AND ${dateCondition} AND ${badCondition} GROUP BY fieldKey, value LIMIT 100000`,
    badModels: `SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model, SUM(_sample_interval) AS requestCount, SUM(double4 * _sample_interval) AS totalTokens FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 = 'ai_request' AND blob12 IN ('text', 'image') AND blob11 != '' AND ${dateCondition} AND ${badCondition} GROUP BY requestType, provider, endpointHost, model LIMIT 100000`,
    badAgentMetrics: `SELECT blob9 AS metricKey, SUM(_sample_interval) AS runCount FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 = 'agent_runtime' AND blob9 != '' AND ${dateCondition} AND ${badCondition} GROUP BY metricKey LIMIT 100000`,
    badResources: `SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount FROM ${RAW_DATASET} WHERE ${projectCondition} AND blob2 = 'resource_click' AND blob9 != '' AND ${dateCondition} AND ${badCondition} GROUP BY resourceKey LIMIT 100000`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    console.log(`Querying Analytics Engine: ${name}`);
    result[name] = (await queryAnalytics(credentials, sql)).data || [];
  }
  return result;
}

// 根据备份与异常贡献生成可重复执行的绝对修复计划。
function createPlan(backup, inputs) {
  const badDaily = inputs.badDaily[0] || {};
  const filteredDaily = inputs.filteredDaily[0] || {};
  const totals = backup.totals[0];
  const daily = backup.daily[0];
  if (!totals || !daily) throw new Error('Required D1 totals/daily rows are missing');
  const badAgents = buildAgentDeltas(inputs.badAgentMetrics);
  const pageTargets = buildCounterTargets(backup.pages, inputs.badPages, ['page'], ['count']);
  const versionTargets = buildCounterTargets(backup.versions, inputs.badVersions, ['version'], ['eventCount']);
  const configTargets = buildCounterTargets(backup.configs, inputs.badConfigs, ['fieldKey', 'value'], ['reportCount']);
  const modelTargets = buildCounterTargets(backup.models, inputs.badModels, ['requestType', 'provider', 'endpointHost', 'model'], ['requestCount', 'totalTokens']);
  const agentCountFields = [
    'successCount', 'failedCount', 'totalCount',
    'resultRetryCount', 'resultRetriedRunCount', 'resultRetrySuccessCount',
    'modelRunCount', 'modelRetryCount', 'modelRetriedRunCount', 'modelRetrySuccessCount',
  ];
  const agentTargets = buildCounterTargets(backup.agents, badAgents, ['runtime', 'provider', 'endpointHost', 'model'], agentCountFields);
  const resourceTargets = buildCounterTargets(backup.resources, inputs.badResources.map((row) => ({
    analyticsKey: row.resourceKey,
    clickCount: row.clickCount,
  })), ['analyticsKey'], ['clickCount']);
  return {
    createdAt: new Date().toISOString(),
    projectName,
    targetDate,
    blockedIps,
    expectedClientCount,
    clientIds: backup.clientIds,
    filteredDaily: {
      activeClients: targetNumber(filteredDaily.activeClients),
      appOpenCount: targetNumber(filteredDaily.appOpenCount),
      pageViewCount: targetNumber(filteredDaily.pageViewCount),
      eventCount: targetNumber(filteredDaily.eventCount),
      aiRequestCount: targetNumber(filteredDaily.aiRequestCount),
    },
    totals: {
      totalOpen: targetNumber(number(totals.total_open) - number(badDaily.appOpenCount)),
      totalPageViews: targetNumber(number(totals.total_page_views) - number(badDaily.pageViewCount)),
      totalEvents: targetNumber(number(totals.total_events) - number(badDaily.eventCount)),
      totalAiRequests: targetNumber(number(totals.total_ai_requests) - number(badDaily.aiRequestCount)),
    },
    badDaily: {
      appOpenCount: targetNumber(badDaily.appOpenCount),
      pageViewCount: targetNumber(badDaily.pageViewCount),
      eventCount: targetNumber(badDaily.eventCount),
      aiRequestCount: targetNumber(badDaily.aiRequestCount),
    },
    pageTargets,
    versionTargets,
    configTargets,
    modelTargets,
    agentTargets,
    resourceTargets,
  };
}

// 写入或删除页面累计目标。
async function applyPageTargets(credentials, databaseId, rows, updatedAt) {
  for (const row of rows) {
    if (row.count === 0) {
      await queryD1(credentials, databaseId, `DELETE FROM stats_pages WHERE project_name = ? AND page = ?`, [projectName, row.page]);
    } else {
      await queryD1(credentials, databaseId, `UPDATE stats_pages SET view_count = ?, updated_at = ? WHERE project_name = ? AND page = ?`, [row.count, updatedAt, projectName, row.page]);
    }
  }
}

// 写入或删除版本累计目标。
async function applyVersionTargets(credentials, databaseId, rows, updatedAt) {
  for (const row of rows) {
    if (row.eventCount === 0) {
      await queryD1(credentials, databaseId, `DELETE FROM stats_versions WHERE project_name = ? AND version = ?`, [projectName, row.version]);
    } else {
      await queryD1(credentials, databaseId, `UPDATE stats_versions SET event_count = ?, updated_at = ? WHERE project_name = ? AND version = ?`, [row.eventCount, updatedAt, projectName, row.version]);
    }
  }
}

// 写入或删除配置累计目标。
async function applyConfigTargets(credentials, databaseId, rows, updatedAt) {
  for (const row of rows) {
    if (row.reportCount === 0) {
      await queryD1(credentials, databaseId, `DELETE FROM stats_configs WHERE project_name = ? AND field_key = ? AND value = ?`, [projectName, row.fieldKey, row.value]);
    } else {
      await queryD1(credentials, databaseId, `UPDATE stats_configs SET report_count = ?, updated_at = ? WHERE project_name = ? AND field_key = ? AND value = ?`, [row.reportCount, updatedAt, projectName, row.fieldKey, row.value]);
    }
  }
}

// 写入或删除模型累计目标。
async function applyModelTargets(credentials, databaseId, rows, updatedAt) {
  for (const row of rows) {
    const keys = [projectName, row.requestType, row.provider, row.endpointHost, row.model];
    if (row.requestCount === 0 && row.totalTokens === 0) {
      await queryD1(credentials, databaseId, `DELETE FROM stats_models WHERE project_name = ? AND request_type = ? AND provider = ? AND endpoint_host = ? AND model = ?`, keys);
    } else {
      await queryD1(credentials, databaseId, `UPDATE stats_models SET request_count = ?, total_tokens = ?, updated_at = ? WHERE project_name = ? AND request_type = ? AND provider = ? AND endpoint_host = ? AND model = ?`, [row.requestCount, row.totalTokens, updatedAt, ...keys]);
    }
  }
}

// 写入或删除 Agent 累计目标。
async function applyAgentTargets(credentials, databaseId, rows, updatedAt) {
  for (const row of rows) {
    const keys = [projectName, row.runtime, row.provider, row.endpointHost, row.model];
    if (row.totalCount === 0) {
      await queryD1(credentials, databaseId, `DELETE FROM stats_agent_runtime WHERE project_name = ? AND runtime = ? AND provider = ? AND endpoint_host = ? AND model = ?`, keys);
    } else {
      await queryD1(credentials, databaseId, `
        UPDATE stats_agent_runtime SET
          success_count = ?, failed_count = ?, total_count = ?,
          retry_count = ?, retried_run_count = ?, retry_success_count = ?,
          model_run_count = ?, model_retry_count = ?, model_retried_run_count = ?, model_retry_success_count = ?,
          updated_at = ?
        WHERE project_name = ? AND runtime = ? AND provider = ? AND endpoint_host = ? AND model = ?
      `, [
        row.successCount, row.failedCount, row.totalCount,
        row.resultRetryCount, row.resultRetriedRunCount, row.resultRetrySuccessCount,
        row.modelRunCount, row.modelRetryCount, row.modelRetriedRunCount, row.modelRetrySuccessCount,
        updatedAt, ...keys,
      ]);
    }
  }
}

// 写入资源点击累计目标。
async function applyResourceTargets(credentials, databaseId, rows) {
  if (!databaseId || !rows.length) return;
  for (const row of rows) {
    await queryD1(credentials, databaseId, `UPDATE resources SET click_count = ? WHERE id = ?`, [row.clickCount, row.id]);
  }
}

// 按固化计划执行幂等 D1 修复。
async function applyPlan(credentials, analyticsDatabaseId, resourceDatabaseId, plan) {
  const marker = (await queryD1(credentials, analyticsDatabaseId, `SELECT status FROM stats_rollup_stages WHERE project_name = ? AND activity_date = ? AND stage = ?`, [projectName, targetDate, repairStage])).rows[0];
  if (marker?.status === 'success') {
    console.log('Repair already completed; skipping writes.');
    return;
  }
  const updatedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace('T', ' ');
  const clientIdsJson = JSON.stringify(plan.clientIds);

  await queryD1(credentials, analyticsDatabaseId, `
    UPDATE stats_daily SET
      active_clients = ?, app_open_count = ?, page_view_count = ?, event_count = ?, ai_request_count = ?, updated_at = ?
    WHERE project_name = ? AND activity_date = ?
  `, [
    plan.filteredDaily.activeClients, plan.filteredDaily.appOpenCount, plan.filteredDaily.pageViewCount,
    plan.filteredDaily.eventCount, plan.filteredDaily.aiRequestCount, updatedAt, projectName, targetDate,
  ]);
  await applyPageTargets(credentials, analyticsDatabaseId, plan.pageTargets, updatedAt);
  await applyVersionTargets(credentials, analyticsDatabaseId, plan.versionTargets, updatedAt);
  await applyConfigTargets(credentials, analyticsDatabaseId, plan.configTargets, updatedAt);
  await applyModelTargets(credentials, analyticsDatabaseId, plan.modelTargets, updatedAt);
  await applyAgentTargets(credentials, analyticsDatabaseId, plan.agentTargets, updatedAt);
  await applyResourceTargets(credentials, resourceDatabaseId, plan.resourceTargets);

  await queryD1(credentials, analyticsDatabaseId, `DELETE FROM stats_client_activity WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, clientIdsJson]);
  await queryD1(credentials, analyticsDatabaseId, `DELETE FROM stats_clients WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))`, [projectName, clientIdsJson]);
  await queryD1(credentials, analyticsDatabaseId, `UPDATE stats_versions SET client_count = 0, updated_at = ? WHERE project_name = ?`, [updatedAt, projectName]);
  await queryD1(credentials, analyticsDatabaseId, `
    INSERT INTO stats_versions (project_name, version, event_count, client_count, updated_at)
    SELECT project_name, last_active_version, 0, COUNT(*), ?
    FROM stats_clients
    WHERE project_name = ? AND last_active_version != ''
    GROUP BY project_name, last_active_version
    ON CONFLICT(project_name, version) DO UPDATE SET client_count = excluded.client_count, updated_at = excluded.updated_at
  `, [updatedAt, projectName]);
  await queryD1(credentials, analyticsDatabaseId, `
    UPDATE stats_totals SET
      total_clients = (SELECT COUNT(*) FROM stats_clients WHERE project_name = ?),
      total_open = ?, total_page_views = ?, total_events = ?, total_ai_requests = ?,
      total_text_tokens = COALESCE((SELECT SUM(total_tokens) FROM stats_models WHERE project_name = ? AND request_type = 'text'), 0),
      total_generated_images = COALESCE((SELECT SUM(request_count) FROM stats_models WHERE project_name = ? AND request_type = 'image'), 0),
      updated_at = ?
    WHERE project_name = ?
  `, [
    projectName, plan.totals.totalOpen, plan.totals.totalPageViews, plan.totals.totalEvents, plan.totals.totalAiRequests,
    projectName, projectName, updatedAt, projectName,
  ]);
  await queryD1(credentials, analyticsDatabaseId, `
    INSERT INTO stats_rollup_stages (project_name, activity_date, stage, status, started_at, completed_at, error)
    VALUES (?, ?, ?, 'success', ?, ?, '')
    ON CONFLICT(project_name, activity_date, stage) DO UPDATE SET status = 'success', completed_at = excluded.completed_at, error = ''
  `, [projectName, targetDate, repairStage, updatedAt, updatedAt]);
}

// 读取修复后的关键统计并写入结果文件。
async function writeResult(credentials, analyticsDatabaseId, plan, downloadedClients) {
  const overview = await queryD1(credentials, analyticsDatabaseId, `
    SELECT
      (SELECT COUNT(*) FROM stats_clients WHERE project_name = ? AND first_seen_date = ?) AS newClients,
      (SELECT COUNT(*) FROM stats_clients WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))) AS remainingTargetClients,
      active_clients AS activeClients,
      app_open_count AS appOpenCount,
      page_view_count AS pageViewCount,
      event_count AS eventCount,
      ai_request_count AS aiRequestCount
    FROM stats_daily
    WHERE project_name = ? AND activity_date = ?
  `, [projectName, targetDate, projectName, JSON.stringify(plan.clientIds), projectName, targetDate]);
  const totals = await queryD1(credentials, analyticsDatabaseId, `SELECT * FROM stats_totals WHERE project_name = ?`, [projectName]);
  const remainingClients = await queryD1(credentials, analyticsDatabaseId, `
    SELECT client_id AS clientId, first_seen_at AS firstSeenAt, last_active_date AS lastActiveDate,
      last_access_ip AS lastAccessIp, last_active_version AS lastActiveVersion, platform
    FROM stats_clients
    WHERE project_name = ? AND first_seen_date = ?
    ORDER BY first_seen_at ASC, client_id ASC
  `, [projectName, targetDate]);
  const downloadedIds = new Set(downloadedClients.map((client) => String(client.clientId || '')));
  const result = {
    completedAt: new Date().toISOString(),
    projectName,
    targetDate,
    blockedIps,
    removedClients: plan.clientIds.length,
    daily: overview.rows[0] || {},
    totals: totals.rows[0] || {},
    clientsAddedAfterDownload: remainingClients.rows.filter((client) => !downloadedIds.has(client.clientId)),
    remainingClients: remainingClients.rows,
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

// 准备或执行本次历史数据修复。
async function main() {
  if (process.argv.some((argument, index) => index > 1 && argument !== '--apply')) {
    throw new Error('Only --apply is supported');
  }
  mkdirSync(repairRoot, { recursive: true });
  loadEnv();
  const credentials = readCredentials();
  const analyticsDatabaseId = await resolveD1DatabaseId(credentials, analyticsDatabaseName, credentials.analyticsDatabaseId);
  const resourceDatabaseId = await resolveD1DatabaseId(credentials, resourceDatabaseName, credentials.resourceDatabaseId);
  const downloadedClients = loadDownloadedClients();
  const clientIds = loadTargetClientIds(downloadedClients);
  const backup = existsSync(backupPath)
    ? JSON.parse(readFileSync(backupPath, 'utf8'))
    : await createBackup(credentials, analyticsDatabaseId, resourceDatabaseId, clientIds);
  const plan = existsSync(planPath)
    ? JSON.parse(readFileSync(planPath, 'utf8'))
    : createPlan(backup, await queryRepairInputs(credentials));
  if (!existsSync(planPath)) writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  console.log(`Prepared repair plan: clients=${plan.clientIds.length}, badEvents=${plan.badDaily.eventCount}`);
  console.log(`Filtered daily target: active=${plan.filteredDaily.activeClients}, open=${plan.filteredDaily.appOpenCount}, views=${plan.filteredDaily.pageViewCount}`);
  if (!applyChanges) {
    console.log(`Preparation completed. Run with --apply to update D1. Plan: ${planPath}`);
    return;
  }
  await applyPlan(credentials, analyticsDatabaseId, resourceDatabaseId, plan);
  const result = await writeResult(credentials, analyticsDatabaseId, plan, downloadedClients);
  console.log(`Repair completed: newClients=${result.daily.newClients}, removed=${result.removedClients}`);
  console.log(`Result: ${resultPath}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
