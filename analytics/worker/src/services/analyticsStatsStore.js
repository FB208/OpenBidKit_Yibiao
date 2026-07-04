import { AGENT_RUNTIME_STATUSES, ALLOWED_EVENTS, CONFIG_USAGE_FIELDS, DATASET, MODEL_USAGE_FIELDS } from '../constants.js';
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
const DEFAULT_RETENTION_RANGE_DAYS = 30;
const RETENTION_DAYS = [1, 3, 7];
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

function clientLicenseAttemptKey(event, shouldInsert) {
  return [
    event.projectName,
    event.clientId,
    shouldInsert ? event.clientCreatedAt : '',
    event.licenseStatus || '',
    event.licensePlan || '',
    event.licenseExpiresAt || '',
    event.sourceTrusted || '',
    event.untrustedReason || '',
  ].join('\0');
}

function hasClientLicenseSnapshot(event) {
  return Boolean(
    event.licenseStatus
    || event.licensePlan
    || event.licenseExpiresAt
    || event.sourceTrusted
    || event.untrustedReason,
  );
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

function agentRuntimeStatusesSql() {
  return `(${Array.from(AGENT_RUNTIME_STATUSES).map((status) => sqlString(status)).join(', ')})`;
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
  const shouldInsert = shouldAttemptRealtimeClientInsert(event);
  const shouldUpdateLicense = hasClientLicenseSnapshot(event);
  if (!shouldInsert && !shouldUpdateLicense) {
    return;
  }

  const cacheKey = shouldUpdateLicense
    ? clientLicenseAttemptKey(event, shouldInsert)
    : clientAttemptKey(event.projectName, event.clientId);
  if (recentClientWriteAttempts.has(cacheKey)) {
    return;
  }
  rememberClientAttempt(cacheKey);

  const db = requireStatsDb(env);
  const updatedAt = nowText();

  if (shouldInsert) {
    const result = await run(db, `
      INSERT INTO stats_clients (
        project_name, client_id, first_seen_at, first_seen_date, active_days,
        last_active_date, last_active_version, last_access_ip, platform, arch,
        license_status, license_plan, license_expires_at, source_trusted, untrusted_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, client_id) DO NOTHING
    `, [
      event.projectName,
      event.clientId,
      updatedAt,
      event.clientCreatedAt,
      event.clientIp || '',
      event.platform || '',
      event.arch || '',
      event.licenseStatus || '',
      event.licensePlan || '',
      event.licenseExpiresAt || '',
      event.sourceTrusted || '',
      event.untrustedReason || '',
      updatedAt,
      updatedAt,
    ]);
    if (result?.meta?.changes) {
      await ensureTotals(db, event.projectName, updatedAt);
      await run(db, `
        UPDATE stats_totals
        SET total_clients = total_clients + 1, updated_at = ?
        WHERE project_name = ?
      `, [updatedAt, event.projectName]);
      return;
    }
  }

  if (!shouldUpdateLicense) {
    return;
  }

  await run(db, `
    UPDATE stats_clients
    SET
      license_status = CASE WHEN ? != '' THEN ? ELSE license_status END,
      license_plan = CASE WHEN ? != '' THEN ? ELSE license_plan END,
      license_expires_at = CASE WHEN ? != '' THEN ? ELSE license_expires_at END,
      source_trusted = CASE WHEN ? != '' THEN ? ELSE source_trusted END,
      untrusted_reason = CASE WHEN ? != '' THEN ? ELSE untrusted_reason END,
      updated_at = ?
    WHERE project_name = ? AND client_id = ?
  `, [
    event.licenseStatus || '',
    event.licenseStatus || '',
    event.licensePlan || '',
    event.licensePlan || '',
    event.licenseExpiresAt || '',
    event.licenseExpiresAt || '',
    event.sourceTrusted || '',
    event.sourceTrusted || '',
    event.untrustedReason || '',
    event.untrustedReason || '',
    updatedAt,
    event.projectName,
    event.clientId,
  ]);
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
      last_access_ip AS lastAccessIp,
      license_status AS licenseStatus,
      license_plan AS licensePlan,
      license_expires_at AS licenseExpiresAt,
      source_trusted AS sourceTrusted,
      untrusted_reason AS untrustedReason
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
    licenseStatus: row.licenseStatus || '',
    licensePlan: row.licensePlan || '',
    licenseExpiresAt: row.licenseExpiresAt || '',
    sourceTrusted: row.sourceTrusted || '',
    untrustedReason: row.untrustedReason || '',
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

function createAgentRuntimeSummary(rows = []) {
  const counts = { success: 0, failed: 0 };
  for (const row of rows || []) {
    const status = normalizeText(row.status, 20);
    if (!AGENT_RUNTIME_STATUSES.has(status)) continue;
    counts[status] += number(row.count ?? row.runCount ?? row.run_count);
  }
  const totalCount = counts.success + counts.failed;
  return {
    successCount: counts.success,
    failedCount: counts.failed,
    totalCount,
    successRate: totalCount > 0 ? counts.success / totalCount : 0,
  };
}

export async function queryStatsAgentRuntime(env, projectName, range) {
  if (range === 'history') {
    const rows = await all(requireStatsDb(env), `
      SELECT status, run_count AS count
      FROM stats_agent_runtime
      WHERE project_name = ? AND status IN ('success', 'failed')
    `, [projectName]);
    return createAgentRuntimeSummary(rows);
  }

  const project = sqlString(projectName);
  const result = await queryAnalytics(env, `
    SELECT
      blob9 AS status,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'agent_runtime'
      AND blob9 IN ${agentRuntimeStatusesSql()}
      AND ${aeRangeCondition(range)}
    GROUP BY status
    ORDER BY status ASC
    LIMIT 10
  `);
  return createAgentRuntimeSummary(result.data || []);
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

export async function queryStatsRetention(env, projectName) {
  const db = requireStatsDb(env);
  const normalizedRangeDays = DEFAULT_RETENTION_RANGE_DAYS;
  const latest = await first(db, `
    SELECT MAX(snapshot_date) AS snapshotDate
    FROM stats_retention
    WHERE project_name = ? AND range_days = ?
  `, [projectName, normalizedRangeDays]);
  const snapshotDate = latest?.snapshotDate || '';
  if (!snapshotDate) {
    return {
      code: 0,
      projectName,
      days: normalizedRangeDays,
      snapshotDate: '',
      source: 'd1',
      retention: RETENTION_DAYS.map((day) => ({
        day: `D${day}`,
        cohortClients: 0,
        retainedClients: 0,
        retentionRate: 0,
      })),
    };
  }

  const rows = await all(db, `
    SELECT retention_day AS retentionDay, cohort_clients AS cohortClients, retained_clients AS retainedClients
    FROM stats_retention
    WHERE project_name = ? AND snapshot_date = ? AND range_days = ?
    ORDER BY retention_day ASC
  `, [projectName, snapshotDate, normalizedRangeDays]);
  const rowByDay = new Map(rows.map((row) => [number(row.retentionDay), row]));

  return {
    code: 0,
    projectName,
    days: normalizedRangeDays,
    snapshotDate,
    source: 'd1',
    retention: RETENTION_DAYS.map((day) => {
      const row = rowByDay.get(day) || {};
      const cohortClients = number(row.cohortClients);
      const retainedClients = number(row.retainedClients);
      return {
        day: `D${day}`,
        cohortClients,
        retainedClients,
        retentionRate: cohortClients > 0 ? retainedClients / cohortClients : 0,
      };
    }),
  };
}

export const ROLLUP_CRON_STAGES = [
  { cron: '0 17 * * *', stages: ['discover', 'daily'], beijingTime: '01:00', description: '发现昨日项目，写入每日总量和概览累计值' },
  { cron: '30 17 * * *', stages: ['clients'], beijingTime: '01:30', description: '写入客户端生命周期和最后访问信息' },
  { cron: '0 18 * * *', stages: ['pages', 'versions'], beijingTime: '02:00', description: '写入页面访问累计值，写入版本事件量并刷新版本客户端数' },
  { cron: '30 18 * * *', stages: ['configs', 'models', 'agents'], beijingTime: '02:30', description: '写入配置使用、模型请求、Agent 执行和 Total Tokens 累计值' },
  { cron: '0 19 * * *', stages: ['retention', 'resources'], beijingTime: '03:00', description: '写入留存快照，重算资源历史点击量并完成整日汇总' },
];

const ROLLUP_STAGE_ORDER = ['discover', 'daily', 'clients', 'pages', 'versions', 'configs', 'models', 'agents', 'retention', 'resources'];
const ROLLUP_STAGES_BY_CRON = new Map(ROLLUP_CRON_STAGES.map((item) => [item.cron, item.stages]));
const BULK_JSON_MAX_LENGTH = 700000;

function normalizeProjectName(value) {
  return normalizeText(value, 80);
}

function uniqueProjectNames(projectNames) {
  return Array.from(new Set((projectNames || []).map(normalizeProjectName).filter(Boolean))).sort();
}

function projectsSql(projectNames) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) {
    return "('__no_rollup_project__')";
  }
  return `(${projects.map((projectName) => sqlString(projectName)).join(', ')})`;
}

function rowsJson(rows) {
  return JSON.stringify(rows || []);
}

function chunkRows(rows) {
  const chunks = [];
  let chunk = [];
  let chunkLength = 2;

  for (const row of rows || []) {
    const item = JSON.stringify(row);
    if (item.length + 2 > BULK_JSON_MAX_LENGTH) {
      throw new Error(`rollup row is too large: ${item.length}`);
    }
    if (chunk.length && chunkLength + item.length + 1 > BULK_JSON_MAX_LENGTH) {
      chunks.push(chunk);
      chunk = [];
      chunkLength = 2;
    }
    chunk.push(row);
    chunkLength += item.length + 1;
  }

  if (chunk.length) {
    chunks.push(chunk);
  }
  return chunks;
}

function groupRowsByProject(rows, projectNames) {
  const grouped = new Map(uniqueProjectNames(projectNames).map((projectName) => [projectName, []]));
  for (const row of rows || []) {
    const projectName = normalizeProjectName(row.projectName);
    if (!projectName || !grouped.has(projectName)) continue;
    grouped.get(projectName).push(row);
  }
  return grouped;
}

function completedSetFor(completedByProject, projectName) {
  if (!completedByProject.has(projectName)) {
    completedByProject.set(projectName, new Set());
  }
  return completedByProject.get(projectName);
}

function isRollupStageCompleted(completedByProject, projectName, stage) {
  const completed = completedSetFor(completedByProject, projectName);
  if (stage === 'clients') {
    return completed.has('clients') && completed.has('clients:activity');
  }
  return completed.has(stage);
}

async function batchRun(db, statements) {
  if (!statements.length) return [];
  if (typeof db.batch === 'function') {
    return await db.batch(statements);
  }

  const results = [];
  for (const statement of statements) {
    results.push(await statement.run());
  }
  return results;
}

async function queryRollupProjects(env, activityDate) {
  const result = await queryAnalytics(env, `
    SELECT blob1 AS projectName
    FROM ${DATASET}
    WHERE blob1 != ''
      AND blob2 IN ${allowedEventsSql()}
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName
    ORDER BY projectName ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return uniqueProjectNames((result.data || []).map((row) => row.projectName));
}

async function listRollupRuns(db, activityDate) {
  return await all(db, `
    SELECT project_name AS projectName, status
    FROM stats_rollup_runs
    WHERE activity_date = ?
    ORDER BY project_name ASC
  `, [activityDate]);
}

async function queryCompletedStages(db, activityDate) {
  const rows = await all(db, `
    SELECT project_name AS projectName, stage
    FROM stats_rollup_stages
    WHERE activity_date = ? AND status = 'success'
  `, [activityDate]);
  const completed = new Map();
  for (const row of rows) {
    const projectName = normalizeProjectName(row.projectName);
    const stage = normalizeText(row.stage, 80);
    if (!projectName || !stage) continue;
    completedSetFor(completed, projectName).add(stage);
  }
  return completed;
}

function prepareProjectsStageSuccessStatement(db, projectNames, activityDate, stage, updatedAt) {
  return db.prepare(`
    WITH rows AS (
      SELECT json_extract(item.value, '$.projectName') AS project_name
      FROM json_each(?) AS item
    )
    INSERT INTO stats_rollup_stages (project_name, activity_date, stage, status, started_at, completed_at, error)
    SELECT project_name, ?, ?, 'success', ?, ?, ''
    FROM rows
    WHERE project_name != ''
    ON CONFLICT(project_name, activity_date, stage) DO UPDATE SET
      status = 'success',
      completed_at = excluded.completed_at,
      error = ''
  `).bind(rowsJson(uniqueProjectNames(projectNames).map((projectName) => ({ projectName }))), activityDate, stage, updatedAt, updatedAt);
}

function prepareProjectStageSuccessStatement(db, projectName, activityDate, stage, updatedAt) {
  return db.prepare(`
    INSERT INTO stats_rollup_stages (project_name, activity_date, stage, status, started_at, completed_at, error)
    VALUES (?, ?, ?, 'success', ?, ?, '')
    ON CONFLICT(project_name, activity_date, stage) DO UPDATE SET
      status = 'success',
      completed_at = excluded.completed_at,
      error = ''
  `).bind(projectName, activityDate, stage, updatedAt, updatedAt);
}

async function markProjectsStageSuccess(db, projectNames, activityDate, stage) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) return;
  await prepareProjectsStageSuccessStatement(db, projects, activityDate, stage, nowText()).run();
}

async function markProjectsStageFailed(db, projectNames, activityDate, stage, error) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) return;
  await run(db, `
    WITH rows AS (
      SELECT json_extract(item.value, '$.projectName') AS project_name
      FROM json_each(?) AS item
    )
    INSERT INTO stats_rollup_stages (project_name, activity_date, stage, status, started_at, completed_at, error)
    SELECT project_name, ?, ?, 'failed', ?, ?, ?
    FROM rows
    WHERE project_name != ''
    ON CONFLICT(project_name, activity_date, stage) DO UPDATE SET
      status = 'failed',
      completed_at = excluded.completed_at,
      error = excluded.error
  `, [
    rowsJson(projects.map((projectName) => ({ projectName }))),
    activityDate,
    stage,
    nowText(),
    nowText(),
    normalizeText(error?.message || String(error), 1000),
  ]);
}

async function upsertRollupRuns(db, projectNames, activityDate) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) return;
  const updatedAt = nowText();
  await run(db, `
    WITH rows AS (
      SELECT json_extract(item.value, '$.projectName') AS project_name
      FROM json_each(?) AS item
    )
    INSERT INTO stats_rollup_runs (project_name, activity_date, status, started_at, completed_at, error)
    SELECT project_name, ?, 'running', ?, '', ''
    FROM rows
    WHERE project_name != ''
    ON CONFLICT(project_name, activity_date) DO UPDATE SET
      status = CASE WHEN stats_rollup_runs.status = 'success' THEN stats_rollup_runs.status ELSE 'running' END,
      started_at = CASE WHEN stats_rollup_runs.status = 'success' THEN stats_rollup_runs.started_at ELSE excluded.started_at END,
      completed_at = CASE WHEN stats_rollup_runs.status = 'success' THEN stats_rollup_runs.completed_at ELSE '' END,
      error = CASE WHEN stats_rollup_runs.status = 'success' THEN stats_rollup_runs.error ELSE '' END
  `, [rowsJson(projects.map((projectName) => ({ projectName }))), activityDate, updatedAt]);
}

async function markRollupRunsSuccess(db, projectNames, activityDate) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) return;
  await run(db, `
    WITH rows AS (
      SELECT json_extract(item.value, '$.projectName') AS project_name
      FROM json_each(?) AS item
    )
    UPDATE stats_rollup_runs
    SET status = 'success', completed_at = ?, error = ''
    WHERE activity_date = ?
      AND project_name IN (SELECT project_name FROM rows)
  `, [rowsJson(projects.map((projectName) => ({ projectName }))), nowText(), activityDate]);
}

async function markRollupRunsFailed(db, projectNames, activityDate, error) {
  const projects = uniqueProjectNames(projectNames);
  if (!projects.length) return;
  await run(db, `
    WITH rows AS (
      SELECT json_extract(item.value, '$.projectName') AS project_name
      FROM json_each(?) AS item
    )
    UPDATE stats_rollup_runs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE activity_date = ?
      AND status != 'success'
      AND project_name IN (SELECT project_name FROM rows)
  `, [rowsJson(projects.map((projectName) => ({ projectName }))), nowText(), normalizeText(error?.message || String(error), 1000), activityDate]);
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

async function runDiscoveryStage(env, activityDate, options = {}) {
  const db = requireStatsDb(env);
  const projects = options.projectNames ? uniqueProjectNames(options.projectNames) : await queryRollupProjects(env, activityDate);
  if (!projects.length) {
    return { activityDate, stage: 'discover', projects: [] };
  }
  await upsertRollupRuns(db, projects, activityDate);
  await markProjectsStageSuccess(db, projects, activityDate, 'discover');
  return { activityDate, stage: 'discover', projects: projects.map((projectName) => ({ projectName, skipped: false })) };
}

async function ensureRollupProjects(env, activityDate) {
  const db = requireStatsDb(env);
  const existingRuns = await listRollupRuns(db, activityDate);
  if (existingRuns.length) {
    return uniqueProjectNames(existingRuns.filter((row) => row.status !== 'success').map((row) => row.projectName));
  }
  const result = await runDiscoveryStage(env, activityDate);
  return uniqueProjectNames(result.projects.map((row) => row.projectName));
}

async function executeProjectStageChunks(db, completedByProject, projectName, activityDate, stage, rows, prepareStatements) {
  const completed = completedSetFor(completedByProject, projectName);
  if (completed.has(stage)) {
    return { projectName, skipped: true };
  }

  const chunks = chunkRows(rows);
  let completedChunks = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkStage = `${stage}:chunk:${index}`;
    if (completed.has(chunkStage)) {
      continue;
    }
    const updatedAt = nowText();
    await batchRun(db, [
      ...prepareStatements(db, chunks[index], updatedAt),
      prepareProjectStageSuccessStatement(db, projectName, activityDate, chunkStage, updatedAt),
    ]);
    completed.add(chunkStage);
    completedChunks += 1;
  }

  await prepareProjectStageSuccessStatement(db, projectName, activityDate, stage, nowText()).run();
  completed.add(stage);
  return { projectName, skipped: false, chunks: completedChunks };
}

async function queryRollupDailyRows(env, activityDate, projectNames) {
  const dateWhere = businessDateCondition(activityDate);
  const projectWhere = projectsSql(projectNames);
  const [summary, activeClients] = await Promise.all([
    queryAnalytics(env, `
      SELECT
        blob1 AS projectName,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${DATASET}
      WHERE blob1 IN ${projectWhere}
        AND blob2 IN ${allowedEventsSql()}
        AND ${dateWhere}
      GROUP BY projectName
      ORDER BY projectName ASC
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT blob1 AS projectName, COUNT(DISTINCT blob7) AS activeClients
      FROM ${DATASET}
      WHERE blob1 IN ${projectWhere}
        AND blob2 IN ${allowedEventsSql()}
        AND blob7 != ''
        AND ${dateWhere}
      GROUP BY projectName
      ORDER BY projectName ASC
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
  ]);

  const activeByProject = new Map((activeClients.data || []).map((row) => [normalizeProjectName(row.projectName), number(row.activeClients)]));
  const summaryByProject = new Map((summary.data || []).map((row) => [normalizeProjectName(row.projectName), row]));
  return uniqueProjectNames(projectNames).map((projectName) => {
    const row = summaryByProject.get(projectName) || {};
    return {
      projectName,
      activityDate,
      activeClients: activeByProject.get(projectName) || 0,
      appOpenCount: number(row.appOpenCount),
      pageViewCount: number(row.pageViewCount),
      eventCount: number(row.eventCount),
      aiRequestCount: number(row.aiRequestCount),
    };
  });
}

function prepareDailyStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [
    db.prepare(`
      WITH rows AS (
        SELECT json_extract(item.value, '$.projectName') AS project_name
        FROM json_each(?) AS item
      )
      INSERT INTO stats_totals (project_name, total_clients, total_open, total_page_views, total_events, total_ai_requests, last_rollup_date, updated_at)
      SELECT project_name, 0, 0, 0, 0, 0, '', ?
      FROM rows
      WHERE project_name != ''
      ON CONFLICT(project_name) DO NOTHING
    `).bind(json, updatedAt),
    db.prepare(`
      WITH rows AS (
        SELECT
          json_extract(item.value, '$.projectName') AS project_name,
          json_extract(item.value, '$.activityDate') AS activity_date,
          CAST(json_extract(item.value, '$.activeClients') AS INTEGER) AS active_clients,
          CAST(json_extract(item.value, '$.appOpenCount') AS INTEGER) AS app_open_count,
          CAST(json_extract(item.value, '$.pageViewCount') AS INTEGER) AS page_view_count,
          CAST(json_extract(item.value, '$.eventCount') AS INTEGER) AS event_count,
          CAST(json_extract(item.value, '$.aiRequestCount') AS INTEGER) AS ai_request_count
        FROM json_each(?) AS item
      )
      INSERT INTO stats_daily (project_name, activity_date, active_clients, app_open_count, page_view_count, event_count, ai_request_count, updated_at)
      SELECT project_name, activity_date, active_clients, app_open_count, page_view_count, event_count, ai_request_count, ?
      FROM rows
      WHERE project_name != ''
      ON CONFLICT(project_name, activity_date) DO UPDATE SET
        active_clients = excluded.active_clients,
        app_open_count = excluded.app_open_count,
        page_view_count = excluded.page_view_count,
        event_count = excluded.event_count,
        ai_request_count = excluded.ai_request_count,
        updated_at = excluded.updated_at
    `).bind(json, updatedAt),
    db.prepare(`
      WITH rows AS (
        SELECT
          json_extract(item.value, '$.projectName') AS project_name,
          json_extract(item.value, '$.activityDate') AS activity_date,
          CAST(json_extract(item.value, '$.appOpenCount') AS INTEGER) AS app_open_count,
          CAST(json_extract(item.value, '$.pageViewCount') AS INTEGER) AS page_view_count,
          CAST(json_extract(item.value, '$.eventCount') AS INTEGER) AS event_count,
          CAST(json_extract(item.value, '$.aiRequestCount') AS INTEGER) AS ai_request_count
        FROM json_each(?) AS item
      )
      UPDATE stats_totals
      SET
        total_open = total_open + (SELECT app_open_count FROM rows WHERE rows.project_name = stats_totals.project_name),
        total_page_views = total_page_views + (SELECT page_view_count FROM rows WHERE rows.project_name = stats_totals.project_name),
        total_events = total_events + (SELECT event_count FROM rows WHERE rows.project_name = stats_totals.project_name),
        total_ai_requests = total_ai_requests + (SELECT ai_request_count FROM rows WHERE rows.project_name = stats_totals.project_name),
        last_rollup_date = CASE
          WHEN last_rollup_date < (SELECT activity_date FROM rows WHERE rows.project_name = stats_totals.project_name)
            THEN (SELECT activity_date FROM rows WHERE rows.project_name = stats_totals.project_name)
          ELSE last_rollup_date
        END,
        updated_at = ?
      WHERE project_name IN (SELECT project_name FROM rows)
    `).bind(json, updatedAt),
  ];
}

