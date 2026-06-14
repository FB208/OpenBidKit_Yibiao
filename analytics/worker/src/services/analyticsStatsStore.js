import { ALLOWED_EVENTS, CONFIG_USAGE_FIELDS, DATASET, MODEL_USAGE_FIELDS } from '../constants.js';
import {
  businessDateRangeCondition,
  businessDateSqlExpression,
  businessDateTimeSqlExpression,
  formatBusinessDateTime,
  getBusinessDateDaysAgo,
  getBusinessToday,
  normalizeText,
  sqlString,
} from '../utils.js';
import { queryAnalytics } from './analyticsQuery.js';
import { listAdminResources } from './resourceStore.js';

const UNKNOWN_VERSION = '未知版本';
const MAX_ANALYTICS_ROWS = 100000;
const RECENT_CLIENT_CREATED_MAX_AGE_DAYS = 1;
const MAX_RECENT_CLIENT_WRITE_ATTEMPTS = 10000;
const recentClientWriteAttempts = new Set();

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) {
    throw new Error('ANALYTICS_DB is not configured');
  }
  return env.ANALYTICS_DB;
}

function requireResourceDb(env) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }
  return env.RESOURCE_DB;
}

async function all(db, sql, bindings = []) {
  const result = await db.prepare(sql).bind(...bindings).all();
  return result?.results || [];
}

async function first(db, sql, bindings = []) {
  return await db.prepare(sql).bind(...bindings).first();
}

async function run(db, sql, bindings = []) {
  return await db.prepare(sql).bind(...bindings).run();
}

function number(value) {
  return Number(value || 0);
}

function normalizedVersion(value) {
  return normalizeText(value, 50) || UNKNOWN_VERSION;
}

function nowText() {
  return formatBusinessDateTime(new Date());
}

