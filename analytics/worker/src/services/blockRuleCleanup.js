import {
  ALLOWED_EVENTS,
  ANALYTICS_DATA_FILTER,
  CONFIG_USAGE_FIELDS,
  RAW_DATASET,
} from '../constants.js';
import {
  businessDateSqlExpression,
  businessDateTimeSqlExpression,
  formatBusinessDateTime,
  normalizeText,
  sqlString,
} from '../utils.js';
import { createAgentRuntimeRowsFromMetricRows } from './analyticsStatsStore.js';
import { queryAnalytics } from './analyticsQuery.js';
import {
  buildAnalyticsCleanupCondition,
  getBlockRuleCleanupProgress,
  saveBlockRuleCleanupProgress,
} from './blockRuleStore.js';
import { listAdminResources } from './resourceStore.js';

const MAX_ANALYTICS_ROWS = 100000;
const ANALYTICS_PAGE_SIZE = 10000;
const CLIENT_QUERY_CHUNK_SIZE = 5000;

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

function number(value) {
  return Number(value || 0);
}

function rowsJson(rows) {
  return JSON.stringify(rows || []);
}

function chunks(rows, size = CLIENT_QUERY_CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

function allowedEventsSql() {
  return `(${Array.from(ALLOWED_EVENTS).map(sqlString).join(', ')})`;
}

function configUsageKeysSql() {
  return `(${CONFIG_USAGE_FIELDS.map((field) => sqlString(field.key)).join(', ')})`;
}

// 按稳定排序分页读取高基数 Analytics Engine 聚合结果。
async function queryAllAnalyticsRows(env, createSql) {
  const rows = [];
  for (let offset = 0; ; offset += ANALYTICS_PAGE_SIZE) {
    const result = await queryAnalytics(env, createSql(ANALYTICS_PAGE_SIZE, offset));
    const pageRows = result.data || [];
    rows.push(...pageRows);
    if (pageRows.length < ANALYTICS_PAGE_SIZE) return rows;
  }
}

// 固定上限查询一旦触顶即视为不完整，禁止继续写 D1 和推进游标。
function assertAggregateQueriesComplete(results) {
  const names = ['每日污染', '每日净值', '页面', '版本', '配置', '模型', 'Agent'];
  results.forEach((result, index) => {
    if ((result.data || []).length >= MAX_ANALYTICS_ROWS) {
      throw new Error(`${names[index]}清理查询达到 ${MAX_ANALYTICS_ROWS} 行上限，未写入任何清理结果`);
    }
  });
}

function ruleMatchSql(rule) {
  return rule.type === 'ip'
    ? `blob13 = ${sqlString(rule.value)}`
    : `blob4 = ${sqlString(rule.value)}`;
}

function cleanupDateCondition(cleanedUntil, upperDate) {
  const date = businessDateSqlExpression();
  const lower = cleanedUntil ? `${date} > ${sqlString(cleanedUntil.slice(0, 10))} AND ` : '';
  return `${lower}${date} <= ${sqlString(upperDate)}`;
}

function mapDailyRows(cleanRows, badRows) {
  const cleanByDate = new Map((cleanRows || []).map((row) => [row.activityDate, row]));
  return (badRows || []).map((row) => {
    const clean = cleanByDate.get(row.activityDate) || {};
    return {
      activityDate: row.activityDate,
      activeClients: number(clean.activeClients),
      appOpenCount: number(clean.appOpenCount),
      pageViewCount: number(clean.pageViewCount),
      eventCount: number(clean.eventCount),
      aiRequestCount: number(clean.aiRequestCount),
    };
  });
}

// 分块读取受影响客户端在规则过滤后的最后状态和留存活动。
async function queryCleanClients(env, projectName, clientIds, dateCondition, cleanupFilter) {
  const clients = [];
  const activity = [];
  for (let offset = 0; offset < clientIds.length; offset += CLIENT_QUERY_CHUNK_SIZE) {
    const ids = clientIds.slice(offset, offset + CLIENT_QUERY_CHUNK_SIZE).map(sqlString).join(', ');
    const [clientResult, activityRows] = await Promise.all([
      queryAnalytics(env, `
        SELECT
          blob7 AS clientId,
          ${businessDateTimeSqlExpression('min(timestamp)')} AS firstSeenAt,
          ${businessDateSqlExpression('min(timestamp)')} AS firstSeenDate,
          ${businessDateSqlExpression('max(timestamp)')} AS lastActiveDate,
          argMax(if(blob4 = '', '未知版本', blob4), timestamp) AS lastVersion,
          argMax(blob13, timestamp) AS lastAccessIp,
          argMax(blob5, timestamp) AS platform,
          argMax(blob6, timestamp) AS arch,
          argMax(blob14, timestamp) AS licenseStatus,
          argMax(blob15, timestamp) AS licensePlan,
          argMax(blob16, timestamp) AS licenseExpiresAt,
          argMax(blob17, timestamp) AS sourceTrusted,
          argMax(blob18, timestamp) AS untrustedReason
        FROM ${RAW_DATASET}
        WHERE ${ANALYTICS_DATA_FILTER}
          AND ${cleanupFilter}
          AND blob1 = ${sqlString(projectName)}
          AND blob2 IN ${allowedEventsSql()}
          AND blob7 IN (${ids})
        GROUP BY clientId
        LIMIT ${MAX_ANALYTICS_ROWS}
      `),
      queryAllAnalyticsRows(env, (limit, offset) => `
        SELECT
          ${businessDateSqlExpression()} AS activityDate,
          blob7 AS clientId,
          argMin(blob8, timestamp) AS clientCreatedDate
        FROM ${RAW_DATASET}
        WHERE ${ANALYTICS_DATA_FILTER}
          AND ${cleanupFilter}
          AND blob1 = ${sqlString(projectName)}
          AND blob2 = 'app_open'
          AND blob7 IN (${ids})
          AND blob8 != ''
          AND ${dateCondition}
        GROUP BY activityDate, clientId
        ORDER BY activityDate ASC, clientId ASC
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);
    clients.push(...(clientResult.data || []));
    activity.push(...activityRows);
  }
  return { clients, activity };
}

// 查询本次清理游标之后、已进入 D1 的规则污染增量。
async function queryCleanupInputs(env, rule, projectName, cleanedUntil, upperDate) {
  const dateCondition = cleanupDateCondition(cleanedUntil, upperDate);
  const projectCondition = `blob1 = ${sqlString(projectName)}`;
  const appliedFilter = await buildAnalyticsCleanupCondition(env, projectName);
  const cleanupFilter = await buildAnalyticsCleanupCondition(env, projectName, rule);
  const badBase = `${ANALYTICS_DATA_FILTER} AND ${appliedFilter}`;
  const matched = ruleMatchSql(rule);
  const badWhere = `${badBase} AND ${projectCondition} AND ${matched} AND ${dateCondition}`;
  const clientRowsPromise = queryAllAnalyticsRows(env, (limit, offset) => `
    SELECT blob7 AS clientId
    FROM ${RAW_DATASET}
    WHERE ${badWhere} AND blob2 IN ${allowedEventsSql()} AND blob7 != ''
    GROUP BY clientId
    ORDER BY clientId ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const queries = await Promise.all([
    queryAnalytics(env, `
      SELECT ${businessDateSqlExpression()} AS activityDate,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${RAW_DATASET}
      WHERE ${badWhere} AND blob2 IN ${allowedEventsSql()}
      GROUP BY activityDate
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `
      SELECT ${businessDateSqlExpression()} AS activityDate,
        COUNT(DISTINCT blob7) AS activeClients,
        SUM(if(blob2 = 'app_open', _sample_interval, 0)) AS appOpenCount,
        SUM(if(blob2 = 'page_view', _sample_interval, 0)) AS pageViewCount,
        SUM(_sample_interval) AS eventCount,
        SUM(if(blob2 = 'ai_request', _sample_interval, 0)) AS aiRequestCount
      FROM ${RAW_DATASET}
      WHERE ${ANALYTICS_DATA_FILTER} AND ${cleanupFilter}
        AND ${projectCondition} AND ${dateCondition} AND blob2 IN ${allowedEventsSql()}
      GROUP BY activityDate
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    queryAnalytics(env, `SELECT blob3 AS page, SUM(_sample_interval) AS count FROM ${RAW_DATASET} WHERE ${badWhere} AND blob2 = 'page_view' AND blob3 != '' GROUP BY page LIMIT ${MAX_ANALYTICS_ROWS}`),
    queryAnalytics(env, `SELECT if(blob4 = '', '未知版本', blob4) AS version, SUM(_sample_interval) AS eventCount FROM ${RAW_DATASET} WHERE ${badWhere} AND blob2 IN ${allowedEventsSql()} GROUP BY version LIMIT ${MAX_ANALYTICS_ROWS}`),
    queryAnalytics(env, `SELECT blob9 AS fieldKey, blob10 AS value, SUM(_sample_interval) AS reportCount FROM ${RAW_DATASET} WHERE ${badWhere} AND blob2 = 'config_usage' AND blob9 IN ${configUsageKeysSql()} AND blob10 != '' GROUP BY fieldKey, value LIMIT ${MAX_ANALYTICS_ROWS}`),
    queryAnalytics(env, `SELECT blob12 AS requestType, blob9 AS provider, blob10 AS endpointHost, blob11 AS model, SUM(_sample_interval) AS requestCount, SUM(double4 * _sample_interval) AS totalTokens FROM ${RAW_DATASET} WHERE ${badWhere} AND blob2 = 'ai_request' AND blob12 IN ('text', 'image') AND blob11 != '' GROUP BY requestType, provider, endpointHost, model LIMIT ${MAX_ANALYTICS_ROWS}`),
    queryAnalytics(env, `SELECT blob9 AS metricKey, SUM(_sample_interval) AS runCount FROM ${RAW_DATASET} WHERE ${badWhere} AND blob2 = 'agent_runtime' AND blob9 != '' GROUP BY metricKey LIMIT ${MAX_ANALYTICS_ROWS}`),
  ]);
  assertAggregateQueriesComplete(queries);
  const clientRows = await clientRowsPromise;
  const clientIds = Array.from(new Set(clientRows.map((row) => normalizeText(row.clientId, 120)).filter(Boolean)));
  const cleanClients = clientIds.length ? await queryCleanClients(env, projectName, clientIds, dateCondition, cleanupFilter) : { clients: [], activity: [] };
  return {
    badDaily: queries[0].data || [],
    cleanDaily: queries[1].data || [],
    pages: queries[2].data || [],
    versions: queries[3].data || [],
    configs: queries[4].data || [],
    models: queries[5].data || [],
    agents: createAgentRuntimeRowsFromMetricRows(queries[6].data || []),
    clientIds,
    cleanClients: cleanClients.clients,
    cleanActivity: cleanClients.activity,
  };
}

function dailyStatement(db, projectName, rows, updatedAt) {
  return db.prepare(`
    WITH rows AS (
      SELECT
        json_extract(item.value, '$.activityDate') AS activity_date,
        CAST(json_extract(item.value, '$.activeClients') AS INTEGER) AS active_clients,
        CAST(json_extract(item.value, '$.appOpenCount') AS INTEGER) AS app_open_count,
        CAST(json_extract(item.value, '$.pageViewCount') AS INTEGER) AS page_view_count,
        CAST(json_extract(item.value, '$.eventCount') AS INTEGER) AS event_count,
        CAST(json_extract(item.value, '$.aiRequestCount') AS INTEGER) AS ai_request_count
      FROM json_each(?) AS item
    )
    INSERT INTO stats_daily (project_name, activity_date, active_clients, app_open_count, page_view_count, event_count, ai_request_count, updated_at)
    SELECT ?, activity_date, active_clients, app_open_count, page_view_count, event_count, ai_request_count, ? FROM rows
    ON CONFLICT(project_name, activity_date) DO UPDATE SET
      active_clients = excluded.active_clients,
      app_open_count = excluded.app_open_count,
      page_view_count = excluded.page_view_count,
      event_count = excluded.event_count,
      ai_request_count = excluded.ai_request_count,
      updated_at = excluded.updated_at
  `).bind(rowsJson(rows), projectName, updatedAt);
}

function subtractStatement(db, table, projectName, rows, columns, keys, updatedAt) {
  const rowColumns = [...keys, ...columns]
    .map((column) => `json_extract(item.value, '$.${column.json}') AS ${column.db}`)
    .join(',\n');
  const match = keys.map((key) => `rows.${key.db} = ${table}.${key.db}`).join(' AND ');
  const updates = columns.map((column) => (
    `${column.db} = MAX(0, ${column.db} - COALESCE((SELECT CAST(rows.${column.db} AS INTEGER) FROM rows WHERE ${match}), 0))`
  )).join(',\n');
  return db.prepare(`
    WITH rows AS (SELECT ${rowColumns} FROM json_each(?) AS item)
    UPDATE ${table}
    SET ${updates}, updated_at = ?
    WHERE project_name = ? AND EXISTS (SELECT 1 FROM rows WHERE ${match})
  `).bind(rowsJson(rows), updatedAt, projectName);
}

function clientStatements(db, projectName, inputs, cleanedUntil, recoverableStartDate, upperDate, updatedAt) {
  if (!inputs.clientIds.length) return [];
  const lowerDate = cleanedUntil ? cleanedUntil.slice(0, 10) : '';
  const cleanIds = new Set(inputs.cleanClients.map((row) => normalizeText(row.clientId, 120)).filter(Boolean));
  const statements = [];
  for (const clientIds of chunks(inputs.clientIds)) {
    statements.push(db.prepare(`
      DELETE FROM stats_client_activity
      WHERE project_name = ?
        AND activity_date > ? AND activity_date <= ?
        AND client_id IN (SELECT value FROM json_each(?))
    `).bind(projectName, lowerDate, upperDate, rowsJson(clientIds)));
  }
  for (const activityRows of chunks(inputs.cleanActivity)) {
    statements.push(db.prepare(`
      WITH rows AS (
        SELECT
          json_extract(item.value, '$.activityDate') AS activity_date,
          json_extract(item.value, '$.clientId') AS client_id,
          json_extract(item.value, '$.clientCreatedDate') AS client_created_date
        FROM json_each(?) AS item
      )
      INSERT INTO stats_client_activity (project_name, activity_date, client_id, client_created_date, updated_at)
      SELECT ?, activity_date, client_id, client_created_date, ? FROM rows
      WHERE activity_date != '' AND client_id != '' AND client_created_date != ''
      ON CONFLICT(project_name, activity_date, client_id) DO UPDATE SET
        client_created_date = excluded.client_created_date,
        updated_at = excluded.updated_at
    `).bind(rowsJson(activityRows), projectName, updatedAt));
  }
  for (const clientRows of chunks(inputs.cleanClients)) {
    statements.push(db.prepare(`
      WITH rows AS (
        SELECT
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
      SELECT ?, client_id, first_seen_at, first_seen_date, 0,
        last_active_date, last_active_version, last_access_ip, platform, arch,
        license_status, license_plan, license_expires_at, source_trusted, untrusted_reason, ?, ?
      FROM rows WHERE client_id != ''
      ON CONFLICT(project_name, client_id) DO UPDATE SET
        first_seen_at = MIN(stats_clients.first_seen_at, excluded.first_seen_at),
        first_seen_date = MIN(stats_clients.first_seen_date, excluded.first_seen_date),
        last_active_date = excluded.last_active_date,
        last_active_version = excluded.last_active_version,
        last_access_ip = excluded.last_access_ip,
        platform = excluded.platform,
        arch = excluded.arch,
        license_status = excluded.license_status,
        license_plan = excluded.license_plan,
        license_expires_at = excluded.license_expires_at,
        source_trusted = excluded.source_trusted,
        untrusted_reason = excluded.untrusted_reason,
        updated_at = excluded.updated_at
    `).bind(rowsJson(clientRows), projectName, updatedAt, updatedAt));
  }
  const dirtyClientIds = inputs.clientIds.filter((clientId) => !cleanIds.has(clientId));
  for (const clientIds of chunks(dirtyClientIds)) {
    statements.push(db.prepare(`
      DELETE FROM stats_clients
      WHERE project_name = ?
        AND first_seen_date >= ? AND first_seen_date <= ?
        AND client_id IN (SELECT value FROM json_each(?))
    `).bind(projectName, recoverableStartDate, upperDate, rowsJson(clientIds)));
  }
  for (const clientIds of chunks(inputs.clientIds)) {
    statements.push(db.prepare(`
      UPDATE stats_clients
      SET active_days = (
        SELECT COUNT(*) FROM stats_client_activity activity
        WHERE activity.project_name = stats_clients.project_name
          AND activity.client_id = stats_clients.client_id
      ), updated_at = ?
      WHERE project_name = ? AND client_id IN (SELECT value FROM json_each(?))
    `).bind(updatedAt, projectName, rowsJson(clientIds)));
  }
  return statements;
}

function retentionStatements(db, projectName, snapshots, updatedAt) {
  return snapshots.map((snapshot) => db.prepare(`
    WITH retention_days(retention_day) AS (VALUES (1), (3), (7)),
    clients AS (
      SELECT client_id, MIN(client_created_date) AS client_created_date
      FROM stats_client_activity
      WHERE project_name = ?
        AND client_created_date >= date(?, '-' || ? || ' days')
        AND client_created_date <= ?
      GROUP BY client_id
    ), rows AS (
      SELECT retention_day,
        COUNT(clients.client_id) AS cohort_clients,
        SUM(CASE WHEN clients.client_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM stats_client_activity retained
          WHERE retained.project_name = ? AND retained.client_id = clients.client_id
            AND retained.activity_date = date(clients.client_created_date, '+' || retention_day || ' days')
        ) THEN 1 ELSE 0 END) AS retained_clients
      FROM retention_days
      LEFT JOIN clients ON clients.client_created_date <= date(?, '-' || retention_day || ' days')
      GROUP BY retention_day
    )
    INSERT INTO stats_retention (project_name, snapshot_date, range_days, retention_day, cohort_clients, retained_clients, updated_at)
    SELECT ?, ?, ?, retention_day, cohort_clients, retained_clients, ? FROM rows
    ON CONFLICT(project_name, snapshot_date, range_days, retention_day) DO UPDATE SET
      cohort_clients = excluded.cohort_clients,
      retained_clients = excluded.retained_clients,
      updated_at = excluded.updated_at
  `).bind(
    projectName, snapshot.snapshotDate, snapshot.rangeDays, snapshot.snapshotDate,
    projectName, snapshot.snapshotDate,
    projectName, snapshot.snapshotDate, snapshot.rangeDays, updatedAt,
  ));
}

// 将规则在 Analytics Engine 可恢复区间内的污染贡献从 D1 汇总中幂等扣除。
async function applyStatsCleanup(env, rule, projectName, cleanedUntil, upperDate) {
  const db = requireStatsDb(env);
  const inputs = await queryCleanupInputs(env, rule, projectName, cleanedUntil, upperDate);
  const dailyRows = mapDailyRows(inputs.cleanDaily, inputs.badDaily);
  const totals = inputs.badDaily.reduce((sum, row) => ({
    appOpenCount: sum.appOpenCount + number(row.appOpenCount),
    pageViewCount: sum.pageViewCount + number(row.pageViewCount),
    eventCount: sum.eventCount + number(row.eventCount),
    aiRequestCount: sum.aiRequestCount + number(row.aiRequestCount),
  }), { appOpenCount: 0, pageViewCount: 0, eventCount: 0, aiRequestCount: 0 });
  const updatedAt = formatBusinessDateTime(new Date());
  const snapshots = (await db.prepare(`
    SELECT DISTINCT snapshot_date AS snapshotDate, range_days AS rangeDays
    FROM stats_retention WHERE project_name = ?
  `).bind(projectName).all()).results || [];
  const statements = [];
  if (dailyRows.length) statements.push(dailyStatement(db, projectName, dailyRows, updatedAt));
  if (inputs.pages.length) statements.push(subtractStatement(db, 'stats_pages', projectName, inputs.pages, [{ json: 'count', db: 'view_count' }], [{ json: 'page', db: 'page' }], updatedAt));
  if (inputs.versions.length) statements.push(subtractStatement(db, 'stats_versions', projectName, inputs.versions, [{ json: 'eventCount', db: 'event_count' }], [{ json: 'version', db: 'version' }], updatedAt));
  if (inputs.configs.length) statements.push(subtractStatement(db, 'stats_configs', projectName, inputs.configs, [{ json: 'reportCount', db: 'report_count' }], [{ json: 'fieldKey', db: 'field_key' }, { json: 'value', db: 'value' }], updatedAt));
  if (inputs.models.length) statements.push(subtractStatement(db, 'stats_models', projectName, inputs.models, [{ json: 'requestCount', db: 'request_count' }, { json: 'totalTokens', db: 'total_tokens' }], [{ json: 'requestType', db: 'request_type' }, { json: 'provider', db: 'provider' }, { json: 'endpointHost', db: 'endpoint_host' }, { json: 'model', db: 'model' }], updatedAt));
  if (inputs.agents.length) statements.push(subtractStatement(db, 'stats_agent_runtime', projectName, inputs.agents, [
    { json: 'successCount', db: 'success_count' }, { json: 'failedCount', db: 'failed_count' }, { json: 'totalCount', db: 'total_count' },
    { json: 'resultRetryCount', db: 'retry_count' }, { json: 'resultRetriedRunCount', db: 'retried_run_count' }, { json: 'resultRetrySuccessCount', db: 'retry_success_count' },
    { json: 'modelRunCount', db: 'model_run_count' }, { json: 'modelRetryCount', db: 'model_retry_count' }, { json: 'modelRetriedRunCount', db: 'model_retried_run_count' }, { json: 'modelRetrySuccessCount', db: 'model_retry_success_count' },
  ], [{ json: 'runtime', db: 'runtime' }, { json: 'provider', db: 'provider' }, { json: 'endpointHost', db: 'endpoint_host' }, { json: 'model', db: 'model' }], updatedAt));
  const recoverableStartDate = inputs.badDaily
    .map((row) => String(row.activityDate || ''))
    .filter(Boolean)
    .sort()[0] || upperDate;
  statements.push(...clientStatements(db, projectName, inputs, cleanedUntil, recoverableStartDate, upperDate, updatedAt));
  statements.push(
    db.prepare("DELETE FROM stats_pages WHERE project_name = ? AND view_count = 0").bind(projectName),
    db.prepare("DELETE FROM stats_configs WHERE project_name = ? AND report_count = 0").bind(projectName),
    db.prepare("DELETE FROM stats_models WHERE project_name = ? AND request_count = 0 AND total_tokens = 0").bind(projectName),
    db.prepare("DELETE FROM stats_agent_runtime WHERE project_name = ? AND total_count = 0").bind(projectName),
    db.prepare(`UPDATE stats_versions SET client_count = 0, updated_at = ? WHERE project_name = ?`).bind(updatedAt, projectName),
    db.prepare(`
      INSERT INTO stats_versions (project_name, version, event_count, client_count, updated_at)
      SELECT project_name, last_active_version, 0, COUNT(*), ? FROM stats_clients
      WHERE project_name = ? AND last_active_version != '' GROUP BY project_name, last_active_version
      ON CONFLICT(project_name, version) DO UPDATE SET client_count = excluded.client_count, updated_at = excluded.updated_at
    `).bind(updatedAt, projectName),
    db.prepare("DELETE FROM stats_versions WHERE project_name = ? AND event_count = 0 AND client_count = 0").bind(projectName),
  );
  statements.push(...retentionStatements(db, projectName, snapshots, updatedAt));
  statements.push(
    db.prepare(`
      UPDATE stats_totals SET
        total_clients = (SELECT COUNT(*) FROM stats_clients WHERE project_name = ?),
        total_open = MAX(0, total_open - ?),
        total_page_views = MAX(0, total_page_views - ?),
        total_events = MAX(0, total_events - ?),
        total_ai_requests = MAX(0, total_ai_requests - ?),
        total_text_tokens = COALESCE((SELECT SUM(total_tokens) FROM stats_models WHERE project_name = ? AND request_type = 'text'), 0),
        total_generated_images = COALESCE((SELECT SUM(request_count) FROM stats_models WHERE project_name = ? AND request_type = 'image'), 0),
        updated_at = ? WHERE project_name = ?
    `).bind(projectName, totals.appOpenCount, totals.pageViewCount, totals.eventCount, totals.aiRequestCount, projectName, projectName, updatedAt, projectName),
    db.prepare(`
      INSERT INTO block_rule_cleanup_progress (rule_type, project_name, rule_value, cleaned_until, status, error, updated_at)
      VALUES (?, ?, ?, ?, 'stats_applied', '', ?)
      ON CONFLICT(rule_type, project_name, rule_value) DO UPDATE SET
        cleaned_until = excluded.cleaned_until, status = excluded.status, error = '', updated_at = excluded.updated_at
    `).bind(rule.type, projectName, rule.value, upperDate, updatedAt),
  );
  if (typeof db.batch === 'function') await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { cleanedUntil: upperDate, removedEvents: totals.eventCount };
}

// 资源点击本身由保留期原始事件绝对汇总，直接重算可安全重试。
async function rebuildResourceClicks(env, rule, projectName, upperDate) {
  if (!env.RESOURCE_DB) return;
  const cleanupFilter = await buildAnalyticsCleanupCondition(env, projectName, rule, true);
  const result = await queryAnalytics(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount
    FROM ${RAW_DATASET}
    WHERE ${ANALYTICS_DATA_FILTER} AND ${cleanupFilter}
      AND blob2 = 'resource_click' AND blob9 != ''
      AND ${businessDateSqlExpression()} <= ${sqlString(upperDate)}
    GROUP BY resourceKey LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  const counts = new Map((result.data || []).map((row) => [row.resourceKey, number(row.clickCount)]));
  const resources = await listAdminResources(env, { origin: '' });
  const statements = resources.map((resource) => env.RESOURCE_DB.prepare('UPDATE resources SET click_count = ? WHERE id = ?')
    .bind(counts.get(resource.analyticsKey) || 0, resource.id));
  if (!statements.length) return;
  if (typeof env.RESOURCE_DB.batch === 'function') await env.RESOURCE_DB.batch(statements);
  else for (const statement of statements) await statement.run();
}

// 获取项目级清理锁；陈旧锁十五分钟后允许接管。
async function acquireCleanupLock(db, projectName, owner) {
  const acquiredAt = formatBusinessDateTime(new Date());
  const staleBefore = formatBusinessDateTime(new Date(Date.now() - 15 * 60 * 1000));
  await db.prepare(`
    INSERT INTO block_rule_cleanup_locks (project_name, owner, acquired_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_name) DO UPDATE SET
      owner = excluded.owner,
      acquired_at = excluded.acquired_at
    WHERE block_rule_cleanup_locks.acquired_at < ?
  `).bind(projectName, owner, acquiredAt, staleBefore).run();
  const lock = await db.prepare('SELECT owner FROM block_rule_cleanup_locks WHERE project_name = ?').bind(projectName).first();
  return lock?.owner === owner;
}

// 仅释放当前请求持有的项目级清理锁。
async function releaseCleanupLock(db, projectName, owner) {
  await db.prepare('DELETE FROM block_rule_cleanup_locks WHERE project_name = ? AND owner = ?').bind(projectName, owner).run();
}

// 执行或继续规则清理；规则已先落库，因此失败不会影响新事件拦截。
export async function cleanupBlockRuleStats(env, rule, projectName) {
  const db = requireStatsDb(env);
  const owner = crypto.randomUUID();
  if (!await acquireCleanupLock(db, projectName, owner)) {
    throw new Error('当前项目已有规则正在清理，请稍后重试');
  }
  try {
    const totals = await db.prepare('SELECT last_rollup_date AS lastRollupDate FROM stats_totals WHERE project_name = ?').bind(projectName).first();
    const progress = await getBlockRuleCleanupProgress(env, rule, projectName) || {};
    const previousUntil = progress.cleanedUntil || '';
    const upperDate = progress.status === 'stats_applied' ? previousUntil : (totals?.lastRollupDate || '');
    let statsApplied = progress.status === 'stats_applied';
    await saveBlockRuleCleanupProgress(env, rule, projectName, {
      cleanedUntil: previousUntil,
      status: statsApplied ? 'stats_applied' : 'running',
      error: '',
    });
    try {
      let result = { cleanedUntil: upperDate, removedEvents: 0 };
      if (!statsApplied && upperDate && upperDate > previousUntil.slice(0, 10)) {
        result = await applyStatsCleanup(env, rule, projectName, previousUntil, upperDate);
        statsApplied = true;
      } else if (!statsApplied) {
        await saveBlockRuleCleanupProgress(env, rule, projectName, { cleanedUntil: upperDate, status: 'stats_applied', error: '' });
        statsApplied = true;
      }
      if (upperDate) await rebuildResourceClicks(env, rule, projectName, upperDate);
      await saveBlockRuleCleanupProgress(env, rule, projectName, { cleanedUntil: upperDate, status: 'success', error: '' });
      return result;
    } catch (error) {
      await saveBlockRuleCleanupProgress(env, rule, projectName, {
        cleanedUntil: statsApplied ? upperDate : previousUntil,
        status: statsApplied ? 'stats_applied' : 'failed',
        error: error?.message || String(error),
      });
      throw error;
    }
  } finally {
    await releaseCleanupLock(db, projectName, owner);
  }
}
