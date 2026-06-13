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

const UNKNOWN_VERSION = '未知版本';
const MAX_ANALYTICS_ROWS = 100000;
const RECENT_CLIENT_CREATED_DAYS = 3;
const MAX_RECENT_CLIENT_WRITE_ATTEMPTS = 10000;
const recentClientWriteAttempts = new Set();

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) {
    throw new Error('ANALYTICS_DB is not configured');
  }
  return env.ANALYTICS_DB;
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
  return Number.isFinite(age) && age >= 0 && age < RECENT_CLIENT_CREATED_DAYS;
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

function dimensionKey(parts) {
  return JSON.stringify(parts.map((part) => String(part ?? '')));
}

function pageDimensionKey(page) {
  return dimensionKey([normalizeText(page, 120)]);
}

function versionDimensionKey(version) {
  return dimensionKey([normalizedVersion(version)]);
}

function configDimensionKey(fieldKey, value) {
  return dimensionKey([fieldKey, normalizeText(value, 200)]);
}

function modelDimensionKey(requestType, provider, endpointHost, model) {
  return dimensionKey([
    normalizeText(requestType, 20),
    normalizeText(provider, 80),
    normalizeText(endpointHost, 120),
    normalizeText(model, 160),
  ]);
}

function resourceDimensionKey(resourceKey) {
  return dimensionKey([normalizeText(resourceKey, 80)]);
}

function allowedEventsSql() {
  return `(${Array.from(ALLOWED_EVENTS).map((event) => sqlString(event)).join(', ')})`;
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

async function upsertDimensionClient(db, projectName, dimensionType, key, clientId, activityDate, updatedAt) {
  const normalizedClientId = normalizeText(clientId, 120);
  if (!normalizedClientId || !key) return;

  await run(db, `
    INSERT INTO stats_dimension_clients (project_name, dimension_type, dimension_key, client_id, first_seen_date, last_seen_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name, dimension_type, dimension_key, client_id) DO UPDATE SET
      last_seen_date = CASE WHEN excluded.last_seen_date > stats_dimension_clients.last_seen_date THEN excluded.last_seen_date ELSE stats_dimension_clients.last_seen_date END,
      updated_at = excluded.updated_at
  `, [projectName, dimensionType, key, normalizedClientId, activityDate, activityDate, updatedAt]);
}

async function updateDimensionClientCount(db, tableName, countColumn, whereSql, bindings, projectName, dimensionType, key) {
  await run(db, `
    UPDATE ${tableName}
    SET ${countColumn} = (
      SELECT COUNT(*)
      FROM stats_dimension_clients
      WHERE project_name = ? AND dimension_type = ? AND dimension_key = ?
    )
    WHERE ${whereSql}
  `, [projectName, dimensionType, key, ...bindings]);
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
      last_active_date, last_active_version, platform, arch, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, '', '', ?, ?, ?, ?)
    ON CONFLICT(project_name, client_id) DO NOTHING
  `, [
    event.projectName,
    event.clientId,
    updatedAt,
    event.clientCreatedAt,
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
      last_active_version AS lastActiveVersion
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
  }));
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
        SELECT page, view_count AS count, client_count AS clients
        FROM stats_pages
        WHERE project_name = ?
        ORDER BY view_count DESC, client_count DESC, page ASC
        LIMIT 100
      `, [projectName]),
      all(db, `
        SELECT
          version,
          event_count AS count,
          app_open_count AS appOpenCount,
          page_view_count AS pageViewCount,
          config_usage_count AS configUsageCount,
          ai_request_count AS aiRequestCount,
          resource_click_count AS resourceClickCount,
          client_count AS clients
        FROM stats_versions
        WHERE project_name = ?
      `, [projectName]),
    ]);
    return {
      pages: pages.map((row) => ({ page: row.page, count: number(row.count), clients: number(row.clients) })),
      versions: sortVersionRows(versions.map((row) => ({
        version: normalizedVersion(row.version),
        clients: number(row.clients),
        count: number(row.count),
        appOpenCount: number(row.appOpenCount),
        pageViewCount: number(row.pageViewCount),
        configUsageCount: number(row.configUsageCount),
        aiRequestCount: number(row.aiRequestCount),
        resourceClickCount: number(row.resourceClickCount),
      }))),
    };
  }

  const project = sqlString(projectName);
  const rangeWhere = aeRangeCondition(range);
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const [pages, versions] = await Promise.all([
    queryAnalytics(env, `
      SELECT
        blob3 AS page,
        SUM(_sample_interval) AS count,
        COUNT(DISTINCT blob7) AS clients
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
        COUNT(DISTINCT blob7) AS clients,
        SUM(_sample_interval) AS count
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob7 != ''
        AND ${rangeWhere}
      GROUP BY version
      LIMIT 100
    `),
  ]);

  return {
    pages: (pages.data || []).map((row) => ({ page: row.page, count: number(row.count), clients: number(row.clients) })),
    versions: sortVersionRows((versions.data || []).map((row) => ({
      version: normalizedVersion(row.version),
      clients: number(row.clients),
      count: number(row.count),
    }))),
  };
}