function daysSinceBusinessDate(value) {
  const dateText = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return Infinity;

  const date = new Date(`${dateText}T00:00:00.000Z`);
  const today = new Date(`${getBusinessToday()}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return Infinity;
  return Math.floor((today.getTime() - date.getTime()) / 86400000);
}

function shouldAttemptRealtimeClientInsert(event) {
  if (!event.clientId || !event.clientCreatedAt) return false;
  const age = daysSinceBusinessDate(event.clientCreatedAt);
  return Number.isFinite(age) && age >= 0 && age <= RECENT_CLIENT_CREATED_MAX_AGE_DAYS;
}

function clientAttemptKey(projectName, clientId) {
  return `${projectName}\0${clientId}`;
}

function rememberClientAttempt(key) {
  if (recentClientWriteAttempts.size >= MAX_RECENT_CLIENT_WRITE_ATTEMPTS) {
    recentClientWriteAttempts.clear();
  }
  recentClientWriteAttempts.add(key);
}

function allowedEventsSql() {
  return `(${Array.from(ALLOWED_EVENTS).map((event) => sqlString(event)).join(', ')})`;
}

function configUsageKeysSql() {
  return `(${CONFIG_USAGE_FIELDS.map((field) => sqlString(field.key)).join(', ')})`;
}

function businessDateCondition(activityDate) {
  return `${businessDateSqlExpression()} = ${sqlString(activityDate)}`;
}

function aeRangeCondition(range) {
  if (range === 'today') {
    return businessDateCondition(getBusinessToday());
  }

  const days = range === '7' ? 7 : 30;
  return businessDateRangeCondition(getBusinessDateDaysAgo(days - 1), getBusinessToday());
}

function modelFiltersSql(filters) {
  const conditions = [];
  if (filters.provider) conditions.push(`provider = ${sqlString(filters.provider)}`);
  if (filters.endpointHost) conditions.push(`endpoint_host = ${sqlString(filters.endpointHost)}`);
  if (filters.model) conditions.push(`model = ${sqlString(filters.model)}`);
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

function modelFiltersAeSql(filters) {
  const conditions = [];
  if (filters.provider) conditions.push(`blob9 = ${sqlString(filters.provider)}`);
  if (filters.endpointHost) conditions.push(`blob10 = ${sqlString(filters.endpointHost)}`);
  if (filters.model) conditions.push(`blob11 = ${sqlString(filters.model)}`);
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

function compareVersionLabelsDesc(left, right) {
  const a = normalizedVersion(left);
  const b = normalizedVersion(right);
  if (a === b) return 0;
  if (a === UNKNOWN_VERSION) return 1;
  if (b === UNKNOWN_VERSION) return -1;

  const leftParts = a.replace(/^v/i, '').split(/[._-]/);
  const rightParts = b.replace(/^v/i, '').split(/[._-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || '0';
    const rightPart = rightParts[index] || '0';
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : NaN;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : NaN;
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return rightNumber - leftNumber;
    }
    if (leftPart !== rightPart) {
      return rightPart.localeCompare(leftPart, 'zh-CN', { numeric: true });
    }
  }
  return 0;
}

function sortVersionRows(rows) {
  return [...rows].sort((left, right) => compareVersionLabelsDesc(left.version, right.version));
}

async function ensureTotals(db, projectName, updatedAt = nowText()) {
  await run(db, `
    INSERT INTO stats_totals (project_name, total_clients, total_open, total_page_views, total_events, total_ai_requests, last_rollup_date, updated_at)
    VALUES (?, 0, 0, 0, 0, 0, '', ?)
    ON CONFLICT(project_name) DO NOTHING
  `, [projectName, updatedAt]);
}

export async function recordTrackClient(env, event) {
  if (!shouldAttemptRealtimeClientInsert(event)) {
    return;
  }

  const cacheKey = clientAttemptKey(event.projectName, event.clientId);
  if (recentClientWriteAttempts.has(cacheKey)) {
    return;
  }
  rememberClientAttempt(cacheKey);

  const db = requireStatsDb(env);
  const updatedAt = nowText();
  const result = await run(db, `
    INSERT INTO stats_clients (
      project_name, client_id, first_seen_at, first_seen_date, active_days,
      last_active_date, last_active_version, last_access_ip, platform, arch, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, '', '', ?, ?, ?, ?, ?)
    ON CONFLICT(project_name, client_id) DO NOTHING
  `, [
    event.projectName,
    event.clientId,
    updatedAt,
    event.clientCreatedAt,
    event.clientIp || '',
    event.platform || '',
    event.arch || '',
    updatedAt,
    updatedAt,
  ]);
  if (!result?.meta?.changes) {
    return;
  }

  await ensureTotals(db, event.projectName, updatedAt);
  await run(db, `
    UPDATE stats_totals
    SET total_clients = total_clients + 1, updated_at = ?
    WHERE project_name = ?
  `, [updatedAt, event.projectName]);
}

async function queryTodayActiveClients(env, projectName) {
  const project = sqlString(projectName);
  const sql = `
    SELECT COUNT(DISTINCT blob7) AS activeClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ${allowedEventsSql()}
      AND blob7 != ''
      AND ${businessDateCondition(getBusinessToday())}
  `;
  const result = await queryAnalytics(env, sql);
  return number(result.data?.[0]?.activeClients);
}

async function queryTodayDaily(env, projectName) {
  const project = sqlString(projectName);
  const sql = `
    SELECT
      COUNT(DISTINCT blob7) AS activeClients,
      SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpen,
      SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageView,
      SUM(_sample_interval) AS eventCount
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ${allowedEventsSql()}
      AND ${businessDateCondition(getBusinessToday())}
  `;
  const result = await queryAnalytics(env, sql);
  const row = result.data?.[0] || {};
  return {
    date: getBusinessToday(),
    activeClients: number(row.activeClients),
    appOpen: number(row.appOpen),
    pageView: number(row.pageView),
    eventCount: number(row.eventCount),
    source: 'analytics_engine',
  };
}

export async function queryStatsOverview(env, projectName) {
  const db = requireStatsDb(env);
  const today = getBusinessToday();
  const last7Start = getBusinessDateDaysAgo(6);
  const last9Start = getBusinessDateDaysAgo(9);

  const [totals, todayNew, last7New, dailyRows, todayActiveClients, todayDaily] = await Promise.all([
    first(db, `
      SELECT total_clients, total_open, total_page_views, total_events, total_ai_requests, last_rollup_date
      FROM stats_totals
      WHERE project_name = ?
    `, [projectName]),
    first(db, `
      SELECT COUNT(*) AS count
      FROM stats_clients
      WHERE project_name = ? AND first_seen_date = ?
    `, [projectName, today]),
    first(db, `
      SELECT COUNT(*) AS count
      FROM stats_clients
      WHERE project_name = ? AND first_seen_date >= ?
    `, [projectName, last7Start]),
    all(db, `
      SELECT activity_date AS date, active_clients AS activeClients, app_open_count AS appOpen, page_view_count AS pageView, event_count AS eventCount, 'd1' AS source
      FROM stats_daily
      WHERE project_name = ? AND activity_date >= ? AND activity_date < ?
      ORDER BY activity_date DESC
    `, [projectName, last9Start, today]),
    queryTodayActiveClients(env, projectName),
    queryTodayDaily(env, projectName),
  ]);

  const daily = [todayDaily, ...dailyRows.map((row) => ({
    date: row.date,
    activeClients: number(row.activeClients),
    appOpen: number(row.appOpen),
    pageView: number(row.pageView),
    eventCount: number(row.eventCount),
    source: row.source,
  }))].slice(0, 10);

  return {
    code: 0,
    projectName,
    source: 'stats',
    totalClients: number(totals?.total_clients),
    totalOpen: number(totals?.total_open),
    totalView: number(totals?.total_page_views),
    totalEvents: number(totals?.total_events),
    totalAiRequests: number(totals?.total_ai_requests),
    todayNewClients: number(todayNew?.count),
    last7NewClients: number(last7New?.count),
    todayActiveClients,
    lastRollupDate: totals?.last_rollup_date || '',
    daily,
  };
}

export async function queryStatsClients(env, projectName) {
  const db = requireStatsDb(env);
  const rows = await all(db, `
    SELECT
      client_id AS clientId,
      first_seen_at AS firstSeenAt,
      active_days AS activeDays,
      last_active_date AS lastActiveDate,
      last_active_version AS lastActiveVersion,
      last_access_ip AS lastAccessIp
    FROM stats_clients
    WHERE project_name = ?
    ORDER BY last_active_date DESC, first_seen_at DESC, client_id ASC
  `, [projectName]);

  return rows.map((row) => ({
    clientId: row.clientId,
    firstSeenAt: row.firstSeenAt,
    activeDays: number(row.activeDays),
    lastActiveDate: row.lastActiveDate || '',
    lastActiveVersion: row.lastActiveVersion || '',
    lastAccessIp: row.lastAccessIp || '',
  }));
}

export async function queryStatsIpStats(env, projectName, page, pageSize) {
  const db = requireStatsDb(env);
  const normalizedPage = Math.max(1, Math.floor(number(page) || 1));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(number(pageSize) || 20)));
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const total = await first(db, `
    SELECT COUNT(*) AS count
    FROM (
      SELECT last_access_ip
      FROM stats_clients
      WHERE project_name = ? AND last_access_ip != ''
      GROUP BY last_access_ip
    )
  `, [projectName]);
  const rows = await all(db, `
    SELECT last_access_ip AS ip, COUNT(*) AS clientCount
    FROM stats_clients
    WHERE project_name = ? AND last_access_ip != ''
    GROUP BY last_access_ip
    ORDER BY clientCount DESC, last_access_ip ASC
    LIMIT ? OFFSET ?
  `, [projectName, normalizedPageSize, offset]);

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    total: number(total?.count),
    items: rows.map((row) => ({
      ip: row.ip || '',
      clientCount: number(row.clientCount),
    })),
  };
}

export async function queryStatsClientDetail(env, projectName, clientId, range) {
  const project = sqlString(projectName);
  const client = sqlString(clientId);
  const rangeWhere = range === 'all' ? '' : `AND ${aeRangeCondition(range === '7' ? '7' : '30')}`;
  const sql = `
    SELECT
      ${businessDateSqlExpression()} AS date,
      blob2 AS event,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 = ${client}
      AND blob2 IN ${allowedEventsSql()}
      ${rangeWhere}
    GROUP BY date, event
    ORDER BY date DESC, event ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `;
  const result = await queryAnalytics(env, sql);
  const dailyMap = new Map();
  const events = {};

  for (const row of result.data || []) {
    const date = String(row.date || '').slice(0, 10);
    const event = String(row.event || '');
    const count = number(row.count);
    if (!date || !event) continue;
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, total: 0, events: {} });
    }
    const item = dailyMap.get(date);
    item.events[event] = (item.events[event] || 0) + count;
    item.total += count;
    events[event] = (events[event] || 0) + count;
  }

  return {
    clientId,
    range,
    activeDates: Array.from(dailyMap.keys()),
    daily: Array.from(dailyMap.values()),
    events: Object.entries(events).map(([event, count]) => ({ event, count })),
  };
}

export async function queryStatsTraffic(env, projectName, range) {
  if (range === 'history') {
    const db = requireStatsDb(env);
    const [pages, versions] = await Promise.all([
      all(db, `
        SELECT page, view_count AS count
        FROM stats_pages
        WHERE project_name = ?
        ORDER BY view_count DESC, page ASC
        LIMIT 100
      `, [projectName]),
      all(db, `
        SELECT version, event_count AS count, client_count AS clients
        FROM stats_versions
        WHERE project_name = ?
      `, [projectName]),
    ]);
    return {
      pages: pages.map((row) => ({ page: row.page, count: number(row.count) })),
      versions: sortVersionRows(versions.map((row) => ({
        version: normalizedVersion(row.version),
        count: number(row.count),
        clients: number(row.clients),
      }))),
    };
  }

  const project = sqlString(projectName);
  const rangeWhere = aeRangeCondition(range);
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const [pages, versions, versionClients] = await Promise.all([
    queryAnalytics(env, `
      SELECT
        blob3 AS page,
        SUM(_sample_interval) AS count
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'page_view'
        AND ${rangeWhere}
      GROUP BY page
      ORDER BY count DESC
      LIMIT 100
    `),
    queryAnalytics(env, `
      SELECT
        ${versionExpr} AS version,
        SUM(_sample_interval) AS count
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND ${rangeWhere}
      GROUP BY version
      LIMIT 100
    `),
    queryAnalytics(env, `
      SELECT
        ${versionExpr} AS version,
        COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND blob7 != ''
        AND ${rangeWhere}
      GROUP BY version
      LIMIT 100
    `),
  ]);
  const clientsByVersion = new Map((versionClients.data || []).map((row) => [normalizedVersion(row.version), number(row.clients)]));

  return {
    pages: (pages.data || []).map((row) => ({ page: row.page, count: number(row.count) })),
    versions: sortVersionRows((versions.data || []).map((row) => ({
      version: normalizedVersion(row.version),
      count: number(row.count),
      clients: clientsByVersion.get(normalizedVersion(row.version)) || 0,
    }))),
  };
}

async function queryConfigHistoryField(db, projectName, field) {
  return all(db, `
    SELECT value, report_count AS events
    FROM stats_configs
    WHERE project_name = ? AND field_key = ?
    ORDER BY report_count DESC, value ASC
    LIMIT 50
  `, [projectName, field.key]);
}

async function queryConfigAeField(env, projectName, range, field) {
  const project = sqlString(projectName);
  const result = await queryAnalytics(env, `
    SELECT
      blob10 AS value,
      SUM(_sample_interval) AS events
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'config_usage'
      AND blob9 = ${sqlString(field.key)}
      AND blob10 != ''
      AND ${aeRangeCondition(range)}
    GROUP BY value
    ORDER BY events DESC, value ASC
    LIMIT 50
  `);
  return result.data || [];
}

export async function queryStatsConfigUsage(env, projectName, range) {
  const results = range === 'history'
    ? await Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryConfigHistoryField(requireStatsDb(env), projectName, field)))
    : await Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryConfigAeField(env, projectName, range, field)));
  const usage = {};
  CONFIG_USAGE_FIELDS.forEach((field, index) => {
    usage[field.key] = (results[index] || []).map((row) => ({
      value: row.value,
      events: number(row.events),
    }));
  });
  return usage;
}

async function queryModelHistoryField(db, projectName, field, filters) {
  return all(db, `
    SELECT
      provider,
      endpoint_host,
      model,
      request_count AS events,
      total_tokens AS totalTokens
    FROM stats_models
    WHERE project_name = ? AND request_type = ?${modelFiltersSql(filters)}
    ORDER BY events DESC, model ASC
    LIMIT 100
  `, [projectName, field.requestType]);
}

async function queryModelAeField(env, projectName, range, field, filters) {
  const project = sqlString(projectName);
  const result = await queryAnalytics(env, `
    SELECT
      blob9 AS provider,
      blob10 AS endpoint_host,
      blob11 AS model,
      SUM(_sample_interval) AS events,
      SUM(double4 * _sample_interval) AS totalTokens
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'ai_request'
      AND blob12 = ${sqlString(field.requestType)}
      AND blob11 != ''
      AND ${aeRangeCondition(range)}
      ${modelFiltersAeSql(filters)}
    GROUP BY provider, endpoint_host, model
    ORDER BY events DESC, model ASC
    LIMIT 100
  `);
  return result.data || [];
}

export async function queryStatsModelUsage(env, projectName, range, filters) {
  const db = range === 'history' ? requireStatsDb(env) : null;
  const results = await Promise.all(MODEL_USAGE_FIELDS.map((field) => (
    range === 'history'
      ? queryModelHistoryField(db, projectName, field, filters)
      : queryModelAeField(env, projectName, range, field, filters)
  )));
  const usage = {};
  MODEL_USAGE_FIELDS.forEach((field, index) => {
    usage[field.key] = (results[index] || []).map((row) => ({
      provider: row.provider || '',
      endpoint_host: row.endpoint_host || '',
      model: row.model || '',
      events: number(row.events),
      totalTokens: number(row.totalTokens),
    }));
  });
  return usage;
}

export async function queryStatsProjects(env) {
  const db = requireStatsDb(env);
  const rows = await all(db, `
    SELECT project_name AS projectName FROM stats_totals
    UNION
    SELECT project_name AS projectName FROM stats_clients
    ORDER BY projectName ASC
  `);
  return rows.map((row) => row.projectName).filter(Boolean);
}

async function queryRollupProjects(env, activityDate) {
  const result = await queryAnalytics(env, `
    SELECT blob1 AS projectName
    FROM ${DATASET}
    WHERE blob1 != '' AND ${businessDateCondition(activityDate)}
    GROUP BY projectName
    ORDER BY projectName ASC
  `);
  return (result.data || []).map((row) => row.projectName).filter(Boolean);
}

async function queryRollupData(env, projectName, activityDate, options = {}) {
  const project = sqlString(projectName);
  const dateWhere = businessDateCondition(activityDate);
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const includeResources = options.includeResources !== false;
  const [
    summary,
    activeClients,
    clients,
    pages,
    versions,
    configs,
    models,
    resources,
  ] = await Promise.all([
    queryAnalytics(env, `
      SELECT
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND ${dateWhere}
    `),
    queryAnalytics(env, `
      SELECT COUNT(DISTINCT blob7) AS activeClients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND blob7 != ''
        AND ${dateWhere}
    `),
    queryAnalytics(env, `
      SELECT
        blob7 AS clientId,
        ${businessDateTimeSqlExpression('min(timestamp)')} AS firstSeenAt,
        max(timestamp) AS lastSeenAt,
        argMax(${versionExpr}, timestamp) AS lastVersion,
        argMax(blob13, timestamp) AS lastAccessIp,
        argMax(blob5, timestamp) AS platform,
        argMax(blob6, timestamp) AS arch
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob3 AS page, SUM(_sample_interval) AS count
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'page_view'
        AND blob3 != ''
        AND ${dateWhere}
      GROUP BY page
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT
        ${versionExpr} AS version,
        SUM(_sample_interval) AS eventCount
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND ${dateWhere}
      GROUP BY version
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob9 AS fieldKey, blob10 AS value, SUM(_sample_interval) AS events
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'config_usage'
        AND blob9 IN ${configUsageKeysSql()}
        AND blob10 != ''
        AND ${dateWhere}
      GROUP BY fieldKey, value
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT
        blob12 AS requestType,
        blob9 AS provider,
        blob10 AS endpointHost,
        blob11 AS model,
        SUM(_sample_interval) AS requestCount,
        SUM(double4 * _sample_interval) AS totalTokens
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'ai_request'
        AND blob12 IN ('text', 'image')
        AND blob11 != ''
        AND ${dateWhere}
      GROUP BY requestType, provider, endpointHost, model
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    includeResources ? queryAnalytics(env, `
      SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'resource_click'
        AND blob9 != ''
        AND ${dateWhere}
      GROUP BY resourceKey
      LIMIT ${MAX_ANALYTICS_ROWS}
    `) : Promise.resolve({ data: [] }),
  ]);

  return {
    summary: summary.data?.[0] || {},
    activeClients: number(activeClients.data?.[0]?.activeClients),
    clients: clients.data || [],
    pages: pages.data || [],
    versions: versions.data || [],
    configs: configs.data || [],
    models: models.data || [],
    resources: resources.data || [],
  };
}

