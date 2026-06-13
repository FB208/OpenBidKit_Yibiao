import { CONFIG_USAGE_FIELDS, MODEL_USAGE_FIELDS } from '../constants.js';
import { getBusinessDateDaysAgo, getBusinessToday } from './analyticsRollup.js';

const HISTORY_SOURCES_SQL = "('live', 'backfill')";

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

async function countDailyClients(db, projectName, startDate, endDate = '') {
  const rows = await first(db, `
    SELECT COUNT(DISTINCT client_id) AS count
    FROM analytics_daily_client_activity
    WHERE project_name = ?
      AND activity_date >= ?
      ${endDate ? 'AND activity_date <= ?' : ''}
  `, endDate ? [projectName, startDate, endDate] : [projectName, startDate]);
  return number(rows?.count);
}

async function countNewClients(db, projectName, startDate, endDate = '') {
  const rows = await first(db, `
    SELECT COUNT(*) AS count
    FROM analytics_clients
    WHERE project_name = ?
      AND client_created_date >= ?
      ${endDate ? 'AND client_created_date <= ?' : ''}
  `, endDate ? [projectName, startDate, endDate] : [projectName, startDate]);
  return number(rows?.count);
}

async function queryHistoryTotals(db, projectName) {
  const [eventTotals, clientTotals] = await Promise.all([
    all(db, `
      SELECT
        event,
        SUM(event_count) AS eventCount,
        SUM(prompt_tokens) AS promptTokens,
        SUM(completion_tokens) AS completionTokens,
        SUM(total_tokens) AS totalTokens
      FROM analytics_monthly_event_stats
      WHERE project_name = ? AND source IN ${HISTORY_SOURCES_SQL}
      GROUP BY event
    `, [projectName]),
    first(db, `
      SELECT
        COUNT(*) AS totalClients,
        MIN(first_seen_at) AS firstSeenAt,
        MAX(last_seen_at) AS lastSeenAt
      FROM analytics_clients
      WHERE project_name = ?
    `, [projectName]),
  ]);

  const byEvent = new Map(eventTotals.map((row) => [row.event, row]));
  const getEventCount = (event) => number(byEvent.get(event)?.eventCount);
  return {
    totalClients: number(clientTotals?.totalClients),
    totalEvents: eventTotals.reduce((sum, row) => sum + number(row.eventCount), 0),
    totalOpen: getEventCount('app_open'),
    totalView: getEventCount('page_view'),
    totalConfigUsage: getEventCount('config_usage'),
    totalAiRequests: getEventCount('ai_request'),
    totalResourceClicks: getEventCount('resource_click'),
    totalPromptTokens: eventTotals.reduce((sum, row) => sum + number(row.promptTokens), 0),
    totalCompletionTokens: eventTotals.reduce((sum, row) => sum + number(row.completionTokens), 0),
    totalTokens: eventTotals.reduce((sum, row) => sum + number(row.totalTokens), 0),
    firstSeenAt: clientTotals?.firstSeenAt || '',
    lastSeenAt: clientTotals?.lastSeenAt || '',
  };
}

