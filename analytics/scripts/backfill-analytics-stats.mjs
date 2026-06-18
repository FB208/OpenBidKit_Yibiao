import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EVENTS, DATASET } from '../worker/src/constants.js';
import { queryAnalytics } from '../worker/src/services/analyticsQuery.js';
import { backfillClientActivityWindow, rebuildRetentionSnapshot, rollupStatsDay } from '../worker/src/services/analyticsStatsStore.js';
import { listAdminResources } from '../worker/src/services/resourceStore.js';
import { addBusinessDateDays, businessDateSqlExpression, getBusinessToday, sqlString } from '../worker/src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
const analyticsD1DatabaseName = 'openbidkit-analytics';
const resourceD1DatabaseName = 'openbidkit-resources';
const projectName = 'yibiao-client';
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

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

async function requestCloudflareJson(url, { method = 'GET', apiToken, body, context = {} } = {}) {
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
    const errors = data?.errors?.map((item) => item.message).filter(Boolean).join('; ');

    if (response.ok && data?.success) {
      return data;
    }

    const retryable = retryableStatuses.has(response.status) && attempt < 4;
    const details = [
      `${context.source || 'Cloudflare'} request failed`,
      `status=${response.status}`,
      `attempt=${attempt}`,
      context.sql ? `sql=${compactSql(context.sql)}` : '',
      context.params ? `params=${context.params.length}` : '',
      `body=${(errors || text || '').slice(0, 1000)}`,
    ].filter(Boolean).join('; ');

    if (!retryable) {
      throw new Error(details);
    }

    console.warn(`${details}; retrying`);
    await sleep(500 * attempt);
  }

  throw new Error(`${context.source || 'Cloudflare'} request failed after retries`);
}

function readRequiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function readCredentials() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim();
  if (!accountId) {
    throw new Error('Missing environment variable: CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID');
  }

  return {
    accountId,
    d1ApiToken: readRequiredEnv('CLOUDFLARE_API_TOKEN'),
    analyticsApiToken: readRequiredEnv('ANALYTICS_API_TOKEN'),
    analyticsDatabaseId: String(process.env.ANALYTICS_DB_ID || '').trim(),
    resourceDatabaseId: String(process.env.RESOURCE_DB_ID || '').trim(),
  };
}

function readBackfillDate() {
  const value = String(process.env.BACKFILL_DATE || '').trim();
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('BACKFILL_DATE must be YYYY-MM-DD.');
  }
  const today = getBusinessToday();
  if (value >= today) {
    throw new Error(`BACKFILL_DATE must be before ${today} Asia/Shanghai.`);
  }
  return value;
}