async function refreshVersionClientCounts(db, projectName, updatedAt) {
  await run(db, `
    UPDATE stats_versions
    SET
      client_count = (
        SELECT COUNT(*)
        FROM stats_clients
        WHERE stats_clients.project_name = stats_versions.project_name
          AND stats_clients.last_active_version = stats_versions.version
      ),
      updated_at = ?
    WHERE project_name = ?
  `, [updatedAt, projectName]);

  const rows = await all(db, `
    SELECT last_active_version AS version, COUNT(*) AS clientCount
    FROM stats_clients
    WHERE project_name = ? AND last_active_version != ''
    GROUP BY last_active_version
  `, [projectName]);

  for (const row of rows) {
    await run(db, `
      INSERT INTO stats_versions (project_name, version, event_count, client_count, updated_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(project_name, version) DO UPDATE SET
        client_count = excluded.client_count,
        updated_at = excluded.updated_at
    `, [projectName, normalizedVersion(row.version), number(row.clientCount), updatedAt]);
  }
}

async function markRollupRunning(db, projectName, activityDate, updatedAt) {
  await run(db, `
    INSERT INTO stats_rollup_runs (project_name, activity_date, status, started_at, completed_at, error)
    VALUES (?, ?, 'running', ?, '', '')
    ON CONFLICT(project_name, activity_date) DO UPDATE SET
      status = 'running',
      started_at = excluded.started_at,
      completed_at = '',
      error = ''
  `, [projectName, activityDate, updatedAt]);
}