async function queryDailyRows(db, projectName, startDate) {
  const [daily, dailyClients] = await Promise.all([
    all(db, `
      SELECT activity_date AS date, 'app_open' AS event, SUM(app_open_count) AS count
      FROM analytics_daily_client_activity
      WHERE project_name = ? AND activity_date >= ?
      GROUP BY activity_date
      UNION ALL
      SELECT activity_date AS date, 'page_view' AS event, SUM(page_view_count) AS count
      FROM analytics_daily_client_activity
      WHERE project_name = ? AND activity_date >= ?
      GROUP BY activity_date
      ORDER BY date ASC, event ASC
    `, [projectName, startDate, projectName, startDate]),
    all(db, `
      SELECT activity_date AS date, COUNT(*) AS clients
      FROM analytics_daily_client_activity
      WHERE project_name = ? AND activity_date >= ?
      GROUP BY activity_date
      ORDER BY activity_date ASC
    `, [projectName, startDate]),
  ]);

  return {
    daily: daily.map((row) => ({ ...row, count: number(row.count) })),
    dailyClients: dailyClients.map((row) => ({ ...row, clients: number(row.clients) })),
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
        COALESCE(MAX(totals.client_count), 0) AS clients
      FROM analytics_monthly_page_stats stats
      LEFT JOIN analytics_dimension_values dim_values
        ON dim_values.project_name = stats.project_name
       AND dim_values.dimension_type = 'page'
       AND dim_values.label = stats.page
      LEFT JOIN analytics_dimension_client_totals totals
        ON totals.project_name = dim_values.project_name
       AND totals.dimension_type = dim_values.dimension_type
       AND totals.dimension_key = dim_values.dimension_key
      WHERE stats.project_name = ? AND stats.source IN ${HISTORY_SOURCES_SQL}
      GROUP BY stats.page
      ORDER BY count DESC, clients DESC, stats.page ASC
      LIMIT 100
    `, [projectName]),
    all(db, `
      SELECT
        stats.version,
        SUM(stats.event_count) AS count,
        SUM(stats.app_open_count) AS appOpenCount,
        SUM(stats.page_view_count) AS pageViewCount,
        SUM(stats.config_usage_count) AS configUsageCount,
        SUM(stats.ai_request_count) AS aiRequestCount,
        SUM(stats.resource_click_count) AS resourceClickCount,
        COALESCE(MAX(totals.client_count), 0) AS clients
      FROM analytics_monthly_version_stats stats
      LEFT JOIN analytics_dimension_values dim_values
        ON dim_values.project_name = stats.project_name
       AND dim_values.dimension_type = 'version'
       AND dim_values.label = stats.version
      LEFT JOIN analytics_dimension_client_totals totals
        ON totals.project_name = dim_values.project_name
       AND totals.dimension_type = dim_values.dimension_type
       AND totals.dimension_key = dim_values.dimension_key
      WHERE stats.project_name = ? AND stats.source IN ${HISTORY_SOURCES_SQL}
      GROUP BY stats.version
      ORDER BY stats.version DESC
      LIMIT 100
    `, [projectName]),
    all(db, `
      SELECT last_version AS version, COUNT(*) AS todayClients
      FROM analytics_clients
      WHERE project_name = ? AND last_seen_date = ? AND last_version != ''
      GROUP BY last_version
    `, [projectName, today]),
  ]);

  const todayByVersion = new Map(todayVersions.map((row) => [row.version, number(row.todayClients)]));
  return {
    pages: pages.map((row) => ({
      page: row.page,
      count: number(row.count),
      clients: number(row.clients),
    })),
    versions: versions.map((row) => ({
      version: row.version,
      clients: number(row.clients),
      todayClients: todayByVersion.get(row.version) || 0,
      count: number(row.count),
      appOpenCount: number(row.appOpenCount),
      pageViewCount: number(row.pageViewCount),
      configUsageCount: number(row.configUsageCount),
      aiRequestCount: number(row.aiRequestCount),
      resourceClickCount: number(row.resourceClickCount),
    })),
  };
}

export async function queryD1Overview(env, projectName, days) {
  const db = requireAnalyticsDb(env);
  const today = getBusinessToday();
  const yesterday = getBusinessDateDaysAgo(1);
  const startDate = rangeStart(days);
  const last7Start = getBusinessDateDaysAgo(6);
  const last30Start = getBusinessDateDaysAgo(29);

  const [historyTotals, todayActiveClients, yesterdayActiveClients, wau, mau, activeClients, todayNewClients, newClients, last30NewClients, dailyRows, traffic] = await Promise.all([
    queryHistoryTotals(db, projectName),
    countDailyClients(db, projectName, today, today),
    countDailyClients(db, projectName, yesterday, yesterday),
    countDailyClients(db, projectName, last7Start),
    countDailyClients(db, projectName, last30Start),
    countDailyClients(db, projectName, startDate),
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
    todayActiveClients,
    yesterdayActiveClients,
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
      COALESCE(MAX(totals.client_count), 0) AS clients
    FROM analytics_monthly_config_stats stats
    LEFT JOIN analytics_dimension_values dim_values
      ON dim_values.project_name = stats.project_name
     AND dim_values.dimension_type = 'config'
     AND dim_values.label = stats.field_key || '=' || stats.value
    LEFT JOIN analytics_dimension_client_totals totals
      ON totals.project_name = dim_values.project_name
     AND totals.dimension_type = dim_values.dimension_type
     AND totals.dimension_key = dim_values.dimension_key
    WHERE stats.project_name = ?
      AND stats.source IN ${HISTORY_SOURCES_SQL}
      AND stats.field_key = ?
    GROUP BY stats.value
    ORDER BY clients DESC, events DESC, stats.value ASC
    LIMIT 50
  `, [projectName, field.key]);
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
      COALESCE(MAX(totals.client_count), 0) AS clients
    FROM analytics_monthly_model_stats stats
    LEFT JOIN analytics_dimension_values dim_values
      ON dim_values.project_name = stats.project_name
     AND dim_values.dimension_type = 'model'
     AND dim_values.label = stats.request_type || '|' || stats.provider || '|' || stats.endpoint_host || '|' || stats.model
    LEFT JOIN analytics_dimension_client_totals totals
      ON totals.project_name = dim_values.project_name
     AND totals.dimension_type = dim_values.dimension_type
     AND totals.dimension_key = dim_values.dimension_key
    WHERE stats.project_name = ?
      AND stats.source IN ${HISTORY_SOURCES_SQL}
      AND stats.request_type = ?
    GROUP BY stats.provider, stats.endpoint_host, stats.model
    ORDER BY total_tokens DESC, events DESC, clients DESC, stats.model ASC
    LIMIT 100
  `, [projectName, field.requestType]);
}

export async function queryD1ConfigUsage(env, projectName) {
  const db = requireAnalyticsDb(env);
  const results = await Promise.all([
    ...CONFIG_USAGE_FIELDS.map((field) => queryConfigField(db, projectName, field)),
    ...MODEL_USAGE_FIELDS.map((field) => queryModelField(db, projectName, field)),
  ]);
  const usage = {};

  CONFIG_USAGE_FIELDS.forEach((field, index) => {
    usage[field.key] = (results[index] || []).map((row) => ({
      value: row.value,
      clients: number(row.clients),
      events: number(row.events),
    }));
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
  if (!keys.length) {
    return new Map();
  }

  const placeholders = keys.map(() => '?').join(', ');
  const rows = await all(db, `
    SELECT
      stats.resource_key AS resourceKey,
      SUM(stats.click_count) AS clickCount,
      COALESCE(MAX(totals.client_count), 0) AS clients
    FROM analytics_monthly_resource_stats stats
    LEFT JOIN analytics_dimension_values dim_values
      ON dim_values.project_name = stats.project_name
     AND dim_values.dimension_type = 'resource'
     AND dim_values.label = stats.resource_key
    LEFT JOIN analytics_dimension_client_totals totals
      ON totals.project_name = dim_values.project_name
     AND totals.dimension_type = dim_values.dimension_type
     AND totals.dimension_key = dim_values.dimension_key
    WHERE stats.project_name = ?
      AND stats.source IN ${HISTORY_SOURCES_SQL}
      AND stats.resource_key IN (${placeholders})
    GROUP BY stats.resource_key
  `, [projectName, ...keys]);

  return new Map(rows.map((row) => [row.resourceKey, {
    clickCount: number(row.clickCount),
    clients: number(row.clients),
  }]));
}

export async function queryD1Projects(env) {
  const db = requireAnalyticsDb(env);
  const rows = await all(db, `
    SELECT project_name AS projectName FROM analytics_clients
    UNION
    SELECT project_name AS projectName FROM analytics_monthly_event_stats
    ORDER BY projectName ASC
  `);
  return rows.map((row) => row.projectName).filter(Boolean);
}