async function runDailyStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const rows = await queryRollupDailyRows(env, activityDate, projectNames);
  const grouped = groupRowsByProject(rows, projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    results.push(await executeProjectStageChunks(db, completedByProject, projectName, activityDate, 'daily', grouped.get(projectName) || [], prepareDailyStatements));
  }
  return results;
}

async function queryRollupClientRows(env, activityDate, projectNames) {
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const result = await queryAnalytics(env, `
    SELECT
      blob1 AS projectName,
      blob7 AS clientId,
      ${businessDateTimeSqlExpression('min(timestamp)')} AS firstSeenAt,
      argMax(${versionExpr}, timestamp) AS lastVersion,
      argMax(blob13, timestamp) AS lastAccessIp,
      argMax(blob5, timestamp) AS platform,
      argMax(blob6, timestamp) AS arch,
      argMax(blob14, timestamp) AS licenseStatus,
      argMax(blob15, timestamp) AS licensePlan,
      argMax(blob16, timestamp) AS licenseExpiresAt,
      argMax(blob17, timestamp) AS sourceTrusted,
      argMax(blob18, timestamp) AS untrustedReason
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 IN ${allowedEventsSql()}
      AND blob7 != ''
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, clientId
    ORDER BY projectName ASC, clientId ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    clientId: normalizeText(row.clientId, 120),
    firstSeenAt: String(row.firstSeenAt || `${activityDate} 00:00:00`),
    firstSeenDate: activityDate,
    lastActiveDate: activityDate,
    lastVersion: normalizedVersion(row.lastVersion),
    lastAccessIp: normalizeText(row.lastAccessIp, 80),
    platform: normalizeText(row.platform, 50),
    arch: normalizeText(row.arch, 50),
    licenseStatus: normalizeText(row.licenseStatus, 30),
    licensePlan: normalizeText(row.licensePlan, 40),
    licenseExpiresAt: normalizeText(row.licenseExpiresAt, 20).slice(0, 10),
    sourceTrusted: normalizeText(row.sourceTrusted, 20),
    untrustedReason: normalizeText(row.untrustedReason, 80),
  })).filter((row) => row.projectName && row.clientId);
}

async function queryRollupClientActivityRows(env, startDate, endDate, projectNames) {
  const dateWhere = startDate === endDate
    ? businessDateCondition(endDate)
    : businessDateRangeCondition(startDate, endDate);
  const result = await queryAnalytics(env, `
    SELECT
      blob1 AS projectName,
      ${businessDateSqlExpression()} AS activityDate,
      blob7 AS clientId,
      argMin(blob8, timestamp) AS clientCreatedDate
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND blob8 != ''
      AND ${dateWhere}
    GROUP BY projectName, activityDate, clientId
    ORDER BY projectName ASC, activityDate ASC, clientId ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    activityDate: normalizeText(row.activityDate, 10),
    clientId: normalizeText(row.clientId, 120),
    clientCreatedDate: normalizeText(row.clientCreatedDate, 20).slice(0, 10),
  })).filter((row) => row.projectName && row.activityDate && row.clientId && row.clientCreatedDate);
}

function prepareClientStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.clientId') AS client_id,
        json_extract(item.value, '$.firstSeenAt') AS first_seen_at,
        json_extract(item.value, '$.firstSeenDate') AS first_seen_date,
        json_extract(item.value, '$.lastActiveDate') AS last_active_date,
        json_extract(item.value, '$.lastVersion') AS last_active_version,
        json_extract(item.value, '$.lastAccessIp') AS last_access_ip,
        json_extract(item.value, '$.platform') AS platform,
        json_extract(item.value, '$.arch') AS arch,
        json_extract(item.value, '$.licenseStatus') AS license_status,
        json_extract(item.value, '$.licensePlan') AS license_plan,
        json_extract(item.value, '$.licenseExpiresAt') AS license_expires_at,
        json_extract(item.value, '$.sourceTrusted') AS source_trusted,
        json_extract(item.value, '$.untrustedReason') AS untrusted_reason
      FROM json_each(?) AS item
    )
    INSERT INTO stats_clients (
      project_name, client_id, first_seen_at, first_seen_date, active_days,
      last_active_date, last_active_version, last_access_ip, platform, arch,
      license_status, license_plan, license_expires_at, source_trusted, untrusted_reason,
      created_at, updated_at
    )
    SELECT project_name, client_id, first_seen_at, first_seen_date, 1, last_active_date, last_active_version, last_access_ip, platform, arch,
      license_status, license_plan, license_expires_at, source_trusted, untrusted_reason, ?, ?
    FROM rows
    WHERE project_name != '' AND client_id != ''
    ON CONFLICT(project_name, client_id) DO UPDATE SET
      active_days = stats_clients.active_days + 1,
      last_active_date = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_date ELSE stats_clients.last_active_date END,
      last_active_version = CASE WHEN excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_active_version ELSE stats_clients.last_active_version END,
      last_access_ip = CASE WHEN excluded.last_access_ip != '' AND excluded.last_active_date >= stats_clients.last_active_date THEN excluded.last_access_ip ELSE stats_clients.last_access_ip END,
      platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE stats_clients.platform END,
      arch = CASE WHEN excluded.arch != '' THEN excluded.arch ELSE stats_clients.arch END,
      license_status = CASE WHEN excluded.license_status != '' THEN excluded.license_status ELSE stats_clients.license_status END,
      license_plan = CASE WHEN excluded.license_plan != '' THEN excluded.license_plan ELSE stats_clients.license_plan END,
      license_expires_at = CASE WHEN excluded.license_expires_at != '' THEN excluded.license_expires_at ELSE stats_clients.license_expires_at END,
      source_trusted = CASE WHEN excluded.source_trusted != '' THEN excluded.source_trusted ELSE stats_clients.source_trusted END,
      untrusted_reason = CASE WHEN excluded.untrusted_reason != '' THEN excluded.untrusted_reason ELSE stats_clients.untrusted_reason END,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt, updatedAt)];
}

function prepareClientActivityStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.activityDate') AS activity_date,
        json_extract(item.value, '$.clientId') AS client_id,
        json_extract(item.value, '$.clientCreatedDate') AS client_created_date
      FROM json_each(?) AS item
    )
    INSERT INTO stats_client_activity (project_name, activity_date, client_id, client_created_date, updated_at)
    SELECT project_name, activity_date, client_id, client_created_date, ?
    FROM rows
    WHERE project_name != '' AND activity_date != '' AND client_id != '' AND client_created_date != ''
    ON CONFLICT(project_name, activity_date, client_id) DO UPDATE SET
      client_created_date = excluded.client_created_date,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

async function runClientsStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupClientRows(env, activityDate, projectNames), projectNames);
  const activityGrouped = groupRowsByProject(await queryRollupClientActivityRows(env, activityDate, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    const completed = completedSetFor(completedByProject, projectName);
    if (isRollupStageCompleted(completedByProject, projectName, 'clients')) {
      results.push({ projectName, skipped: true });
      continue;
    }

    const chunks = completed.has('clients') ? [] : chunkRows(grouped.get(projectName) || []);
    let completedChunks = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkStage = `clients:chunk:${index}`;
      if (completed.has(chunkStage)) continue;
      const updatedAt = nowText();
      await batchRun(db, [
        ...prepareClientStatements(db, chunks[index], updatedAt),
        prepareProjectStageSuccessStatement(db, projectName, activityDate, chunkStage, updatedAt),
      ]);
      completed.add(chunkStage);
      completedChunks += 1;
    }

    const refreshStage = 'clients:refresh-total-clients';
    if (!completed.has('clients') && !completed.has(refreshStage)) {
      const updatedAt = nowText();
      await batchRun(db, [
        db.prepare(`
          UPDATE stats_totals
          SET total_clients = (SELECT COUNT(*) FROM stats_clients WHERE project_name = ?), updated_at = ?
          WHERE project_name = ?
        `).bind(projectName, updatedAt, projectName),
        prepareProjectStageSuccessStatement(db, projectName, activityDate, refreshStage, updatedAt),
      ]);
      completed.add(refreshStage);
    }

    const activityChunks = chunkRows(activityGrouped.get(projectName) || []);
    let completedActivityChunks = 0;
    for (let index = 0; index < activityChunks.length; index += 1) {
      const chunkStage = `clients:activity:chunk:${index}`;
      if (completed.has(chunkStage)) continue;
      const updatedAt = nowText();
      await batchRun(db, [
        ...prepareClientActivityStatements(db, activityChunks[index], updatedAt),
        prepareProjectStageSuccessStatement(db, projectName, activityDate, chunkStage, updatedAt),
      ]);
      completed.add(chunkStage);
      completedActivityChunks += 1;
    }

    if (!completed.has('clients:activity')) {
      await prepareProjectStageSuccessStatement(db, projectName, activityDate, 'clients:activity', nowText()).run();
      completed.add('clients:activity');
    }

    await prepareProjectStageSuccessStatement(db, projectName, activityDate, 'clients', nowText()).run();
    completed.add('clients');
    results.push({ projectName, skipped: false, chunks: completedChunks, activityChunks: completedActivityChunks });
  }
  return results;
}

async function queryRollupPageRows(env, activityDate, projectNames) {
  const result = await queryAnalytics(env, `
    SELECT blob1 AS projectName, blob3 AS page, SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'page_view'
      AND blob3 != ''
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, page
    ORDER BY projectName ASC, page ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    page: normalizeText(row.page, 120),
    count: number(row.count),
  })).filter((row) => row.projectName && row.page && row.count > 0);
}

function preparePageStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.page') AS page,
        CAST(json_extract(item.value, '$.count') AS INTEGER) AS view_count
      FROM json_each(?) AS item
    )
    INSERT INTO stats_pages (project_name, page, view_count, updated_at)
    SELECT project_name, page, view_count, ?
    FROM rows
    WHERE project_name != '' AND page != ''
    ON CONFLICT(project_name, page) DO UPDATE SET
      view_count = stats_pages.view_count + excluded.view_count,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

async function runPagesStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupPageRows(env, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    results.push(await executeProjectStageChunks(db, completedByProject, projectName, activityDate, 'pages', grouped.get(projectName) || [], preparePageStatements));
  }
  return results;
}

async function queryRollupVersionRows(env, activityDate, projectNames) {
  const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
  const result = await queryAnalytics(env, `
    SELECT blob1 AS projectName, ${versionExpr} AS version, SUM(_sample_interval) AS eventCount
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 IN ${allowedEventsSql()}
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, version
    ORDER BY projectName ASC, version ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    version: normalizedVersion(row.version),
    eventCount: number(row.eventCount),
  })).filter((row) => row.projectName && row.version && row.eventCount > 0);
}

function prepareVersionEventStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.version') AS version,
        CAST(json_extract(item.value, '$.eventCount') AS INTEGER) AS event_count
      FROM json_each(?) AS item
    )
    INSERT INTO stats_versions (project_name, version, event_count, updated_at)
    SELECT project_name, version, event_count, ?
    FROM rows
    WHERE project_name != '' AND version != ''
    ON CONFLICT(project_name, version) DO UPDATE SET
      event_count = stats_versions.event_count + excluded.event_count,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

function prepareVersionClientCountStatements(db, projectName, updatedAt) {
  return [
    db.prepare(`
      UPDATE stats_versions
      SET client_count = 0, updated_at = ?
      WHERE project_name = ?
    `).bind(updatedAt, projectName),
    db.prepare(`
      INSERT INTO stats_versions (project_name, version, event_count, client_count, updated_at)
      SELECT project_name, last_active_version, 0, COUNT(*), ?
      FROM stats_clients
      WHERE project_name = ? AND last_active_version != ''
      GROUP BY project_name, last_active_version
      ON CONFLICT(project_name, version) DO UPDATE SET
        client_count = excluded.client_count,
        updated_at = excluded.updated_at
    `).bind(updatedAt, projectName),
  ];
}

async function runVersionsStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupVersionRows(env, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    const completed = completedSetFor(completedByProject, projectName);
    if (completed.has('versions')) {
      results.push({ projectName, skipped: true });
      continue;
    }

    const rows = grouped.get(projectName) || [];
    const chunks = chunkRows(rows);
    let completedChunks = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkStage = `versions:chunk:${index}`;
      if (completed.has(chunkStage)) continue;
      const updatedAt = nowText();
      await batchRun(db, [
        ...prepareVersionEventStatements(db, chunks[index], updatedAt),
        prepareProjectStageSuccessStatement(db, projectName, activityDate, chunkStage, updatedAt),
      ]);
      completed.add(chunkStage);
      completedChunks += 1;
    }

    const refreshStage = 'versions:refresh-client-counts';
    if (!completed.has(refreshStage)) {
      const updatedAt = nowText();
      await batchRun(db, [
        ...prepareVersionClientCountStatements(db, projectName, updatedAt),
        prepareProjectStageSuccessStatement(db, projectName, activityDate, refreshStage, updatedAt),
      ]);
      completed.add(refreshStage);
    }

    await prepareProjectStageSuccessStatement(db, projectName, activityDate, 'versions', nowText()).run();
    completed.add('versions');
    results.push({ projectName, skipped: false, chunks: completedChunks });
  }
  return results;
}

async function queryRollupConfigRows(env, activityDate, projectNames) {
  const result = await queryAnalytics(env, `
    SELECT blob1 AS projectName, blob9 AS fieldKey, blob10 AS value, SUM(_sample_interval) AS events
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'config_usage'
      AND blob9 IN ${configUsageKeysSql()}
      AND blob10 != ''
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, fieldKey, value
    ORDER BY projectName ASC, fieldKey ASC, value ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    fieldKey: normalizeText(row.fieldKey, 80),
    value: normalizeText(row.value, 200),
    events: number(row.events),
  })).filter((row) => row.projectName && row.fieldKey && row.value && row.events > 0);
}

function prepareConfigStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.fieldKey') AS field_key,
        json_extract(item.value, '$.value') AS config_value,
        CAST(json_extract(item.value, '$.events') AS INTEGER) AS report_count
      FROM json_each(?) AS item
    )
    INSERT INTO stats_configs (project_name, field_key, value, report_count, updated_at)
    SELECT project_name, field_key, config_value, report_count, ?
    FROM rows
    WHERE project_name != '' AND field_key != '' AND config_value != ''
    ON CONFLICT(project_name, field_key, value) DO UPDATE SET
      report_count = stats_configs.report_count + excluded.report_count,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

async function runConfigsStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupConfigRows(env, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    results.push(await executeProjectStageChunks(db, completedByProject, projectName, activityDate, 'configs', grouped.get(projectName) || [], prepareConfigStatements));
  }
  return results;
}

async function queryRollupModelRows(env, activityDate, projectNames) {
  const result = await queryAnalytics(env, `
    SELECT
      blob1 AS projectName,
      blob12 AS requestType,
      blob9 AS provider,
      blob10 AS endpointHost,
      blob11 AS model,
      SUM(_sample_interval) AS requestCount,
      SUM(double4 * _sample_interval) AS totalTokens
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'ai_request'
      AND blob12 IN ('text', 'image')
      AND blob11 != ''
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, requestType, provider, endpointHost, model
    ORDER BY projectName ASC, requestType ASC, provider ASC, endpointHost ASC, model ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    requestType: normalizeText(row.requestType, 20),
    provider: normalizeText(row.provider, 80),
    endpointHost: normalizeText(row.endpointHost, 120),
    model: normalizeText(row.model, 160),
    requestCount: number(row.requestCount),
    totalTokens: number(row.totalTokens),
  })).filter((row) => row.projectName && row.requestType && row.model && row.requestCount > 0);
}

function prepareModelStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.requestType') AS request_type,
        json_extract(item.value, '$.provider') AS provider,
        json_extract(item.value, '$.endpointHost') AS endpoint_host,
        json_extract(item.value, '$.model') AS model,
        CAST(json_extract(item.value, '$.requestCount') AS INTEGER) AS request_count,
        CAST(json_extract(item.value, '$.totalTokens') AS INTEGER) AS total_tokens
      FROM json_each(?) AS item
    )
    INSERT INTO stats_models (project_name, request_type, provider, endpoint_host, model, request_count, total_tokens, updated_at)
    SELECT project_name, request_type, provider, endpoint_host, model, request_count, total_tokens, ?
    FROM rows
    WHERE project_name != '' AND request_type != '' AND model != ''
    ON CONFLICT(project_name, request_type, provider, endpoint_host, model) DO UPDATE SET
      request_count = stats_models.request_count + excluded.request_count,
      total_tokens = stats_models.total_tokens + excluded.total_tokens,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

async function runModelsStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupModelRows(env, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    results.push(await executeProjectStageChunks(db, completedByProject, projectName, activityDate, 'models', grouped.get(projectName) || [], prepareModelStatements));
  }
  return results;
}