async function markRollupSuccess(db, projectName, activityDate, updatedAt) {
  await run(db, `
    INSERT INTO stats_rollup_runs (project_name, activity_date, status, started_at, completed_at, error)
    VALUES (?, ?, 'success', ?, ?, '')
    ON CONFLICT(project_name, activity_date) DO UPDATE SET
      status = 'success',
      completed_at = excluded.completed_at,
      error = ''
  `, [projectName, activityDate, updatedAt, updatedAt]);
}

async function markRollupFailed(db, projectName, activityDate, updatedAt, error) {
  await run(db, `
    UPDATE stats_rollup_runs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE project_name = ? AND activity_date = ?
  `, [updatedAt, normalizeText(error?.message || String(error), 1000), projectName, activityDate]);
}

async function hasDailyRollupRow(db, projectName, activityDate) {
  const row = await first(db, `
    SELECT 1 AS existsFlag
    FROM stats_daily
    WHERE project_name = ? AND activity_date = ?
    LIMIT 1
  `, [projectName, activityDate]);
  return Boolean(row?.existsFlag);
}

async function incrementResourceClickCounts(env, rows) {
  const resourceRows = (rows || [])
    .map((row) => ({ resourceKey: normalizeText(row.resourceKey, 80), clickCount: number(row.clickCount) }))
    .filter((row) => row.resourceKey && row.clickCount > 0);
  if (!resourceRows.length) return;

  const resourceDb = requireResourceDb(env);
  const resources = await listAdminResources(env, { origin: '' });
  const idByAnalyticsKey = new Map(resources.map((resource) => [resource.analyticsKey, resource.id]));
  for (const row of resourceRows) {
    const resourceId = idByAnalyticsKey.get(row.resourceKey);
    if (!resourceId) continue;
    await run(resourceDb, `
      UPDATE resources
      SET click_count = click_count + ?
      WHERE id = ?
    `, [row.clickCount, resourceId]);
  }
}

