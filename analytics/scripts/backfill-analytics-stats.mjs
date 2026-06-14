import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EVENTS, DATASET } from '../worker/src/constants.js';
import { queryAnalytics } from '../worker/src/services/analyticsQuery.js';
import { rollupStatsDay } from '../worker/src/services/analyticsStatsStore.js';
import { businessDateSqlExpression, getBusinessToday, sqlString } from '../worker/src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
const d1DatabaseName = 'openbidkit-analytics';
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
    databaseId: String(process.env.ANALYTICS_DB_ID || '').trim(),
  };
}

async function resolveD1DatabaseId(accountId, apiToken, explicitDatabaseId) {
  if (explicitDatabaseId) return explicitDatabaseId;

  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(d1DatabaseName)}&per_page=50`;
  const data = await requestCloudflareJson(api, { apiToken });
  const match = (data.result || []).find((item) => item.name === d1DatabaseName);
  if (!match?.uuid) {
    throw new Error(`Unable to find D1 database by name: ${d1DatabaseName}. Set ANALYTICS_DB_ID in ${envPath}.`);
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
  }

  console.log(`[run] ${activityDate}`);
  const result = await rollupStatsDay(env, projectName, activityDate);
  console.log(result.skipped ? `[skip] ${activityDate}` : `[done] ${activityDate}`);
  return result.skipped ? 'skipped' : 'completed';
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('This script does not accept arguments. Configure analytics/scripts/.env and run npm run backfill:analytics-stats.');
  }

  loadEnv();
  const credentials = readCredentials();
  const databaseId = await resolveD1DatabaseId(credentials.accountId, credentials.d1ApiToken, credentials.databaseId);
  const env = {
    ACCOUNT_ID: credentials.accountId,
    ANALYTICS_API_TOKEN: credentials.analyticsApiToken,
    ANALYTICS_DB: new RemoteD1Database({
      accountId: credentials.accountId,
      databaseId,
      apiToken: credentials.d1ApiToken,
    }),
  };

  console.log('Analytics stats backfill');
  console.log(`Project: ${projectName}`);
  console.log(`Business date upper bound: before ${getBusinessToday()} Asia/Shanghai`);
  console.log(`Loaded .env: ${envPath}`);
  console.log(`D1 database: ${databaseId}`);

  const dates = await queryBackfillDates(env);
  if (!dates.length) {
    console.log('No historical Analytics Engine data found.');
    return;
  }

  console.log(`Dates: ${dates[0]}..${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'} with data)`);
  const summary = { completed: 0, skipped: 0 };
  for (const activityDate of dates) {
    const status = await backfillOne(env, activityDate);
    summary[status] += 1;
  }

  console.log(`Backfill finished. completed=${summary.completed}, skipped=${summary.skipped}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