async function resolveD1DatabaseId(accountId, apiToken, databaseName, explicitDatabaseId) {
  if (explicitDatabaseId) return explicitDatabaseId;

  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=50`;
  const data = await requestCloudflareJson(api, { apiToken });
  const match = (data.result || []).find((item) => item.name === databaseName);
  if (!match?.uuid) {
    throw new Error(`Unable to find D1 database by name: ${databaseName}. Set the corresponding DB id in ${envPath}.`);
  }
  return match.uuid;
}

function normalizeD1Param(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

class RemoteD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new RemoteD1Statement(this.database, this.sql, bindings);
  }

  async all() {
    const result = await this.database.query(this.sql, this.bindings);
    return {
      results: result.results || [],
      meta: result.meta || {},
    };
  }

  async first() {
    const result = await this.all();
    return result.results[0] || null;
  }

  async run() {
    const result = await this.database.query(this.sql, this.bindings);
    return {
      meta: result.meta || {},
    };
  }
}

class RemoteD1Database {
  constructor({ accountId, databaseId, apiToken }) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
  }

  prepare(sql) {
    return new RemoteD1Statement(this, sql);
  }

  async query(sql, params = []) {
    const api = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const data = await requestCloudflareJson(api, {
      method: 'POST',
      apiToken: this.apiToken,
      body: {
        sql,
        params: params.map(normalizeD1Param),
      },
      context: {
        source: 'D1',
        sql,
        params,
      },
    });
    const result = Array.isArray(data.result) ? data.result[0] : data.result;
    if (!result) return { results: [], meta: {} };
    if (result.success === false) {
      throw new Error(`D1 query failed: sql=${compactSql(sql)}; result=${JSON.stringify(result).slice(0, 1000)}`);
    }
    return result;
  }
}

async function queryBackfillDates(env) {
  const today = getBusinessToday();
  const sql = `
    SELECT ${businessDateSqlExpression()} AS activityDate
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
      AND blob2 IN (${Array.from(ALLOWED_EVENTS).map((event) => sqlString(event)).join(', ')})
      AND ${businessDateSqlExpression()} < ${sqlString(today)}
    GROUP BY activityDate
    ORDER BY activityDate ASC
    LIMIT 100000
  `;
  const result = await queryAnalytics(env, sql);
  return (result.data || [])
    .map((row) => String(row.activityDate || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
}

async function readRollupStatus(db, activityDate) {
  const row = await db.prepare(`
    SELECT status
    FROM stats_rollup_runs
    WHERE project_name = ? AND activity_date = ?
  `).bind(projectName, activityDate).first();
  return String(row?.status || '');
}

async function hasDailyRow(db, activityDate) {
  const row = await db.prepare(`
    SELECT 1 AS existsFlag
    FROM stats_daily
    WHERE project_name = ? AND activity_date = ?
    LIMIT 1
  `).bind(projectName, activityDate).first();
  return Boolean(row?.existsFlag);
}

async function clearRollupStatus(db, activityDate) {
  await db.prepare(`
    DELETE FROM stats_rollup_runs
    WHERE project_name = ? AND activity_date = ?
  `).bind(projectName, activityDate).run();
}

async function clearRollupStages(db, activityDate) {
  await db.prepare(`
    DELETE FROM stats_rollup_stages
    WHERE project_name = ? AND activity_date = ?
  `).bind(projectName, activityDate).run();
}

async function ensureRollupStageTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stats_rollup_stages (
      project_name TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_name, activity_date, stage)
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stats_client_activity (
      project_name TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_created_date TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_name, activity_date, client_id)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_stats_client_activity_project_created
    ON stats_client_activity (project_name, client_created_date)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_stats_client_activity_project_date
    ON stats_client_activity (project_name, activity_date)
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stats_retention (
      project_name TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      range_days INTEGER NOT NULL,
      retention_day INTEGER NOT NULL,
      cohort_clients INTEGER NOT NULL DEFAULT 0,
      retained_clients INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_name, snapshot_date, range_days, retention_day)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_stats_retention_project_latest
    ON stats_retention (project_name, range_days, snapshot_date)
  `).run();
}

async function backfillOne(env, activityDate) {
  const status = await readRollupStatus(env.ANALYTICS_DB, activityDate);
  if (status === 'success') {
    console.log(`[skip] ${activityDate} already success`);
    return 'skipped';
  }
  if (status) {
    if (await hasDailyRow(env.ANALYTICS_DB, activityDate)) {
      throw new Error(`${activityDate} already has rollup status '${status}' and stats_daily data. Stop to avoid duplicated counters.`);
    }

    console.warn(`[retry] ${activityDate} has rollup status '${status}' but no stats_daily row. Clearing rollup status and retrying.`);
    await clearRollupStatus(env.ANALYTICS_DB, activityDate);
    await clearRollupStages(env.ANALYTICS_DB, activityDate);
  }

  console.log(`[run] ${activityDate}`);
  const result = await rollupStatsDay(env, projectName, activityDate, { updateResources: false });
  console.log(result.skipped ? `[skip] ${activityDate}` : `[done] ${activityDate}`);
  return result.skipped ? 'skipped' : 'completed';
}