async function rollupResourceClicksDay(env, projectName, activityDate) {
  if (!env.RESOURCE_DB) {
    return { skipped: true, reason: 'RESOURCE_DB is not configured' };
  }

  const result = await queryAnalytics(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
      AND blob2 = 'resource_click'
      AND blob9 != ''
      AND ${businessDateCondition(activityDate)}
    GROUP BY resourceKey
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  await incrementResourceClickCounts(env, result.data || []);
  return { skipped: false };
}

async function upsertRollupData(db, projectName, activityDate, data, options = {}) {
  const updatedAt = nowText();
  const eventCount = number(data.summary.eventCount);
  const appOpenCount = number(data.summary.appOpenCount);
  const pageViewCount = number(data.summary.pageViewCount);
  const aiRequestCount = number(data.summary.aiRequestCount);

  await ensureTotals(db, projectName, updatedAt);
  await run(db, `
    INSERT INTO stats_daily (project_name, activity_date, active_clients, app_open_count, page_view_count, event_count, ai_request_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name, activity_date) DO UPDATE SET
      active_clients = excluded.active_clients,
      app_open_count = excluded.app_open_count,
      page_view_count = excluded.page_view_count,
      event_count = excluded.event_count,
      ai_request_count = excluded.ai_request_count,
      updated_at = excluded.updated_at
  `, [projectName, activityDate, data.activeClients, appOpenCount, pageViewCount, eventCount, aiRequestCount, updatedAt]);

  for (const row of data.clients) {
    const clientId = normalizeText(row.clientId, 120);
    if (!clientId) continue;
    await run(db, `
      INSERT INTO stats_clients (
        project_name, client_id, first_seen_at, first_seen_date, active_days,
        last_active_date, last_active_version, last_access_ip, platform, arch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, client_id) DO UPDATE SET
        active_days = stats_clients.active_days + 1,
        last_active_date = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_date ELSE stats_clients.last_active_date END,
        last_active_version = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_version ELSE stats_clients.last_active_version END,
        last_access_ip = CASE WHEN excluded.last_access_ip != '' AND excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_access_ip ELSE stats_clients.last_access_ip END,
        platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE stats_clients.platform END,
        arch = CASE WHEN excluded.arch != '' THEN excluded.arch ELSE stats_clients.arch END,
        updated_at = excluded.updated_at
    `, [
      projectName,
      clientId,
      String(row.firstSeenAt || `${activityDate} 00:00:00`),
      activityDate,
      activityDate,
      normalizedVersion(row.lastVersion),
      normalizeText(row.lastAccessIp, 80),
      normalizeText(row.platform, 50),
      normalizeText(row.arch, 50),
      updatedAt,
      updatedAt,
    ]);
  }

  for (const row of data.pages) {
    await run(db, `
      INSERT INTO stats_pages (project_name, page, view_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_name, page) DO UPDATE SET
        view_count = stats_pages.view_count + excluded.view_count,
        updated_at = excluded.updated_at
    `, [projectName, normalizeText(row.page, 120), number(row.count), updatedAt]);
  }

  for (const row of data.versions) {
    await run(db, `
      INSERT INTO stats_versions (project_name, version, event_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_name, version) DO UPDATE SET
        event_count = stats_versions.event_count + excluded.event_count,
        updated_at = excluded.updated_at
    `, [projectName, normalizedVersion(row.version), number(row.eventCount), updatedAt]);
  }

  for (const row of data.configs) {
    await run(db, `
      INSERT INTO stats_configs (project_name, field_key, value, report_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_name, field_key, value) DO UPDATE SET
        report_count = stats_configs.report_count + excluded.report_count,
        updated_at = excluded.updated_at
    `, [projectName, row.fieldKey, normalizeText(row.value, 200), number(row.events), updatedAt]);
  }

  for (const row of data.models) {
    await run(db, `
      INSERT INTO stats_models (project_name, request_type, provider, endpoint_host, model, request_count, total_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, request_type, provider, endpoint_host, model) DO UPDATE SET
        request_count = stats_models.request_count + excluded.request_count,
        total_tokens = stats_models.total_tokens + excluded.total_tokens,
        updated_at = excluded.updated_at
    `, [
      projectName,
      normalizeText(row.requestType, 20),
      normalizeText(row.provider, 80),
      normalizeText(row.endpointHost, 120),
      normalizeText(row.model, 160),
      number(row.requestCount),
      number(row.totalTokens),
      updatedAt,
    ]);
  }

  await refreshVersionClientCounts(db, projectName, updatedAt);

  await run(db, `
    UPDATE stats_totals
    SET
      total_open = total_open + ?,
      total_page_views = total_page_views + ?,
      total_events = total_events + ?,
      total_ai_requests = total_ai_requests + ?,
      total_clients = (SELECT COUNT(*) FROM stats_clients WHERE project_name = ?),
      last_rollup_date = CASE WHEN last_rollup_date < ? THEN ? ELSE last_rollup_date END,
      updated_at = ?
    WHERE project_name = ?
  `, [appOpenCount, pageViewCount, eventCount, aiRequestCount, projectName, activityDate, activityDate, updatedAt, projectName]);
}

export async function rollupStatsDay(env, projectName, activityDate, options = {}) {
  const db = requireStatsDb(env);
  const existing = await first(db, `
    SELECT status
    FROM stats_rollup_runs
    WHERE project_name = ? AND activity_date = ?
  `, [projectName, activityDate]);
  if (existing?.status === 'success') {
    return { projectName, activityDate, skipped: true };
  }
  if (await hasDailyRollupRow(db, projectName, activityDate)) {
    console.warn(`[analytics] rollup skipped to avoid duplicated counters: ${projectName}/${activityDate} status=${existing?.status || 'missing'}`);
    await markRollupSuccess(db, projectName, activityDate, nowText());
    return { projectName, activityDate, skipped: true };
  }

  const startedAt = nowText();
  await markRollupRunning(db, projectName, activityDate, startedAt);
  try {
    const data = await queryRollupData(env, projectName, activityDate, { includeResources: false });
    await upsertRollupData(db, projectName, activityDate, data);
    await markRollupSuccess(db, projectName, activityDate, nowText());
    if (options.updateResources !== false) {
      try {
        const resourceResult = await rollupResourceClicksDay(env, projectName, activityDate);
        if (resourceResult.skipped) {
          console.warn(`[analytics] resource click rollup skipped: ${resourceResult.reason}`);
        }
      } catch (error) {
        console.warn('[analytics] resource click rollup failed', error?.message || String(error));
      }
    }
    return { projectName, activityDate, skipped: false };
  } catch (error) {
    if (await hasDailyRollupRow(db, projectName, activityDate)) {
      console.warn(`[analytics] rollup marked success after partial write to avoid duplicated counters: ${projectName}/${activityDate}`, error?.message || String(error));
      await markRollupSuccess(db, projectName, activityDate, nowText());
      return { projectName, activityDate, skipped: false, partial: true };
    }
    await markRollupFailed(db, projectName, activityDate, nowText(), error);
    throw error;
  }
}

export async function rollupYesterdayForAllProjects(env) {
  const activityDate = getBusinessDateDaysAgo(1);
  const projects = await queryRollupProjects(env, activityDate);
  const results = [];
  for (const projectName of projects) {
    results.push(await rollupStatsDay(env, projectName, activityDate));
  }
  return { activityDate, projects: results };
}
