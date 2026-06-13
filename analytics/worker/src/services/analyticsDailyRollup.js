import { CONFIG_USAGE_FIELDS, DATASET } from '../constants.js';
import { queryAnalytics } from './analyticsQuery.js';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const SOURCE_ROLLUP = 'rollup';
const UNKNOWN_VERSION = '未知版本';
const MAX_D1_BATCH_STATEMENTS = 80;

const allowedEvents = ['app_open', 'page_view', 'config_usage', 'ai_request', 'resource_click'];
const countColumnByEvent = {
  app_open: 'appOpenCount',
  page_view: 'pageViewCount',
  config_usage: 'configUsageCount',
  ai_request: 'aiRequestCount',
  resource_click: 'resourceClickCount',
};

function requireAnalyticsDb(env) {
  if (!env.ANALYTICS_DB) {
    throw new Error('ANALYTICS_DB is not configured');
  }
  return env.ANALYTICS_DB;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isValidDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function datePartsInBusinessZone(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

export function businessDate(date = new Date()) {
  const parts = datePartsInBusinessZone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addBusinessDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getBusinessToday() {
  return businessDate(new Date());
}

export function getBusinessDateDaysAgo(days) {
  const today = getBusinessToday();
  return addBusinessDays(today, -days);
}

function shanghaiStartUtc(dateText) {
  return new Date(`${dateText}T00:00:00+08:00`);
}

function clickHouseDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildAnalyticsWhere(projectName, activityDate) {
  const startUtc = clickHouseDateTime(shanghaiStartUtc(activityDate));
  const endUtc = clickHouseDateTime(shanghaiStartUtc(addBusinessDays(activityDate, 1)));
  return `blob1 = ${quote(projectName)}
    AND timestamp >= toDateTime(${quote(startUtc)}, 'UTC')
    AND timestamp < toDateTime(${quote(endUtc)}, 'UTC')`;
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function clientHash(projectName, clientId) {
  return sha256Hex(`${projectName}:${clientId}`);
}

async function dimensionKey(type, label) {
  return `${type}_${(await sha256Hex(`${type}:${label}`)).slice(0, 24)}`;
}

async function analyticsRows(env, sql, scope) {
  const result = await queryAnalytics(env, sql);
  const rows = result.data || [];
  console.log(`[analytics] daily rollup ${scope}: ${rows.length} rows`);
  return rows;
}

function addStatement(statements, db, sql, bindings = []) {
  statements.push(db.prepare(sql).bind(...bindings));
}

async function commitStatements(db, statements) {
  for (let index = 0; index < statements.length; index += MAX_D1_BATCH_STATEMENTS) {
    await db.batch(statements.slice(index, index + MAX_D1_BATCH_STATEMENTS));
  }
}

async function fetchProjectNames(env, activityDate) {
  const startUtc = clickHouseDateTime(shanghaiStartUtc(activityDate));
  const endUtc = clickHouseDateTime(shanghaiStartUtc(addBusinessDays(activityDate, 1)));
  const rows = await analyticsRows(env, `
    SELECT blob1 AS projectName
    FROM ${DATASET}
    WHERE blob1 != ''
      AND timestamp >= toDateTime(${quote(startUtc)}, 'UTC')
      AND timestamp < toDateTime(${quote(endUtc)}, 'UTC')
    GROUP BY projectName
    ORDER BY projectName ASC
  `, 'projects');
  return rows.map((row) => normalizeText(row.projectName, 80)).filter(Boolean);
}

async function fetchDailyPayload(env, projectName, activityDate) {
  const where = buildAnalyticsWhere(projectName, activityDate);
  const eventList = allowedEvents.map(quote).join(', ');
  const versionExpr = `if(blob4 = '', ${quote(UNKNOWN_VERSION)}, blob4)`;

  const eventRows = await analyticsRows(env, `
    SELECT blob2 AS event,
      SUM(_sample_interval) AS eventCount,
      SUM(double2 * _sample_interval) AS promptTokens,
      SUM(double3 * _sample_interval) AS completionTokens,
      SUM(double4 * _sample_interval) AS totalTokens
    FROM ${DATASET}
    WHERE ${where} AND blob2 IN (${eventList})
    GROUP BY event
  `, 'events');

  const activeRows = await analyticsRows(env, `
    SELECT COUNT(DISTINCT blob7) AS activeClients, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
  `, 'active clients');

  const newRows = await analyticsRows(env, `
    SELECT COUNT(DISTINCT blob7) AS newClients
    FROM ${DATASET}
    WHERE ${where} AND blob7 != '' AND blob8 = ${quote(activityDate)}
  `, 'new clients');

  const pageRows = await analyticsRows(env, `
    SELECT blob3 AS page, SUM(_sample_interval) AS viewCount, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'page_view' AND blob3 != ''
    GROUP BY page
  `, 'pages');

  const versionEventRows = await analyticsRows(env, `
    SELECT ${versionExpr} AS version, blob2 AS event, SUM(_sample_interval) AS eventCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 IN (${eventList}) AND blob7 != ''
    GROUP BY version, event
  `, 'version events');

  const versionClientRows = await analyticsRows(env, `
    SELECT ${versionExpr} AS version, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
    GROUP BY version
  `, 'version clients');

  const configRows = [];
  for (const field of CONFIG_USAGE_FIELDS) {
    const rows = await analyticsRows(env, `
      SELECT ${quote(field.key)} AS fieldKey, ${field.blob} AS value,
        SUM(_sample_interval) AS reportCount,
        COUNT(DISTINCT blob7) AS clientCount
      FROM ${DATASET}
      WHERE ${where} AND blob2 = 'config_usage' AND ${field.blob} != ''
      GROUP BY value
    `, `config ${field.key}`);
    configRows.push(...rows);
  }

  const modelRows = await analyticsRows(env, `
    SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model,
      SUM(_sample_interval) AS requestCount,
      SUM(double2 * _sample_interval) AS promptTokens,
      SUM(double3 * _sample_interval) AS completionTokens,
      SUM(double4 * _sample_interval) AS totalTokens,
      COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'ai_request' AND blob12 != '' AND blob11 != ''
    GROUP BY requestType, provider, endpointHost, model
  `, 'models');

  const resourceRows = await analyticsRows(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount, COUNT(DISTINCT blob7) AS clientCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'resource_click' AND blob9 != ''
    GROUP BY resourceKey
  `, 'resources');

  const clientRows = await analyticsRows(env, `
    SELECT blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt,
      MAX(blob8) AS clientCreatedAt, MAX(${versionExpr}) AS version, MAX(blob5) AS platform, MAX(blob6) AS arch
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
    GROUP BY clientId
  `, 'client index');

  const dimensionRows = await fetchDimensionRows(env, where, versionExpr);

  return {
    eventRows,
    active: activeRows[0] || {},
    newClients: number(newRows[0]?.newClients),
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

async function fetchDimensionRows(env, where, versionExpr) {
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
        hitCount: number(row.hitCount) || 1,
      });
    }
  };

  append('event', (row) => row.label, await analyticsRows(env, `
    SELECT blob2 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob7 != '' AND blob2 != ''
    GROUP BY label, clientId
  `, 'dimension event'));

  append('version', (row) => row.label, await analyticsRows(env, `
    SELECT ${versionExpr} AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob7 != ''
    GROUP BY label, clientId
  `, 'dimension version'));

  append('page', (row) => row.label, await analyticsRows(env, `
    SELECT blob3 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'page_view' AND blob7 != '' AND blob3 != ''
    GROUP BY label, clientId
  `, 'dimension page'));

  append('resource', (row) => row.label, await analyticsRows(env, `
    SELECT blob9 AS label, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'resource_click' AND blob7 != '' AND blob9 != ''
    GROUP BY label, clientId
  `, 'dimension resource'));

  append('model', (row) => `${row.requestType}|${row.provider || ''}|${row.endpointHost || ''}|${row.model}`, await analyticsRows(env, `
    SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model, blob7 AS clientId,
      MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
    FROM ${DATASET}
    WHERE ${where} AND blob2 = 'ai_request' AND blob7 != '' AND blob12 != '' AND blob11 != ''
    GROUP BY requestType, provider, endpointHost, model, clientId
  `, 'dimension model'));

  for (const field of CONFIG_USAGE_FIELDS) {
    append('config', (row) => `${field.key}=${row.value}`, await analyticsRows(env, `
      SELECT ${field.blob} AS value, blob7 AS clientId, MIN(timestamp) AS firstSeenAt, MAX(timestamp) AS lastSeenAt, SUM(_sample_interval) AS hitCount
      FROM ${DATASET}
      WHERE ${where} AND blob2 = 'config_usage' AND blob7 != '' AND ${field.blob} != ''
      GROUP BY value, clientId
    `, `dimension config ${field.key}`));
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
    activeClients: number(payload.active.activeClients),
    newClients: payload.newClients,
    firstSeenAt: normalizeIso(payload.active.firstSeenAt),
    lastSeenAt: normalizeIso(payload.active.lastSeenAt),
  };

  for (const row of payload.eventRows) {
    const count = number(row.eventCount);
    summary.eventCount += count;
    const column = countColumnByEvent[row.event];
    if (column) summary[column] += count;
    summary.promptTokens += number(row.promptTokens);
    summary.completionTokens += number(row.completionTokens);
    summary.totalTokens += number(row.totalTokens);
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
      clientCount: number(row.clientCount),
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
    const count = number(row.eventCount);
    item.eventCount += count;
    const column = countColumnByEvent[row.event];
    if (column) item[column] += count;
    versions.set(version, item);
  }
  return Array.from(versions.values());
}

async function appendClientStatements(statements, db, projectName, activityDate, clientRows) {
  for (const row of clientRows) {
    const hash = await clientHash(projectName, row.clientId);
    const firstSeenAt = normalizeIso(row.firstSeenAt);
    const lastSeenAt = normalizeIso(row.lastSeenAt);
    const reportedClientCreatedDate = isValidDateText(String(row.clientCreatedAt || '').slice(0, 10)) ? String(row.clientCreatedAt).slice(0, 10) : null;
    const clientCreatedDate = reportedClientCreatedDate || activityDate;
    const clientCreatedSource = reportedClientCreatedDate ? 'reported' : 'first_seen';
    const version = normalizeText(row.version || UNKNOWN_VERSION, 50) || UNKNOWN_VERSION;

    addStatement(statements, db, `
      INSERT INTO analytics_client_index (
        project_name, client_hash, reported_client_created_date, client_created_date, client_created_source,
        first_seen_at, first_seen_date, last_seen_at, last_seen_date, first_version, last_version, platform, arch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        arch = CASE WHEN excluded.last_seen_at >= analytics_client_index.last_seen_at THEN excluded.arch ELSE analytics_client_index.arch END`, [
      projectName,
      hash,
      reportedClientCreatedDate,
      clientCreatedDate,
      clientCreatedSource,
      firstSeenAt,
      activityDate,
      lastSeenAt,
      activityDate,
      version,
      version,
      normalizeText(row.platform, 50),
      normalizeText(row.arch, 50),
    ]);
  }
}

async function appendDimensionStatements(statements, db, projectName, activityDate, dimensionRows, rolledUpAt) {
  const values = new Map();
  for (const row of dimensionRows) {
    const dimensionType = normalizeText(row.type, 50);
    const label = normalizeText(row.label, 240);
    if (!dimensionType || !label) continue;
    const key = await dimensionKey(dimensionType, label);
    const hash = await clientHash(projectName, row.clientId);
    values.set(`${dimensionType}\u0001${key}`, { dimensionType, key, label });
    addStatement(statements, db, `
      INSERT INTO analytics_dimension_client_index (
        project_name, dimension_type, dimension_key, client_hash, first_seen_at, first_seen_date, last_seen_at, last_seen_date, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, dimension_type, dimension_key, client_hash) DO UPDATE SET
        first_seen_at = CASE WHEN excluded.first_seen_at < analytics_dimension_client_index.first_seen_at THEN excluded.first_seen_at ELSE analytics_dimension_client_index.first_seen_at END,
        first_seen_date = CASE WHEN excluded.first_seen_date < analytics_dimension_client_index.first_seen_date THEN excluded.first_seen_date ELSE analytics_dimension_client_index.first_seen_date END,
        last_seen_at = CASE WHEN excluded.last_seen_at > analytics_dimension_client_index.last_seen_at THEN excluded.last_seen_at ELSE analytics_dimension_client_index.last_seen_at END,
        last_seen_date = CASE WHEN excluded.last_seen_date > analytics_dimension_client_index.last_seen_date THEN excluded.last_seen_date ELSE analytics_dimension_client_index.last_seen_date END,
        hit_count = MAX(analytics_dimension_client_index.hit_count, excluded.hit_count)`, [
      projectName,
      dimensionType,
      key,
      hash,
      row.firstSeenAt,
      activityDate,
      row.lastSeenAt,
      activityDate,
      number(row.hitCount),
    ]);
  }

  for (const item of values.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_dimension_values (project_name, dimension_type, dimension_key, label, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_name, dimension_type, dimension_key) DO UPDATE SET
        label = excluded.label,
        updated_at = excluded.updated_at`, [projectName, item.dimensionType, item.key, item.label, rolledUpAt]);
  }
}

async function writeDailyPayload(env, projectName, activityDate, payload, options = {}) {
  const db = requireAnalyticsDb(env);
  const rolledUpAt = new Date().toISOString();
  const summary = buildSummary(payload);
  const versionRows = buildVersionRows(payload);
  const statements = [];

  for (const table of [
    'analytics_daily_summary',
    'analytics_daily_page_stats',
    'analytics_daily_version_stats',
    'analytics_daily_config_stats',
    'analytics_daily_model_stats',
    'analytics_daily_resource_stats',
  ]) {
    addStatement(statements, db, `DELETE FROM ${table} WHERE project_name = ? AND activity_date = ? AND source = ?`, [projectName, activityDate, SOURCE_ROLLUP]);
  }

  addStatement(statements, db, `
    INSERT INTO analytics_daily_summary (
      project_name, activity_date, source, event_count, app_open_count, page_view_count, config_usage_count,
      ai_request_count, resource_click_count, active_clients, new_clients, prompt_tokens, completion_tokens,
      total_tokens, first_seen_at, last_seen_at, rolled_up_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    projectName,
    activityDate,
    SOURCE_ROLLUP,
    summary.eventCount,
    summary.appOpenCount,
    summary.pageViewCount,
    summary.configUsageCount,
    summary.aiRequestCount,
    summary.resourceClickCount,
    summary.activeClients,
    summary.newClients,
    summary.promptTokens,
    summary.completionTokens,
    summary.totalTokens,
    summary.firstSeenAt,
    summary.lastSeenAt,
    rolledUpAt,
  ]);

  for (const row of payload.pageRows) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_page_stats (project_name, activity_date, source, page, view_count, client_count)
      VALUES (?, ?, ?, ?, ?, ?)`, [projectName, activityDate, SOURCE_ROLLUP, normalizeText(row.page, 120), number(row.viewCount), number(row.clientCount)]);
  }

  for (const row of versionRows) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_version_stats (
        project_name, activity_date, source, version, event_count, app_open_count, page_view_count,
        config_usage_count, ai_request_count, resource_click_count, client_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      projectName,
      activityDate,
      SOURCE_ROLLUP,
      row.version,
      row.eventCount,
      row.appOpenCount,
      row.pageViewCount,
      row.configUsageCount,
      row.aiRequestCount,
      row.resourceClickCount,
      row.clientCount,
    ]);
  }

  for (const row of payload.configRows) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_config_stats (project_name, activity_date, source, field_key, value, report_count, client_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [projectName, activityDate, SOURCE_ROLLUP, row.fieldKey, normalizeText(row.value, 120), number(row.reportCount), number(row.clientCount)]);
  }

  for (const row of payload.modelRows) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_model_stats (
        project_name, activity_date, source, request_type, provider, endpoint_host, model,
        request_count, prompt_tokens, completion_tokens, total_tokens, client_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      projectName,
      activityDate,
      SOURCE_ROLLUP,
      normalizeText(row.requestType, 20),
      normalizeText(row.provider, 80),
      normalizeText(row.endpointHost, 120),
      normalizeText(row.model, 160),
      number(row.requestCount),
      number(row.promptTokens),
      number(row.completionTokens),
      number(row.totalTokens),
      number(row.clientCount),
    ]);
  }

  for (const row of payload.resourceRows) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_resource_stats (project_name, activity_date, source, resource_key, click_count, client_count)
      VALUES (?, ?, ?, ?, ?, ?)`, [projectName, activityDate, SOURCE_ROLLUP, normalizeText(row.resourceKey, 80), number(row.clickCount), number(row.clientCount)]);
  }

  await appendClientStatements(statements, db, projectName, activityDate, payload.clientRows);
  await appendDimensionStatements(statements, db, projectName, activityDate, payload.dimensionRows, rolledUpAt);

  addStatement(statements, db, `
    INSERT INTO analytics_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [`daily_rollup:${projectName}:${activityDate}`, options.reason || 'manual', rolledUpAt]);

  await commitStatements(db, statements);
  console.log(`[analytics] daily rollup completed: project=${projectName}, date=${activityDate}, statements=${statements.length}`);
}

export async function rollupAnalyticsDay(env, { projectName, activityDate, reason = 'manual' }) {
  if (!projectName) throw new Error('projectName is required');
  if (!isValidDateText(activityDate)) throw new Error('activityDate must use YYYY-MM-DD');
  const payload = await fetchDailyPayload(env, projectName, activityDate);
  await writeDailyPayload(env, projectName, activityDate, payload, { reason });
}

export async function rollupYesterdayForAllProjects(env, { reason = 'cron' } = {}) {
  const activityDate = getBusinessDateDaysAgo(1);
  const projects = await fetchProjectNames(env, activityDate);
  for (const projectName of projects) {
    await rollupAnalyticsDay(env, { projectName, activityDate, reason });
  }
  console.log(`[analytics] daily rollup finished for ${projects.length} projects on ${activityDate}`);
}

export const dailyRollupConfig = {
  businessTimeZone: BUSINESS_TIME_ZONE,
  source: SOURCE_ROLLUP,
  unknownVersion: UNKNOWN_VERSION,
};