async function queryConfigHistoryField(db, projectName, field) {
  return all(db, `
    SELECT value, client_count AS clients, report_count AS events
    FROM stats_configs
    WHERE project_name = ? AND field_key = ?
    ORDER BY client_count DESC, report_count DESC, value ASC
    LIMIT 50
  `, [projectName, field.key]);
}

async function queryConfigAeField(env, projectName, range, field) {
  const project = sqlString(projectName);
  const result = await queryAnalytics(env, `
    SELECT
      ${field.blob} AS value,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS events
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'config_usage'
      AND ${field.blob} != ''
      AND ${aeRangeCondition(range)}
    GROUP BY value
    ORDER BY clients DESC, events DESC, value ASC
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
      clients: number(row.clients),
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
      client_count AS clients,
      request_count AS events,
      prompt_tokens,
      completion_tokens,
      total_tokens
    FROM stats_models
    WHERE project_name = ? AND request_type = ?${modelFiltersSql(filters)}
    ORDER BY total_tokens DESC, events DESC, clients DESC, model ASC
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
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS events,
      SUM(double2 * _sample_interval) AS prompt_tokens,
      SUM(double3 * _sample_interval) AS completion_tokens,
      SUM(double4 * _sample_interval) AS total_tokens
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'ai_request'
      AND blob12 = ${sqlString(field.requestType)}
      AND blob11 != ''
      AND ${aeRangeCondition(range)}
      ${modelFiltersAeSql(filters)}
    GROUP BY provider, endpoint_host, model
    ORDER BY total_tokens DESC, events DESC, clients DESC, model ASC
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
      clients: number(row.clients),
      events: number(row.events),
      prompt_tokens: number(row.prompt_tokens),
      completion_tokens: number(row.completion_tokens),
      total_tokens: number(row.total_tokens),
    }));
  });
  return usage;
}

export async function queryStatsResourceClickCounts(env, projectName, resourceKeys = []) {
  const db = requireStatsDb(env);
  const keys = Array.from(new Set(resourceKeys.filter(Boolean)));
  if (!keys.length) return new Map();

  const placeholders = keys.map(() => '?').join(', ');
  const rows = await all(db, `
    SELECT resource_key AS resourceKey, click_count AS clickCount, client_count AS clients
    FROM stats_resource_clicks
    WHERE project_name = ? AND resource_key IN (${placeholders})
  `, [projectName, ...keys]);
  return new Map(rows.map((row) => [row.resourceKey, { clickCount: number(row.clickCount), clients: number(row.clients) }]));
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

async function queryRollupData(env, projectName, activityDate) {
  const project = sqlString(projectName);
  const dateWhere = businessDateCondition(activityDate);
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const [
    summary,
    activeClients,
    clients,
    pages,
    pageClients,
    versions,
    versionClients,
    configResults,
    configClientResults,
    models,
    modelClients,
    resources,
    resourceClients,
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
      SELECT blob3 AS page, SUM(_sample_interval) AS count, COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'page_view'
        AND blob3 != ''
        AND ${dateWhere}
      GROUP BY page
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob3 AS page, blob7 AS clientId
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'page_view'
        AND blob3 != ''
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY page, clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT
        ${versionExpr} AS version,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(if(blob2 = 'config_usage', _sample_interval, 0)) AS configUsageCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount,
        SUM(if(blob2 = 'resource_click', _sample_interval, 0)) AS resourceClickCount,
        COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND ${dateWhere}
      GROUP BY version
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT ${versionExpr} AS version, blob7 AS clientId
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 IN ${allowedEventsSql()}
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY version, clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryAnalytics(env, `
      SELECT ${field.blob} AS value, SUM(_sample_interval) AS events, COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'config_usage'
        AND ${field.blob} != ''
        AND ${dateWhere}
      GROUP BY value
      LIMIT ${MAX_ANALYTICS_ROWS}
    `))),
    Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryAnalytics(env, `
      SELECT ${field.blob} AS value, blob7 AS clientId
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'config_usage'
        AND ${field.blob} != ''
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY value, clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `))),
    queryAnalytics(env, `
      SELECT
        blob12 AS requestType,
        blob9 AS provider,
        blob10 AS endpointHost,
        blob11 AS model,
        SUM(_sample_interval) AS requestCount,
        SUM(double2 * _sample_interval) AS promptTokens,
        SUM(double3 * _sample_interval) AS completionTokens,
        SUM(double4 * _sample_interval) AS totalTokens,
        COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'ai_request'
        AND blob12 IN ('text', 'image')
        AND blob11 != ''
        AND ${dateWhere}
      GROUP BY requestType, provider, endpointHost, model
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT
        blob12 AS requestType,
        blob9 AS provider,
        blob10 AS endpointHost,
        blob11 AS model,
        blob7 AS clientId
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'ai_request'
        AND blob12 IN ('text', 'image')
        AND blob11 != ''
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY requestType, provider, endpointHost, model, clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount, COUNT(DISTINCT blob7) AS clients
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'resource_click'
        AND blob9 != ''
        AND ${dateWhere}
      GROUP BY resourceKey
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob9 AS resourceKey, blob7 AS clientId
      FROM ${DATASET}
      WHERE blob1 = ${project}
        AND blob2 = 'resource_click'
        AND blob9 != ''
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY resourceKey, clientId
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
  ]);

  return {
    summary: summary.data?.[0] || {},
    activeClients: number(activeClients.data?.[0]?.activeClients),
    clients: clients.data || [],
    pages: pages.data || [],
    pageClients: pageClients.data || [],
    versions: versions.data || [],
    versionClients: versionClients.data || [],
    configs: CONFIG_USAGE_FIELDS.flatMap((field, index) => (configResults[index].data || []).map((row) => ({ ...row, fieldKey: field.key }))),
    configClients: CONFIG_USAGE_FIELDS.flatMap((field, index) => (configClientResults[index].data || []).map((row) => ({ ...row, fieldKey: field.key }))),
    models: models.data || [],
    modelClients: modelClients.data || [],
    resources: resources.data || [],
    resourceClients: resourceClients.data || [],
  };
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
    UPDATE stats_rollup_runs
    SET status = 'success', completed_at = ?, error = ''
    WHERE project_name = ? AND activity_date = ?
  `, [updatedAt, projectName, activityDate]);
}

async function markRollupFailed(db, projectName, activityDate, updatedAt, error) {
  await run(db, `
    UPDATE stats_rollup_runs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE project_name = ? AND activity_date = ?
  `, [updatedAt, normalizeText(error?.message || String(error), 1000), projectName, activityDate]);
}

async function upsertRollupData(db, projectName, activityDate, data) {
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
        last_active_date, last_active_version, platform, arch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, client_id) DO UPDATE SET
        active_days = stats_clients.active_days + 1,
        last_active_date = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_date ELSE stats_clients.last_active_date END,
        last_active_version = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_version ELSE stats_clients.last_active_version END,
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
      normalizeText(row.platform, 50),
      normalizeText(row.arch, 50),
      updatedAt,
      updatedAt,
    ]);
  }

  for (const row of data.pages) {
    await run(db, `
      INSERT INTO stats_pages (project_name, page, view_count, client_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_name, page) DO UPDATE SET
        view_count = stats_pages.view_count + excluded.view_count,
        updated_at = excluded.updated_at
    `, [projectName, normalizeText(row.page, 120), number(row.count), 0, updatedAt]);
  }
  for (const row of data.pageClients) {
    await upsertDimensionClient(db, projectName, 'page', pageDimensionKey(row.page), row.clientId, activityDate, updatedAt);
  }
  for (const row of data.pages) {
    const page = normalizeText(row.page, 120);
    await updateDimensionClientCount(db, 'stats_pages', 'client_count', 'project_name = ? AND page = ?', [projectName, page], projectName, 'page', pageDimensionKey(page));
  }

  for (const row of data.versions) {
    await run(db, `
      INSERT INTO stats_versions (
        project_name, version, event_count, app_open_count, page_view_count, config_usage_count,
        ai_request_count, resource_click_count, client_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, version) DO UPDATE SET
        event_count = stats_versions.event_count + excluded.event_count,
        app_open_count = stats_versions.app_open_count + excluded.app_open_count,
        page_view_count = stats_versions.page_view_count + excluded.page_view_count,
        config_usage_count = stats_versions.config_usage_count + excluded.config_usage_count,
        ai_request_count = stats_versions.ai_request_count + excluded.ai_request_count,
        resource_click_count = stats_versions.resource_click_count + excluded.resource_click_count,
        updated_at = excluded.updated_at
    `, [
      projectName,
      normalizedVersion(row.version),
      number(row.eventCount),
      number(row.appOpenCount),
      number(row.pageViewCount),
      number(row.configUsageCount),
      number(row.aiRequestCount),
      number(row.resourceClickCount),
      0,
      updatedAt,
    ]);
  }
  for (const row of data.versionClients) {
    await upsertDimensionClient(db, projectName, 'version', versionDimensionKey(row.version), row.clientId, activityDate, updatedAt);
  }
  for (const row of data.versions) {
    const version = normalizedVersion(row.version);
    await updateDimensionClientCount(db, 'stats_versions', 'client_count', 'project_name = ? AND version = ?', [projectName, version], projectName, 'version', versionDimensionKey(version));
  }

  for (const row of data.configs) {
    await run(db, `
      INSERT INTO stats_configs (project_name, field_key, value, report_count, client_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, field_key, value) DO UPDATE SET
        report_count = stats_configs.report_count + excluded.report_count,
        updated_at = excluded.updated_at
    `, [projectName, row.fieldKey, normalizeText(row.value, 200), number(row.events), 0, updatedAt]);
  }
  for (const row of data.configClients) {
    await upsertDimensionClient(db, projectName, 'config', configDimensionKey(row.fieldKey, row.value), row.clientId, activityDate, updatedAt);
  }
  for (const row of data.configs) {
    const value = normalizeText(row.value, 200);
    await updateDimensionClientCount(db, 'stats_configs', 'client_count', 'project_name = ? AND field_key = ? AND value = ?', [projectName, row.fieldKey, value], projectName, 'config', configDimensionKey(row.fieldKey, value));
  }

  for (const row of data.models) {
    await run(db, `
      INSERT INTO stats_models (
        project_name, request_type, provider, endpoint_host, model,
        request_count, prompt_tokens, completion_tokens, total_tokens, client_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, request_type, provider, endpoint_host, model) DO UPDATE SET
        request_count = stats_models.request_count + excluded.request_count,
        prompt_tokens = stats_models.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = stats_models.completion_tokens + excluded.completion_tokens,
        total_tokens = stats_models.total_tokens + excluded.total_tokens,
        updated_at = excluded.updated_at
    `, [
      projectName,
      normalizeText(row.requestType, 20),
      normalizeText(row.provider, 80),
      normalizeText(row.endpointHost, 120),
      normalizeText(row.model, 160),
      number(row.requestCount),
      number(row.promptTokens),
      number(row.completionTokens),
      number(row.totalTokens),
      0,
      updatedAt,
    ]);
  }
  for (const row of data.modelClients) {
    await upsertDimensionClient(db, projectName, 'model', modelDimensionKey(row.requestType, row.provider, row.endpointHost, row.model), row.clientId, activityDate, updatedAt);
  }
  for (const row of data.models) {
    const requestType = normalizeText(row.requestType, 20);
    const provider = normalizeText(row.provider, 80);
    const endpointHost = normalizeText(row.endpointHost, 120);
    const model = normalizeText(row.model, 160);
    await updateDimensionClientCount(
      db,
      'stats_models',
      'client_count',
      'project_name = ? AND request_type = ? AND provider = ? AND endpoint_host = ? AND model = ?',
      [projectName, requestType, provider, endpointHost, model],
      projectName,
      'model',
      modelDimensionKey(requestType, provider, endpointHost, model),
    );
  }

  for (const row of data.resources) {
    await run(db, `
      INSERT INTO stats_resource_clicks (project_name, resource_key, click_count, client_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_name, resource_key) DO UPDATE SET
        click_count = stats_resource_clicks.click_count + excluded.click_count,
        updated_at = excluded.updated_at
    `, [projectName, normalizeText(row.resourceKey, 80), number(row.clickCount), 0, updatedAt]);
  }
  for (const row of data.resourceClients) {
    await upsertDimensionClient(db, projectName, 'resource', resourceDimensionKey(row.resourceKey), row.clientId, activityDate, updatedAt);
  }
  for (const row of data.resources) {
    const resourceKey = normalizeText(row.resourceKey, 80);
    await updateDimensionClientCount(db, 'stats_resource_clicks', 'client_count', 'project_name = ? AND resource_key = ?', [projectName, resourceKey], projectName, 'resource', resourceDimensionKey(resourceKey));
  }

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

export async function rollupStatsDay(env, projectName, activityDate) {
  const db = requireStatsDb(env);
  const existing = await first(db, `
    SELECT status
    FROM stats_rollup_runs
    WHERE project_name = ? AND activity_date = ?
  `, [projectName, activityDate]);
  if (existing?.status === 'success') {
    return { projectName, activityDate, skipped: true };
  }

  const startedAt = nowText();
  await markRollupRunning(db, projectName, activityDate, startedAt);
  try {
    const data = await queryRollupData(env, projectName, activityDate);
    await upsertRollupData(db, projectName, activityDate, data);
    await markRollupSuccess(db, projectName, activityDate, nowText());
    return { projectName, activityDate, skipped: false };
  } catch (error) {
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
