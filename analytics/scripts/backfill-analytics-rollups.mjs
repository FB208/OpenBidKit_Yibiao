import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_USAGE_FIELDS, DATASET } from '../worker/src/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../worker');

const D1_BINDING = 'ANALYTICS_DB';
const SOURCE_ROLLUP = 'rollup';
const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const MAX_D1_STATEMENTS_PER_FILE = 80;
const UNKNOWN_VERSION = '未知版本';

const allowedEvents = ['app_open', 'page_view', 'config_usage', 'ai_request', 'resource_click'];
const countColumnByEvent = {
  app_open: 'appOpenCount',
  page_view: 'pageViewCount',
  config_usage: 'configUsageCount',
  ai_request: 'aiRequestCount',
  resource_click: 'resourceClickCount',
};

function parseArgs(argv) {
  const args = {
    project: 'yibiao-client',
    start: '',
    end: '',
    remote: false,
    local: false,
    dryRun: false,
    allowCurrentDay: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--project') {
      args.project = String(next || '').trim();
      index += 1;
    } else if (item === '--start') {
      args.start = String(next || '').trim();
      index += 1;
    } else if (item === '--end') {
      args.end = String(next || '').trim();
      index += 1;
    } else if (item === '--remote') {
      args.remote = true;
    } else if (item === '--local') {
      args.local = true;
    } else if (item === '--dry-run') {
      args.dryRun = true;
    } else if (item === '--allow-current-day') {
      args.allowCurrentDay = true;
    } else if (item === '--help' || item === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node ../scripts/backfill-analytics-rollups.mjs --project yibiao-client --start 2026-03-15 --end 2026-06-12 --remote

Options:
  --project <name>        Project name, default yibiao-client
  --start <YYYY-MM-DD>    Business start date in Asia/Shanghai, default end - 89 days
  --end <YYYY-MM-DD>      Business end date in Asia/Shanghai, default yesterday
  --remote                Write to remote Cloudflare D1 through Wrangler
  --local                 Write to local Wrangler D1
  --dry-run               Print date coverage only, no API or D1 writes
  --allow-current-day     Allow deleting/rebuilding current business day rows
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isValidProjectName(value) {
  return /^[a-zA-Z0-9._-]{1,80}$/.test(value);
}

function isValidDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function businessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shanghaiStartUtc(dateText) {
  return new Date(`${dateText}T00:00:00+08:00`);
}

function clickHouseDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function quote(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlText(value, maxLength) {
  return quote(normalizeText(value, maxLength));
}

function intValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function clientHash(projectName, clientId) {
  return createHash('sha256').update(`${projectName}:${clientId}`).digest('hex');
}

function dimensionKey(type, label) {
  return `${type}_${createHash('sha256').update(`${type}:${label}`).digest('hex').slice(0, 24)}`;
}

function makeDateRange(options) {
  const today = businessDate(new Date());
  const end = options.end || addDays(today, -1);
  const start = options.start || addDays(end, -89);

  if (!isValidDateText(start) || !isValidDateText(end)) {
    throw new Error('start/end must use YYYY-MM-DD');
  }
  if (start > end) {
    throw new Error('start must be before or equal to end');
  }
  if (!options.allowCurrentDay && end >= today) {
    throw new Error(`Refusing to backfill current business day ${today}; use --allow-current-day only if you know live rows will not overlap.`);
  }

  return { start, end, today };
}

function listDates(range) {
  const dates = [];
  for (let date = range.start; date <= range.end; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function buildAnalyticsWhere(projectName, activityDate) {
  const startUtc = clickHouseDateTime(shanghaiStartUtc(activityDate));
  const endUtc = clickHouseDateTime(shanghaiStartUtc(addDays(activityDate, 1)));
  return `blob1 = ${quote(projectName)}
    AND timestamp >= toDateTime(${quote(startUtc)}, 'UTC')
    AND timestamp < toDateTime(${quote(endUtc)}, 'UTC')`;
}

async function queryAnalytics(env, sql, label) {
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/analytics_engine/sql`;
  const response = await fetch(api, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.analyticsToken}`,
    },
    body: sql,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} query failed: ${body}`);
  }

  const data = await response.json();
  const rows = data.data || [];
  console.log(`${label}: ${rows.length} rows`);
  return rows;
}

function runWranglerD1(sqlStatements, label, options) {
  if (!sqlStatements.length) {
    console.log(`${label}: no D1 statements.`);
    return;
  }
  if (options.dryRun) {
    console.log(`${label}: dry-run, ${sqlStatements.length} D1 statements skipped.`);
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'analytics-backfill-'));
  try {
    for (let index = 0; index < sqlStatements.length; index += MAX_D1_STATEMENTS_PER_FILE) {
      const chunk = sqlStatements.slice(index, index + MAX_D1_STATEMENTS_PER_FILE);
      const filePath = join(tempDir, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index}.sql`);
      writeFileSync(filePath, `BEGIN TRANSACTION;\n${chunk.join('\n')}\nCOMMIT;\n`, 'utf8');
      const args = ['wrangler', 'd1', 'execute', D1_BINDING, options.remote ? '--remote' : '--local', '--file', filePath];
      const result = spawnSync('npx', args, {
        cwd: workerDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (result.status !== 0) {
        throw new Error(`${label} D1 execute failed:\n${result.stdout || ''}\n${result.stderr || ''}`.trim());
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`${label}: wrote ${sqlStatements.length} D1 statements.`);
}

async function fetchDailyPayload(env, projectName, activityDate) {
  const where = buildAnalyticsWhere(projectName, activityDate);
  const eventList = allowedEvents.map(quote).join(', ');
  const versionExpr = `if(blob4 = '', ${quote(UNKNOWN_VERSION)}, blob4)`;

  const eventRows = await queryAnalytics(env, `
    SELECT blob2 AS event,
      SUM(_sample_interval) AS eventCount,
      SUM(double2 * _sample_interval) AS promptTokens,
      SUM(double3 * _sample_interval) AS completionTokens,
      SUM(double4 * _sample_interval) AS totalTokens
    FROM ${DATASET}
    WHERE ${where} AND blob2 IN (${eventList})
    GROUP BY event
  `, `${activityDate} events`);

  const eventClientRows = await queryAnalytics(env, `
    SELECT blob2 AS event, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 IN (${eventList}) AND blob7 != ''
    GROUP BY event
  `, `${activityDate} event clients`);

  const activeRows = await queryAnalytics(env, `
    SELECT COUNT(DISTINCT blob7) AS activeClients, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
  `, `${activityDate} active clients`);

  const newRows = await queryAnalytics(env, `
    SELECT COUNT(DISTINCT blob7) AS newClients
    FROM ${DATASET}
    WHERE ${where} AND blob7 != '' AND blob8 = ${quote(activityDate)}
  `, `${activityDate} new clients`);

  const pageRows = await queryAnalytics(env, `
    SELECT blob3 AS page, SUM(_sample_interval) AS viewCount, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'page_view' AND blob3 != ''
    GROUP BY page
  `, `${activityDate} pages`);

  const versionEventRows = await queryAnalytics(env, `
    SELECT ${versionExpr} AS version, blob2 AS event, SUM(_sample_interval) AS eventCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 IN (${eventList}) AND blob7 != ''
    GROUP BY version, event
  `, `${activityDate} version events`);

  const versionClientRows = await queryAnalytics(env, `
    SELECT ${versionExpr} AS version, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'app_open' AND blob7 != ''
    GROUP BY version
  `, `${activityDate} version clients`);

  const configRows = [];
  for (const field of CONFIG_USAGE_FIELDS) {
    const rows = await queryAnalytics(env, `
      SELECT ${quote(field.key)} AS fieldKey, ${field.blob} AS value,
        SUM(_sample_interval) AS reportCount,
        COUNT(DISTINCT blob7) AS clientCount
      FROM ${DATASET}
      WHERE ${where} AND blob2 = 'config_usage' AND ${field.blob} != ''
      GROUP BY value
    `, `${activityDate} config ${field.key}`);
    configRows.push(...rows);
  }

  const modelRows = await queryAnalytics(env, `
    SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model,
      SUM(_sample_interval) AS requestCount,
      SUM(double2 * _sample_interval) AS promptTokens,
      SUM(double3 * _sample_interval) AS completionTokens,
      SUM(double4 * _sample_interval) AS totalTokens,
      COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'ai_request' AND blob12 != '' AND blob11 != ''
    GROUP BY requestType, provider, endpointHost, model
  `, `${activityDate} models`);

  const resourceRows = await queryAnalytics(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'resource_click' AND blob9 != ''
    GROUP BY resourceKey
  `, `${activityDate} resources`);

  const clientRows = await queryAnalytics(env, `
    SELECT blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt,
      MAX(blob8) AS clientCreatedAt, MAX(${versionExpr}) AS version, MAX(blob5) AS platform, MAX(blob6) AS arch
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
    GROUP BY clientId
  `, `${activityDate} client index`);

  const dimensionRows = await fetchDimensionRows(env, where, versionExpr, activityDate);

  return {
    eventRows,
    eventClientRows,
    active: activeRows[0] || {},
    newClients: intValue(newRows[0]?.newClients),
    pageRows,
    versionEventRows,
    versionClientRows,
    configRows,
    modelRows,
    resourceRows,
    clientRows,
    dimensionRows,
  };
}

async function fetchDimensionRows(env, where, versionExpr, activityDate) {
  const rows = [];
  const append = (type, labelBuilder, resultRows) => {
    for (const row of resultRows) {
      const label = normalizeText(labelBuilder(row), 240);
      const clientId = normalizeText(row.clientId, 120);
      if (!label || !clientId) continue;
      rows.push({
        type,
        label,
        clientId,
        firstSeenAt: normalizeIso(row.firstSeenAt),
        lastSeenAt: normalizeIso(row.lastSeenAt),
        hitCount: intValue(row.hitCount) || 1,
      });
    }
  };

  append('event', (row) => row.label, await queryAnalytics(env, `
    SELECT blob2 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob7 != '' AND blob2 != ''
    GROUP BY label, clientId
  `, `${activityDate} dimension event`));

  append('version', (row) => row.label, await queryAnalytics(env, `
    SELECT ${versionExpr} AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
    GROUP BY label, clientId
  `, `${activityDate} dimension version`));

  append('page', (row) => row.label, await queryAnalytics(env, `
    SELECT blob3 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'page_view' AND blob7 != '' AND blob3 != ''
    GROUP BY label, clientId
  `, `${activityDate} dimension page`));

  append('resource', (row) => row.label, await queryAnalytics(env, `
    SELECT blob9 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'resource_click' AND blob7 != '' AND blob9 != ''
    GROUP BY label, clientId
  `, `${activityDate} dimension resource`));

  append('model', (row) => `${row.requestType}|${row.provider || ''}|${row.endpointHost || ''}|${row.model}`, await queryAnalytics(env, `
    SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model, blob7 AS clientId,
      MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'ai_request' AND blob7 != '' AND blob12 != '' AND blob11 != ''
    GROUP BY requestType, provider, endpointHost, model, clientId
  `, `${activityDate} dimension model`));

  for (const field of CONFIG_USAGE_FIELDS) {
    append('config', (row) => `${field.key}=${row.value}`, await queryAnalytics(env, `
      SELECT ${field.blob} AS value, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
      FROM ${DATASET}
      WHERE ${where} AND blob2 = 'config_usage' AND blob7 != '' AND ${field.blob} != ''
      GROUP BY value, clientId
    `, `${activityDate} dimension config ${field.key}`));
  }

  return rows;
}

function buildSummary(payload) {
  const summary = {
    eventCount: 0,
    appOpenCount: 0,
    pageViewCount: 0,
    configUsageCount: 0,
    aiRequestCount: 0,
    resourceClickCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    activeClients: intValue(payload.active.activeClients),
    newClients: payload.newClients,
    firstSeenAt: normalizeIso(payload.active.firstSeenAt),
    lastSeenAt: normalizeIso(payload.active.lastSeenAt),
  };

  for (const row of payload.eventRows) {
    const count = intValue(row.eventCount);
    summary.eventCount += count;
    const column = countColumnByEvent[row.event];
    if (column) summary[column] += count;
    summary.promptTokens += intValue(row.promptTokens);
    summary.completionTokens += intValue(row.completionTokens);
    summary.totalTokens += intValue(row.totalTokens);
  }

  return summary;
}

function buildVersionRows(payload) {
  const versions = new Map();
  for (const row of payload.versionClientRows) {
    const version = normalizeText(row.version || UNKNOWN_VERSION, 50) || UNKNOWN_VERSION;
    versions.set(version, {
      version,
      eventCount: 0,
      appOpenCount: 0,
      pageViewCount: 0,
      configUsageCount: 0,
      aiRequestCount: 0,
      resourceClickCount: 0,
      clientCount: intValue(row.clientCount),
    });
  }
  for (const row of payload.versionEventRows) {
    const version = normalizeText(row.version || UNKNOWN_VERSION, 50) || UNKNOWN_VERSION;
    const item = versions.get(version) || {
      version,
      eventCount: 0,
      appOpenCount: 0,
      pageViewCount: 0,
      configUsageCount: 0,
      aiRequestCount: 0,
      resourceClickCount: 0,
      clientCount: 0,
    };
    const count = intValue(row.eventCount);
    item.eventCount += count;
    const column = countColumnByEvent[row.event];
    if (column) item[column] += count;
    versions.set(version, item);
  }
  return Array.from(versions.values());
}

function buildDailyStatements(projectName, activityDate, payload) {
  const rolledUpAt = new Date().toISOString();
  const summary = buildSummary(payload);
  const versionRows = buildVersionRows(payload);
  const project = quote(projectName);
  const date = quote(activityDate);
  const source = quote(SOURCE_ROLLUP);
  const statements = [
    'analytics_daily_summary',
    'analytics_daily_page_stats',
    'analytics_daily_version_stats',
    'analytics_daily_config_stats',
    'analytics_daily_model_stats',
    'analytics_daily_resource_stats',
    'analytics_daily_event_client_stats',
  ].map((table) => `DELETE FROM ${table} WHERE project_name = ${project} AND activity_date = ${date} AND source = ${source};`);

  statements.push(`INSERT INTO analytics_daily_summary (
    project_name, activity_date, source, event_count, app_open_count, page_view_count, config_usage_count,
    ai_request_count, resource_click_count, active_clients, new_clients, prompt_tokens, completion_tokens,
    total_tokens, first_seen_at, last_seen_at, rolled_up_at
  ) VALUES (${project}, ${date}, ${source}, ${summary.eventCount}, ${summary.appOpenCount}, ${summary.pageViewCount}, ${summary.configUsageCount},
    ${summary.aiRequestCount}, ${summary.resourceClickCount}, ${summary.activeClients}, ${summary.newClients}, ${summary.promptTokens}, ${summary.completionTokens},
    ${summary.totalTokens}, ${quote(summary.firstSeenAt)}, ${quote(summary.lastSeenAt)}, ${quote(rolledUpAt)});`);

  for (const row of payload.pageRows) {
    statements.push(`INSERT INTO analytics_daily_page_stats (project_name, activity_date, source, page, view_count, client_count)
      VALUES (${project}, ${date}, ${source}, ${sqlText(row.page, 120)}, ${intValue(row.viewCount)}, ${intValue(row.clientCount)});`);
  }

  for (const row of versionRows) {
    statements.push(`INSERT INTO analytics_daily_version_stats (
      project_name, activity_date, source, version, event_count, app_open_count, page_view_count,
      config_usage_count, ai_request_count, resource_click_count, client_count
    ) VALUES (${project}, ${date}, ${source}, ${sqlText(row.version, 50)}, ${row.eventCount}, ${row.appOpenCount}, ${row.pageViewCount},
      ${row.configUsageCount}, ${row.aiRequestCount}, ${row.resourceClickCount}, ${row.clientCount});`);
  }

  for (const row of payload.configRows) {
    statements.push(`INSERT INTO analytics_daily_config_stats (project_name, activity_date, source, field_key, value, report_count, client_count)
      VALUES (${project}, ${date}, ${source}, ${sqlText(row.fieldKey, 80)}, ${sqlText(row.value, 120)}, ${intValue(row.reportCount)}, ${intValue(row.clientCount)});`);
  }

  for (const row of payload.modelRows) {
    statements.push(`INSERT INTO analytics_daily_model_stats (
      project_name, activity_date, source, request_type, provider, endpoint_host, model,
      request_count, prompt_tokens, completion_tokens, total_tokens, client_count
    ) VALUES (${project}, ${date}, ${source}, ${sqlText(row.requestType, 20)}, ${sqlText(row.provider, 80)}, ${sqlText(row.endpointHost, 120)}, ${sqlText(row.model, 160)},
      ${intValue(row.requestCount)}, ${intValue(row.promptTokens)}, ${intValue(row.completionTokens)}, ${intValue(row.totalTokens)}, ${intValue(row.clientCount)});`);
  }

  for (const row of payload.resourceRows) {
    statements.push(`INSERT INTO analytics_daily_resource_stats (project_name, activity_date, source, resource_key, click_count, client_count)
      VALUES (${project}, ${date}, ${source}, ${sqlText(row.resourceKey, 80)}, ${intValue(row.clickCount)}, ${intValue(row.clientCount)});`);
  }

  for (const row of payload.eventClientRows) {
    statements.push(`INSERT INTO analytics_daily_event_client_stats (project_name, activity_date, source, event, client_count)
      VALUES (${project}, ${date}, ${source}, ${sqlText(row.event, 50)}, ${intValue(row.clientCount)});`);
  }

  appendClientStatements(statements, projectName, activityDate, payload.clientRows);
  appendDimensionStatements(statements, projectName, activityDate, payload.dimensionRows, rolledUpAt);

  statements.push(`INSERT INTO analytics_meta (key, value, updated_at) VALUES (${quote(`daily_rollup:${projectName}:${activityDate}`)}, ${quote('backfill')}, ${quote(rolledUpAt)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`);

  return statements;
}

function appendClientStatements(statements, projectName, activityDate, clientRows) {
  for (const row of clientRows) {
    const firstSeenAt = normalizeIso(row.firstSeenAt);
    const lastSeenAt = normalizeIso(row.lastSeenAt);
    const reportedClientCreatedDate = isValidDateText(String(row.clientCreatedAt || '').slice(0, 10)) ? String(row.clientCreatedAt).slice(0, 10) : null;
    const clientCreatedDate = reportedClientCreatedDate || activityDate;
    const clientCreatedSource = reportedClientCreatedDate ? 'reported' : 'first_seen';
    const version = normalizeText(row.version || UNKNOWN_VERSION, 50) || UNKNOWN_VERSION;

    statements.push(`INSERT INTO analytics_client_index (
      project_name, client_hash, reported_client_created_date, client_created_date, client_created_source,
      first_seen_at, first_seen_date, last_seen_at, last_seen_date, first_version, last_version, platform, arch
    ) VALUES (${quote(projectName)}, ${quote(clientHash(projectName, row.clientId))}, ${quote(reportedClientCreatedDate)}, ${quote(clientCreatedDate)}, ${quote(clientCreatedSource)},
      ${quote(firstSeenAt)}, ${quote(activityDate)}, ${quote(lastSeenAt)}, ${quote(activityDate)}, ${quote(version)}, ${quote(version)}, ${sqlText(row.platform, 50)}, ${sqlText(row.arch, 50)})
    ON CONFLICT(project_name, client_hash) DO UPDATE SET
      reported_client_created_date = COALESCE(excluded.reported_client_created_date, analytics_client_index.reported_client_created_date),
      client_created_date = CASE WHEN excluded.client_created_date < analytics_client_index.client_created_date THEN excluded.client_created_date ELSE analytics_client_index.client_created_date END,
      client_created_source = CASE WHEN excluded.client_created_date < analytics_client_index.client_created_date THEN excluded.client_created_source ELSE analytics_client_index.client_created_source END,
      first_seen_at = CASE WHEN excluded.first_seen_at < analytics_client_index.first_seen_at THEN excluded.first_seen_at ELSE analytics_client_index.first_seen_at END,
      first_seen_date = CASE WHEN excluded.first_seen_date < analytics_client_index.first_seen_date THEN excluded.first_seen_date ELSE analytics_client_index.first_seen_date END,
      last_seen_at = CASE WHEN excluded.last_seen_at > analytics_client_index.last_seen_at THEN excluded.last_seen_at ELSE analytics_client_index.last_seen_at END,
      last_seen_date = CASE WHEN excluded.last_seen_date > analytics_client_index.last_seen_date THEN excluded.last_seen_date ELSE analytics_client_index.last_seen_date END,
      first_version = CASE WHEN analytics_client_index.first_version = '' THEN excluded.first_version ELSE analytics_client_index.first_version END,
      last_version = CASE WHEN excluded.last_seen_at >= analytics_client_index.last_seen_at THEN excluded.last_version ELSE analytics_client_index.last_version END,
      platform = CASE WHEN excluded.last_seen_at >= analytics_client_index.last_seen_at THEN excluded.platform ELSE analytics_client_index.platform END,
      arch = CASE WHEN excluded.last_seen_at >= analytics_client_index.last_seen_at THEN excluded.arch ELSE analytics_client_index.arch END;`);
  }
}

function appendDimensionStatements(statements, projectName, activityDate, dimensionRows, rolledUpAt) {
  const values = new Map();
  for (const row of dimensionRows) {
    const dimensionType = normalizeText(row.type, 50);
    const label = normalizeText(row.label, 240);
    if (!dimensionType || !label) continue;
    const key = dimensionKey(dimensionType, label);
    const hash = clientHash(projectName, row.clientId);
    values.set(`${dimensionType}\u0001${key}`, { dimensionType, key, label });

    statements.push(`INSERT INTO analytics_dimension_client_index (
      project_name, dimension_type, dimension_key, client_hash, first_seen_at, first_seen_date, last_seen_at, last_seen_date, hit_count
    ) VALUES (${quote(projectName)}, ${quote(dimensionType)}, ${quote(key)}, ${quote(hash)}, ${quote(row.firstSeenAt)}, ${quote(activityDate)}, ${quote(row.lastSeenAt)}, ${quote(activityDate)}, ${intValue(row.hitCount)})
    ON CONFLICT(project_name, dimension_type, dimension_key, client_hash) DO UPDATE SET
      first_seen_at = CASE WHEN excluded.first_seen_at < analytics_dimension_client_index.first_seen_at THEN excluded.first_seen_at ELSE analytics_dimension_client_index.first_seen_at END,
      first_seen_date = CASE WHEN excluded.first_seen_date < analytics_dimension_client_index.first_seen_date THEN excluded.first_seen_date ELSE analytics_dimension_client_index.first_seen_date END,
      last_seen_at = CASE WHEN excluded.last_seen_at > analytics_dimension_client_index.last_seen_at THEN excluded.last_seen_at ELSE analytics_dimension_client_index.last_seen_at END,
      last_seen_date = CASE WHEN excluded.last_seen_date > analytics_dimension_client_index.last_seen_date THEN excluded.last_seen_date ELSE analytics_dimension_client_index.last_seen_date END,
      hit_count = MAX(analytics_dimension_client_index.hit_count, excluded.hit_count);`);
  }

  for (const item of values.values()) {
    statements.push(`INSERT INTO analytics_dimension_values (project_name, dimension_type, dimension_key, label, updated_at)
      VALUES (${quote(projectName)}, ${quote(item.dimensionType)}, ${quote(item.key)}, ${quote(item.label)}, ${quote(rolledUpAt)})
      ON CONFLICT(project_name, dimension_type, dimension_key) DO UPDATE SET
        label = excluded.label,
        updated_at = excluded.updated_at;`);
  }
}

function validateOptions(options) {
  if (!isValidProjectName(options.project)) {
    fail('Invalid project name. Use 1-80 chars: a-z A-Z 0-9 . _ -');
  }
  if (options.remote && options.local) {
    fail('Use only one of --remote or --local.');
  }
  if (!options.remote && !options.local && !options.dryRun) {
    fail('Use --remote, --local, or --dry-run.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);
  const range = makeDateRange(options);
  const dates = listDates(range);

  console.log(`Analytics daily rollup backfill: project=${options.project}, start=${range.start}, end=${range.end}, dates=${dates.length}, source=${SOURCE_ROLLUP}`);

  if (options.dryRun) {
    console.log(`Dry-run only. First date: ${dates[0]}, last date: ${dates.at(-1)}.`);
    return;
  }

  const env = {
    accountId: process.env.ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    analyticsToken: process.env.ANALYTICS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
  };

  if (!env.accountId) {
    fail('Missing ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID.');
  }
  if (!env.analyticsToken) {
    fail('Missing ANALYTICS_API_TOKEN or CLOUDFLARE_API_TOKEN.');
  }

  for (const activityDate of dates) {
    const payload = await fetchDailyPayload(env, options.project, activityDate);
    const statements = buildDailyStatements(options.project, activityDate, payload);
    runWranglerD1(statements, `analytics-daily-${activityDate}`, options);
  }

  console.log(`Analytics daily rollup backfill completed: ${dates.length} days.`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