async function backfillResourceClickTotals(env) {
  const resources = await listAdminResources(env, { origin: '' });
  if (!resources.length) {
    console.log('Resource click totals skipped: no resources found.');
    return;
  }

  const today = getBusinessToday();
  const result = await queryAnalytics(env, `
    SELECT blob9 AS resourceKey, SUM(_sample_interval) AS clickCount
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
      AND blob2 = 'resource_click'
      AND blob9 != ''
      AND ${businessDateSqlExpression()} < ${sqlString(today)}
    GROUP BY resourceKey
    LIMIT 100000
  `);
  const countByKey = new Map((result.data || []).map((row) => [String(row.resourceKey || ''), Number(row.clickCount || 0)]));
  let updated = 0;
  for (const resource of resources) {
    const clickCount = Math.max(0, Math.floor(countByKey.get(resource.analyticsKey) || 0));
    await env.RESOURCE_DB.prepare('UPDATE resources SET click_count = ? WHERE id = ?').bind(clickCount, resource.id).run();
    updated += 1;
  }

  console.log(`Resource click totals set from historical AE data. resources=${updated}, before=${today}`);
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('This script does not accept arguments. Configure analytics/scripts/.env and run npm run backfill:analytics-stats.');
  }

  loadEnv();
  const credentials = readCredentials();
  const analyticsDatabaseId = await resolveD1DatabaseId(
    credentials.accountId,
    credentials.d1ApiToken,
    analyticsD1DatabaseName,
    credentials.analyticsDatabaseId,
  );
  const resourceDatabaseId = await resolveD1DatabaseId(
    credentials.accountId,
    credentials.d1ApiToken,
    resourceD1DatabaseName,
    credentials.resourceDatabaseId,
  );
  const env = {
    ACCOUNT_ID: credentials.accountId,
    ANALYTICS_API_TOKEN: credentials.analyticsApiToken,
    ANALYTICS_DB: new RemoteD1Database({
      accountId: credentials.accountId,
      databaseId: analyticsDatabaseId,
      apiToken: credentials.d1ApiToken,
    }),
    RESOURCE_DB: new RemoteD1Database({
      accountId: credentials.accountId,
      databaseId: resourceDatabaseId,
      apiToken: credentials.d1ApiToken,
    }),
  };

  console.log('Analytics stats backfill');
  console.log(`Project: ${projectName}`);
  console.log(`Business date upper bound: before ${getBusinessToday()} Asia/Shanghai`);
  console.log(`Loaded .env: ${envPath}`);
  console.log(`Analytics D1 database: ${analyticsDatabaseId}`);
  console.log(`Resource D1 database: ${resourceDatabaseId}`);

  await ensureRollupStageTable(env.ANALYTICS_DB);

  const requestedDate = readBackfillDate();
  const dates = requestedDate ? [requestedDate] : await queryBackfillDates(env);
  if (!dates.length) {
    console.log('No historical Analytics Engine data found.');
    return;
  }

  console.log(requestedDate
    ? `Date: ${requestedDate}`
    : `Dates: ${dates[0]}..${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'} with data)`);

  const activityStartDate = addBusinessDateDays(dates[0], -30);
  const activityEndDate = dates[dates.length - 1];
  const activityResult = await backfillClientActivityWindow(env, projectName, activityStartDate, activityEndDate);
  console.log(`Client activity window backfilled: ${activityResult.startDate}..${activityResult.endDate}, rows=${activityResult.rows}`);

  const summary = { completed: 0, skipped: 0 };
  for (const activityDate of dates) {
    const status = await backfillOne(env, activityDate);
    await rebuildRetentionSnapshot(env, projectName, activityDate, 30);
    console.log(`[retention] ${activityDate}`);
    summary[status] += 1;
  }

  await backfillResourceClickTotals(env);

  console.log(`Backfill finished. completed=${summary.completed}, skipped=${summary.skipped}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