async function queryRollupAgentRuntimeRows(env, activityDate, projectNames) {
  const result = await queryAnalytics(env, `
    SELECT
      blob1 AS projectName,
      blob9 AS status,
      SUM(_sample_interval) AS runCount
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'agent_runtime'
      AND blob9 IN ${agentRuntimeStatusesSql()}
      AND ${businessDateCondition(activityDate)}
    GROUP BY projectName, status
    ORDER BY projectName ASC, status ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    projectName: normalizeProjectName(row.projectName),
    status: normalizeText(row.status, 20),
    runCount: number(row.runCount),
  })).filter((row) => row.projectName && AGENT_RUNTIME_STATUSES.has(row.status) && row.runCount > 0);
}

function prepareAgentRuntimeStatements(db, rows, updatedAt) {
  const json = rowsJson(rows);
  return [db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.projectName') AS project_name,
        json_extract(item.value, '$.status') AS status,
        CAST(json_extract(item.value, '$.runCount') AS INTEGER) AS run_count
      FROM json_each(?) AS item
    )
    INSERT INTO stats_agent_runtime (project_name, status, run_count, updated_at)
    SELECT project_name, status, run_count, ?
    FROM rows
    WHERE project_name != '' AND status IN ('success', 'failed')
    ON CONFLICT(project_name, status) DO UPDATE SET
      run_count = stats_agent_runtime.run_count + excluded.run_count,
      updated_at = excluded.updated_at
  `).bind(json, updatedAt)];
}

async function runAgentRuntimeStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const grouped = groupRowsByProject(await queryRollupAgentRuntimeRows(env, activityDate, projectNames), projectNames);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    results.push(await executeProjectStageChunks(db, completedByProject, projectName, activityDate, 'agents', grouped.get(projectName) || [], prepareAgentRuntimeStatements));
  }
  return results;
}

function retentionDaysJson() {
  return rowsJson(RETENTION_DAYS.map((day) => ({ day })));
}

function prepareRetentionSnapshotStatement(db, projectName, snapshotDate, rangeDays, updatedAt) {
  return db.prepare(`
    WITH retention_days AS (
      SELECT CAST(json_extract(item.value, '$.day') AS INTEGER) AS retention_day
      FROM json_each(?) AS item
    ),
    clients AS (
      SELECT client_id, MIN(client_created_date) AS client_created_date
      FROM stats_client_activity
      WHERE project_name = ?
        AND client_created_date >= date(?, '-' || ? || ' days')
        AND client_created_date <= ?
      GROUP BY client_id
    ),
    rows AS (
      SELECT
        ? AS project_name,
        ? AS snapshot_date,
        ? AS range_days,
        retention_days.retention_day AS retention_day,
        COUNT(clients.client_id) AS cohort_clients,
        SUM(CASE WHEN clients.client_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM stats_client_activity retained
          WHERE retained.project_name = ?
            AND retained.client_id = clients.client_id
            AND retained.activity_date = date(clients.client_created_date, '+' || retention_days.retention_day || ' days')
          LIMIT 1
        ) THEN 1 ELSE 0 END) AS retained_clients
      FROM retention_days
      LEFT JOIN clients
        ON clients.client_created_date <= date(?, '-' || retention_days.retention_day || ' days')
      GROUP BY retention_days.retention_day
    )
    INSERT INTO stats_retention (
      project_name, snapshot_date, range_days, retention_day,
      cohort_clients, retained_clients, updated_at
    )
    SELECT project_name, snapshot_date, range_days, retention_day, cohort_clients, retained_clients, ?
    FROM rows
    WHERE project_name != ''
    ON CONFLICT(project_name, snapshot_date, range_days, retention_day) DO UPDATE SET
      cohort_clients = excluded.cohort_clients,
      retained_clients = excluded.retained_clients,
      updated_at = excluded.updated_at
  `).bind(
    retentionDaysJson(),
    projectName,
    snapshotDate,
    rangeDays,
    snapshotDate,
    projectName,
    snapshotDate,
    rangeDays,
    projectName,
    snapshotDate,
    updatedAt,
  );
}

export async function rebuildRetentionSnapshot(env, projectName, snapshotDate, rangeDays = DEFAULT_RETENTION_RANGE_DAYS) {
  const db = requireStatsDb(env);
  const normalizedProjectName = normalizeProjectName(projectName);
  const normalizedRangeDays = Math.max(1, Math.floor(number(rangeDays) || DEFAULT_RETENTION_RANGE_DAYS));
  await prepareRetentionSnapshotStatement(db, normalizedProjectName, snapshotDate, normalizedRangeDays, nowText()).run();
  return { projectName: normalizedProjectName, snapshotDate, rangeDays: normalizedRangeDays };
}

async function runRetentionStage(env, activityDate, projectNames, completedByProject) {
  const db = requireStatsDb(env);
  const results = [];
  for (const projectName of uniqueProjectNames(projectNames)) {
    const completed = completedSetFor(completedByProject, projectName);
    if (completed.has('retention')) {
      results.push({ projectName, skipped: true });
      continue;
    }

    const updatedAt = nowText();
    await batchRun(db, [
      prepareRetentionSnapshotStatement(db, projectName, activityDate, DEFAULT_RETENTION_RANGE_DAYS, updatedAt),
      prepareProjectStageSuccessStatement(db, projectName, activityDate, 'retention', updatedAt),
    ]);
    completed.add('retention');
    results.push({ projectName, skipped: false });
  }
  return results;
}

export async function backfillClientActivityWindow(env, projectName, startDate, endDate) {
  const db = requireStatsDb(env);
  const rows = await queryRollupClientActivityRows(env, startDate, endDate, [projectName]);
  for (const chunk of chunkRows(rows)) {
    await prepareClientActivityStatements(db, chunk, nowText())[0].run();
  }
  return { projectName: normalizeProjectName(projectName), startDate, endDate, rows: rows.length };
}

