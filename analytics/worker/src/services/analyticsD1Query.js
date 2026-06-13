import { CONFIG_USAGE_FIELDS, MODEL_USAGE_FIELDS } from '../constants.js';
import { getBusinessDateDaysAgo, getBusinessToday } from './analyticsDailyRollup.js';

const SOURCE_SQL = "'rollup'";
const UNKNOWN_VERSION = '未知版本';

function requireAnalyticsDb(env) {
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

function number(value) {
  return Number(value || 0);
}

function rangeStart(days) {
  return getBusinessDateDaysAgo(Math.max(0, Number(days || 1) - 1));
}

async function countActiveClients(db, projectName, startDate, endDate = '') {
  const row = await first(db, `
    SELECT COUNT(*) AS count
    FROM analytics_client_index
    WHERE project_name = ?
      AND last_seen_date >= ?
      ${endDate ? 'AND last_seen_date <= ?' : ''}
  `, endDate ? [projectName, startDate, endDate] : [projectName, startDate]);
  return number(row?.count);
}

async function countNewClients(db, projectName, startDate, endDate = '') {
  const row = await first(db, `
    SELECT COUNT(*) AS count
    FROM analytics_client_index
    WHERE project_name = ?
      AND client_created_date >= ?
      ${endDate ? 'AND client_created_date <= ?' : ''}
  `, endDate ? [projectName, startDate, endDate] : [projectName, startDate]);
  return number(row?.count);
}

async function queryHistoryTotals(db, projectName) {
  const [totals, clients] = await Promise.all([
    first(db, `
      SELECT
        SUM(event_count) AS totalEvents,
        SUM(app_open_count) AS totalOpen,
        SUM(page_view_count) AS totalView,
        SUM(config_usage_count) AS totalConfigUsage,
        SUM(ai_request_count) AS totalAiRequests,
        SUM(resource_click_count) AS totalResourceClicks,
        SUM(prompt_tokens) AS totalPromptTokens,
        SUM(completion_tokens) AS totalCompletionTokens,
        SUM(total_tokens) AS totalTokens,
        MIN(first_seen_at) AS firstSeenAt,
        MAX(last_seen_at) AS lastSeenAt
      FROM analytics_daily_summary
      WHERE project_name = ? AND source = ${SOURCE_SQL}
    `, [projectName]),
    first(db, `
      SELECT COUNT(*) AS totalClients
      FROM analytics_client_index
      WHERE project_name = ?
    `, [projectName]),
  ]);

  return {
    totalClients: number(clients?.totalClients),
    totalEvents: number(totals?.totalEvents),
    totalOpen: number(totals?.totalOpen),
    totalView: number(totals?.totalView),
    totalConfigUsage: number(totals?.totalConfigUsage),
    totalAiRequests: number(totals?.totalAiRequests),
    totalResourceClicks: number(totals?.totalResourceClicks),
    totalPromptTokens: number(totals?.totalPromptTokens),
    totalCompletionTokens: number(totals?.totalCompletionTokens),
    totalTokens: number(totals?.totalTokens),
    firstSeenAt: totals?.firstSeenAt || '',
    lastSeenAt: totals?.lastSeenAt || '',
  };
}

async function queryDailyRows(db, projectName, startDate) {
  const [daily, clients] = await Promise.all([
    all(db, `
      SELECT activity_date AS date, 'app_open' AS event, app_open_count AS count
      FROM analytics_daily_summary
      WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date >= ?
      UNION ALL
      SELECT activity_date AS date, 'page_view' AS event, page_view_count AS count
      FROM analytics_daily_summary
      WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date >= ?
      ORDER BY date ASC, event ASC
    `, [projectName, startDate, projectName, startDate]),
    all(db, `
      SELECT activity_date AS date, active_clients AS clients
      FROM analytics_daily_summary
      WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date >= ?
      ORDER BY activity_date ASC
    `, [projectName, startDate]),
  ]);
  return {
    daily: daily.map((row) => ({ ...row, count: number(row.count) })),
    dailyClients: clients.map((row) => ({ ...row, clients: number(row.clients) })),
  };
}

export async function queryD1Traffic(env, projectName) {
  const db = requireAnalyticsDb(env);
  const today = getBusinessToday();
  const [pages, versions, todayVersions] = await Promise.all([
    all(db, `
      SELECT
        stats.page,
        SUM(stats.view_count) AS count,
        COALESCE(MAX(clients.client_count), 0) AS clients
      FROM analytics_daily_page_stats stats
      LEFT JOIN analytics_dimension_values dim_values
        ON dim_values.project_name = stats.project_name
       AND dim_values.dimension_type = 'page'
       AND dim_values.label = stats.page
      LEFT JOIN (
        SELECT project_name, dimension_type, dimension_key, COUNT(*) AS client_count
        FROM analytics_dimension_client_index
        WHERE project_name = ? AND dimension_type = 'page'
        GROUP BY project_name, dimension_type, dimension_key
      ) clients
        ON clients.project_name = dim_values.project_name
       AND clients.dimension_type = dim_values.dimension_type
       AND clients.dimension_key = dim_values.dimension_key
      WHERE stats.project_name = ? AND stats.source = ${SOURCE_SQL}
      GROUP BY stats.page
      ORDER BY count DESC, clients DESC, stats.page ASC
      LIMIT 100
    `, [projectName, projectName]),
    all(db, `
      SELECT
        stats.version,
        SUM(stats.event_count) AS count,
        SUM(stats.app_open_count) AS appOpenCount,
        SUM(stats.page_view_count) AS pageViewCount,
        SUM(stats.config_usage_count) AS configUsageCount,
        SUM(stats.ai_request_count) AS aiRequestCount,
        SUM(stats.resource_click_count) AS resourceClickCount,
        COALESCE(MAX(clients.client_count), 0) AS clients
      FROM analytics_daily_version_stats stats
      LEFT JOIN analytics_dimension_values dim_values
        ON dim_values.project_name = stats.project_name
       AND dim_values.dimension_type = 'version'
       AND dim_values.label = stats.version
      LEFT JOIN (
        SELECT project_name, dimension_type, dimension_key, COUNT(*) AS client_count
        FROM analytics_dimension_client_index
        WHERE project_name = ? AND dimension_type = 'version'
        GROUP BY project_name, dimension_type, dimension_key
      ) clients
        ON clients.project_name = dim_values.project_name
       AND clients.dimension_type = dim_values.dimension_type
       AND clients.dimension_key = dim_values.dimension_key
      WHERE stats.project_name = ? AND stats.source = ${SOURCE_SQL}
      GROUP BY stats.version
      ORDER BY stats.version DESC
      LIMIT 100
    `, [projectName, projectName]),
    all(db, `
      SELECT version, client_count AS todayClients
      FROM analytics_daily_version_stats
      WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date = ?
    `, [projectName, today]),
  ]);

  const todayByVersion = new Map(todayVersions.map((row) => [row.version || UNKNOWN_VERSION, number(row.todayClients)]));
  const versionRows = versions.map((row) => ({
    version: row.version || UNKNOWN_VERSION,
    clients: number(row.clients),
    todayClients: todayByVersion.get(row.version || UNKNOWN_VERSION) || 0,
    count: number(row.count),
    appOpenCount: number(row.appOpenCount),
    pageViewCount: number(row.pageViewCount),
    configUsageCount: number(row.configUsageCount),
    aiRequestCount: number(row.aiRequestCount),
    resourceClickCount: number(row.resourceClickCount),
  }));
  const existing = new Set(versionRows.map((row) => row.version));
  for (const [version, todayClients] of todayByVersion.entries()) {
    if (!existing.has(version)) {
      versionRows.push({ version, clients: todayClients, todayClients, count: 0 });
    }
  }

  return {
    pages: pages.map((row) => ({ page: row.page, count: number(row.count), clients: number(row.clients) })),
    versions: versionRows,
  };
}

export async function queryD1Overview(env, projectName, days) {
  const db = requireAnalyticsDb(env);
  const today = getBusinessToday();
  const yesterday = getBusinessDateDaysAgo(1);
  const startDate = rangeStart(days);
  const last7Start = getBusinessDateDaysAgo(6);
  const last30Start = getBusinessDateDaysAgo(29);

  const [historyTotals, todayRow, yesterdayRow, wau, mau, activeClients, todayNewClients, newClients, last30NewClients, dailyRows, traffic] = await Promise.all([
    queryHistoryTotals(db, projectName),
    first(db, `SELECT active_clients AS count FROM analytics_daily_summary WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date = ?`, [projectName, today]),
    first(db, `SELECT active_clients AS count FROM analytics_daily_summary WHERE project_name = ? AND source = ${SOURCE_SQL} AND activity_date = ?`, [projectName, yesterday]),
    countActiveClients(db, projectName, last7Start),
    countActiveClients(db, projectName, last30Start),
    countActiveClients(db, projectName, startDate),
    countNewClients(db, projectName, today, today),
    countNewClients(db, projectName, startDate),
    countNewClients(db, projectName, last30Start),
    queryDailyRows(db, projectName, startDate),
    queryD1Traffic(env, projectName),
  ]);

  return {
    code: 0,
    projectName,
    days,
    range: 'history',
    source: 'd1',
    ...historyTotals,
    todayActiveClients: number(todayRow?.count),
    yesterdayActiveClients: number(yesterdayRow?.count),
    wau,
    mau,
    activeClients,
    todayNewClients,
    newClients,
    last30NewClients,
    returningClients: Math.max(0, activeClients - newClients),
    ...dailyRows,
    pages: traffic.pages,
    versions: traffic.versions,
  };
}

async function queryConfigField(db, projectName, field) {
  return all(db, `
    SELECT
      stats.value AS value,
      SUM(stats.report_count) AS events,
      COALESCE(MAX(clients.client_count), 0) AS clients
    FROM analytics_daily_config_stats stats
    LEFT JOIN analytics_dimension_values dim_values
      ON dim_values.project_name = stats.project_name
     AND dim_values.dimension_type = 'config'
     AND dim_values.label = stats.field_key || '=' || stats.value
    LEFT JOIN (
      SELECT project_name, dimension_type, dimension_key, COUNT(*) AS client_count
      FROM analytics_dimension_client_index
      WHERE project_name = ? AND dimension_type = 'config'
      GROUP BY project_name, dimension_type, dimension_key
    ) clients
      ON clients.project_name = dim_values.project_name
     AND clients.dimension_type = dim_values.dimension_type
     AND clients.dimension_key = dim_values.dimension_key
    WHERE stats.project_name = ? AND stats.source = ${SOURCE_SQL} AND stats.field_key = ?
    GROUP BY stats.value
    ORDER BY clients DESC, events DESC, stats.value ASC
    LIMIT 50
  `, [projectName, projectName, field.key]);
}

async function queryModelField(db, projectName, field) {
  return all(db, `
    SELECT
      stats.provider AS provider,
      stats.endpoint_host AS endpoint_host,
      stats.model AS model,
      SUM(stats.request_count) AS events,
      SUM(stats.prompt_tokens) AS prompt_tokens,
      SUM(stats.completion_tokens) AS completion_tokens,
      SUM(stats.total_tokens) AS total_tokens,
      COALESCE(MAX(clients.client_count), 0) AS clients
    FROM analytics_daily_model_stats stats
    LEFT JOIN analytics_dimension_values dim_values
      ON dim_values.project_name = stats.project_name
     AND dim_values.dimension_type = 'model'
     AND dim_values.label = stats.request_type || '|' || stats.provider || '|' || stats.endpoint_host || '|' || stats.model
    LEFT JOIN (
      SELECT project_name, dimension_type, dimension_key, COUNT(*) AS client_count
      FROM analytics_dimension_client_index
      WHERE project_name = ? AND dimension_type = 'model'
      GROUP BY project_name, dimension_type, dimension_key
    ) clients
      ON clients.project_name = dim_values.project_name
     AND clients.dimension_type = dim_values.dimension_type
     AND clients.dimension_key = dim_values.dimension_key
    WHERE stats.project_name = ? AND stats.source = ${SOURCE_SQL} AND stats.request_type = ?
    GROUP BY stats.provider, stats.endpoint_host, stats.model
    ORDER BY total_tokens DESC, events DESC, clients DESC, stats.model ASC
    LIMIT 100
  `, [projectName, projectName, field.requestType]);
}

export async function queryD1ConfigUsage(env, projectName) {
  const db = requireAnalyticsDb(env);
  const results = await Promise.all([
    ...CONFIG_USAGE_FIELDS.map((field) => queryConfigField(db, projectName, field)),
    ...MODEL_USAGE_FIELDS.map((field) => queryModelField(db, projectName, field)),
  ]);
  const usage = {};
  CONFIG_USAGE_FIELDS.forEach((field, index) => {
    usage[field.key] = (results[index] || []).map((row) => ({ value: row.value, clients: number(row.clients), events: number(row.events) }));
  });
  MODEL_USAGE_FIELDS.forEach((field, index) => {
    usage[field.key] = (results[CONFIG_USAGE_FIELDS.length + index] || []).map((row) => ({
      provider: row.provider,
      endpoint_host: row.endpoint_host,
      model: row.model,
      clients: number(row.clients),
      events: number(row.events),
      prompt_tokens: number(row.prompt_tokens),
      completion_tokens: number(row.completion_tokens),
      total_tokens: number(row.total_tokens),
    }));
  });
  return usage;
}

export async function queryD1ResourceClickCounts(env, projectName, resourceKeys = []) {
  const db = requireAnalyticsDb(env);
  const keys = Array.from(new Set(resourceKeys.filter(Boolean)));
  if (!keys.length) return new Map();

  const placeholders = keys.map(() => '?').join(', ');
  const rows = await all(db, `
    SELECT resource_key AS resourceKey, SUM(click_count) AS clickCount, MAX(client_count) AS clients
    FROM analytics_daily_resource_stats
    WHERE project_name = ? AND source = ${SOURCE_SQL} AND resource_key IN (${placeholders})
    GROUP BY resource_key
  `, [projectName, ...keys]);
  return new Map(rows.map((row) => [row.resourceKey, { clickCount: number(row.clickCount), clients: number(row.clients) }]));
}

export async function queryD1Projects(env) {
  const db = requireAnalyticsDb(env);
  const rows = await all(db, `
    SELECT project_name AS projectName FROM analytics_client_index
    UNION
    SELECT project_name AS projectName FROM analytics_daily_summary
    ORDER BY projectName ASC
  `);
  return rows.map((row) => row.projectName).filter(Boolean);
}