async function queryHistoricalResourceClickRows(env, activityDate, projectNames) {
  const result = await queryAnalytics(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount
    FROM ${DATASET}
    WHERE blob1 IN ${projectsSql(projectNames)}
      AND blob2 = 'resource_click'
      AND blob9 != ''
      AND ${businessDateSqlExpression()} <= ${sqlString(activityDate)}
    GROUP BY resourceKey
    ORDER BY resourceKey ASC
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return (result.data || []).map((row) => ({
    resourceKey: normalizeText(row.resourceKey, 80),
    clickCount: number(row.clickCount),
  })).filter((row) => row.resourceKey);
}

function prepareResourceClickSetStatement(db, rows) {
  return db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.id') AS id,
        CAST(json_extract(item.value, '$.clickCount') AS INTEGER) AS click_count
      FROM json_each(?) AS item
    )
    UPDATE resources
    SET click_count = COALESCE((SELECT click_count FROM rows WHERE rows.id = resources.id), 0)
    WHERE id IN (SELECT id FROM rows)
  `).bind(rowsJson(rows));
}

async function runResourcesStage(env, activityDate, projectNames, completedByProject) {
  const statsDb = requireStatsDb(env);
  const projects = uniqueProjectNames(projectNames);
  const pendingProjects = projects.filter((projectName) => !completedSetFor(completedByProject, projectName).has('resources'));
  if (!pendingProjects.length) {
    return projects.map((projectName) => ({ projectName, skipped: true }));
  }

  if (!env.RESOURCE_DB) {
    console.warn('[analytics] resource click rollup skipped: RESOURCE_DB is not configured');
    await markProjectsStageSuccess(statsDb, pendingProjects, activityDate, 'resources');
    await markRollupRunsSuccess(statsDb, pendingProjects, activityDate);
    return pendingProjects.map((projectName) => ({ projectName, skipped: true }));
  }

  const resourceDb = requireResourceDb(env);
  const resources = await listAdminResources(env, { origin: '' });
  const countByKey = new Map((await queryHistoricalResourceClickRows(env, activityDate, projects))
    .map((row) => [row.resourceKey, row.clickCount]));
  const rows = resources.map((resource) => ({
    id: resource.id,
    clickCount: Math.max(0, Math.floor(countByKey.get(resource.analyticsKey) || 0)),
  }));
  for (const chunk of chunkRows(rows)) {
    await prepareResourceClickSetStatement(resourceDb, chunk).run();
  }
  await markProjectsStageSuccess(statsDb, pendingProjects, activityDate, 'resources');
  await markRollupRunsSuccess(statsDb, pendingProjects, activityDate);
  for (const projectName of pendingProjects) {
    completedSetFor(completedByProject, projectName).add('resources');
  }
  return pendingProjects.map((projectName) => ({ projectName, skipped: false }));
}

function projectHasPreviousStages(completedByProject, projectName, stage) {
  const stageIndex = ROLLUP_STAGE_ORDER.indexOf(stage);
  return ROLLUP_STAGE_ORDER.slice(0, stageIndex)
    .every((previousStage) => isRollupStageCompleted(completedByProject, projectName, previousStage));
}

async function runRollupStageForDate(env, stage, activityDate, options = {}) {
  if (!ROLLUP_STAGE_ORDER.includes(stage)) {
    throw new Error(`unknown rollup stage: ${stage}`);
  }

  if (stage === 'discover') {
    return await runDiscoveryStage(env, activityDate, options);
  }

  const db = requireStatsDb(env);
  if (options.projectNames) {
    await upsertRollupRuns(db, options.projectNames, activityDate);
  }
  const projects = uniqueProjectNames(options.projectNames || await ensureRollupProjects(env, activityDate));
  if (!projects.length) {
    return { activityDate, stage, projects: [] };
  }

  const completedByProject = await queryCompletedStages(db, activityDate);
  const readyProjects = projects.filter((projectName) => projectHasPreviousStages(completedByProject, projectName, stage));
  const blockedProjects = projects.filter((projectName) => !readyProjects.includes(projectName));
  if (blockedProjects.length) {
    console.warn(`[analytics] rollup stage skipped until previous stages finish: ${stage}/${activityDate}/${blockedProjects.join(',')}`);
  }

  const pendingProjects = readyProjects.filter((projectName) => !isRollupStageCompleted(completedByProject, projectName, stage));
  if (!pendingProjects.length) {
    return { activityDate, stage, projects: projects.map((projectName) => ({ projectName, skipped: true })) };
  }

  try {
    let results;
    if (stage === 'daily') {
      results = await runDailyStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'clients') {
      results = await runClientsStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'pages') {
      results = await runPagesStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'versions') {
      results = await runVersionsStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'configs') {
      results = await runConfigsStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'models') {
      results = await runModelsStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'agents') {
      results = await runAgentRuntimeStage(env, activityDate, pendingProjects, completedByProject);
    } else if (stage === 'retention') {
      results = await runRetentionStage(env, activityDate, pendingProjects, completedByProject);
    } else {
      results = await runResourcesStage(env, activityDate, pendingProjects, completedByProject);
    }
    return { activityDate, stage, projects: results };
  } catch (error) {
    try {
      await markProjectsStageFailed(db, pendingProjects, activityDate, stage, error);
      await markRollupRunsFailed(db, pendingProjects, activityDate, error);
    } catch (markError) {
      console.warn('[analytics] failed to mark rollup stage failure', markError?.message || String(markError));
    }
    throw error;
  }
}

export async function rollupStatsDay(env, projectName, activityDate, options = {}) {
  const db = requireStatsDb(env);
  const normalizedProjectName = normalizeProjectName(projectName);
  const existing = await first(db, `
    SELECT status
    FROM stats_rollup_runs
    WHERE project_name = ? AND activity_date = ?
  `, [normalizedProjectName, activityDate]);
  if (existing?.status === 'success') {
    return { projectName: normalizedProjectName, activityDate, skipped: true };
  }
  if (!existing?.status && await hasDailyRollupRow(db, normalizedProjectName, activityDate)) {
    console.warn(`[analytics] rollup skipped to avoid duplicated counters: ${normalizedProjectName}/${activityDate} status=missing`);
    await upsertRollupRuns(db, [normalizedProjectName], activityDate);
    await markRollupRunsSuccess(db, [normalizedProjectName], activityDate);
    return { projectName: normalizedProjectName, activityDate, skipped: true };
  }

  const projects = [normalizedProjectName];
  await runRollupStageForDate(env, 'discover', activityDate, { projectNames: projects });
  for (const stage of ['daily', 'clients', 'pages', 'versions', 'configs', 'models', 'agents', 'retention']) {
    await runRollupStageForDate(env, stage, activityDate, { projectNames: projects });
  }
  if (options.updateResources !== false) {
    await runRollupStageForDate(env, 'resources', activityDate, { projectNames: projects });
  } else {
    await markRollupRunsSuccess(db, projects, activityDate);
  }
  return { projectName: normalizedProjectName, activityDate, skipped: false };
}

export async function rollupYesterdayCronStage(env, cron) {
  const stages = ROLLUP_STAGES_BY_CRON.get(cron);
  if (!stages) {
    console.warn(`[analytics] unknown scheduled cron ignored: ${cron || ''}`);
    return { activityDate: getBusinessDateDaysAgo(1), cron, stages: [] };
  }
  const activityDate = getBusinessDateDaysAgo(1);
  const results = [];
  let projectNames = stages[0] === 'discover' ? null : await ensureRollupProjects(env, activityDate);
  for (const stage of stages) {
    const result = await runRollupStageForDate(env, stage, activityDate, projectNames ? { projectNames } : {});
    results.push(result);
    if (!projectNames) {
      projectNames = uniqueProjectNames(result.projects.map((row) => row.projectName));
    }
  }
  return { activityDate, cron, stages: results };
}

export async function rollupYesterdayForAllProjects(env) {
  const activityDate = getBusinessDateDaysAgo(1);
  const discoverResult = await runRollupStageForDate(env, 'discover', activityDate);
  const projects = uniqueProjectNames(discoverResult.projects.map((row) => row.projectName));
  for (const stage of ROLLUP_STAGE_ORDER.slice(1)) {
    await runRollupStageForDate(env, stage, activityDate, { projectNames: projects });
  }
  return { activityDate, projects: projects.map((projectName) => ({ projectName, skipped: false })) };
}
