import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET } from '../worker/src/constants.js';
import { queryAnalytics } from '../worker/src/services/analyticsQuery.js';
import { addBusinessDateDays, businessDateSqlExpression, formatBusinessDateTime, getBusinessToday, normalizeText, sqlString } from '../worker/src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
const analyticsD1DatabaseName = 'openbidkit-analytics';
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
    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
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
    throw new Error(`Unable to find D1 database by name: ${databaseName}. Set ANALYTICS_DB_ID in ${envPath}.`);
  }
  return match.uuid;
}

function normalizeD1Param(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
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

function number(value) {
  return Number(value || 0);
}

// 与 Worker chunkRows 同一口径：按 JSON 体积分块，避免单条 D1 语句参数过大。
const BULK_JSON_MAX_LENGTH = 700000;

function chunkRows(rows) {
  const chunks = [];
  let chunk = [];
  let chunkLength = 2;

  for (const row of rows || []) {
    const item = JSON.stringify(row);
    if (item.length + 2 > BULK_JSON_MAX_LENGTH) {
      throw new Error(`backfill row is too large: ${item.length}`);
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

async function ensureColumn(db, table, column, sql) {
  try {
    await db.prepare(sql).run();
    console.log(`Column added: ${table}.${column}`);
  } catch (error) {
    const message = error?.message || String(error);
    if (/duplicate column name|already exists/i.test(message)) {
      console.log(`Column already exists: ${table}.${column}`);
      return;
    }
    throw error;
  }
}

async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stats_models_daily (
      project_name TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      request_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      endpoint_host TEXT NOT NULL,
      model TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_name, activity_date, request_type, provider, endpoint_host, model)
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_stats_models_daily_project_date
    ON stats_models_daily (project_name, activity_date, request_type)
  `).run();
  console.log('stats_models_daily table ensured.');

  for (const column of ['text_request_count', 'text_total_tokens', 'image_request_count', 'image_total_tokens']) {
    await ensureColumn(db, 'stats_daily', column, `ALTER TABLE stats_daily ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

// 与 Worker models stage 同一口径：按天、请求类型、服务商、域名、模型聚合 ai_request。
async function queryModelDailyRows(env, backfillDate) {
  const today = getBusinessToday();
  const dateCondition = backfillDate
    ? `${businessDateSqlExpression()} = ${sqlString(backfillDate)}`
    : `${businessDateSqlExpression()} < ${sqlString(today)}`;
  const result = await queryAnalytics(env, `
    SELECT
      ${businessDateSqlExpression()} AS activityDate,
      blob12 AS requestType,
      blob9 AS provider,
      blob10 AS endpointHost,
      blob11 AS model,
      SUM(_sample_interval) AS requestCount,
      SUM(double4 * _sample_interval) AS totalTokens
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
      AND blob2 = 'ai_request'
      AND blob12 IN ('text', 'image')
      AND blob11 != ''
      AND ${dateCondition}
    GROUP BY activityDate, requestType, provider, endpointHost, model
    ORDER BY activityDate ASC, requestType ASC, provider ASC, endpointHost ASC, model ASC
    LIMIT 100000
  `);

  // 达到上限说明结果被截断：尾部日期不完整，不能继续写哨兵标记为已覆盖，改按 BACKFILL_DATE 单日回填。
  if ((result.data || []).length >= 100000) {
    throw new Error('AE result hit row limit (100000); rerun per-day with BACKFILL_DATE=YYYY-MM-DD to avoid marking truncated dates complete.');
  }

  return (result.data || []).map((row) => ({
    activityDate: String(row.activityDate || '').slice(0, 10),
    requestType: normalizeText(row.requestType, 20),
    provider: normalizeText(row.provider, 80),
    endpointHost: normalizeText(row.endpointHost, 120),
    model: normalizeText(row.model, 160),
    requestCount: number(row.requestCount),
    totalTokens: number(row.totalTokens),
  })).filter((row) => row.activityDate && row.requestType && row.model && row.requestCount > 0);
}

async function writeDailyRows(db, activityDate, rows, updatedAt) {
  const payloads = rows.map((row) => ({
    requestType: row.requestType,
    provider: row.provider,
    endpointHost: row.endpointHost,
    model: row.model,
    requestCount: row.requestCount,
    totalTokens: row.totalTokens,
  }));

  for (const chunk of chunkRows(payloads)) {
    const json = JSON.stringify(chunk);
    await db.prepare(`
      WITH rows AS (
        SELECT
          json_extract(item.value, '$.requestType') AS request_type,
          json_extract(item.value, '$.provider') AS provider,
          json_extract(item.value, '$.endpointHost') AS endpoint_host,
          json_extract(item.value, '$.model') AS model,
          CAST(json_extract(item.value, '$.requestCount') AS INTEGER) AS request_count,
          CAST(json_extract(item.value, '$.totalTokens') AS INTEGER) AS total_tokens
        FROM json_each(?) AS item
      )
      INSERT INTO stats_models_daily (project_name, activity_date, request_type, provider, endpoint_host, model, request_count, total_tokens, updated_at)
      SELECT ?, ?, request_type, provider, endpoint_host, model, request_count, total_tokens, ?
      FROM rows
      WHERE request_type != '' AND model != ''
      ON CONFLICT(project_name, activity_date, request_type, provider, endpoint_host, model) DO UPDATE SET
        request_count = excluded.request_count,
        total_tokens = excluded.total_tokens,
        updated_at = excluded.updated_at
    `).bind(json, projectName, activityDate, updatedAt).run();
  }
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

// 只做 UPDATE 不做 INSERT：stats_daily 行不存在说明该天 daily stage 未汇总过，
// 不能制造"仅有模型列"的行，否则 rollupStatsDay 会把该天误判为已完成、跳过整天汇总。
async function writeDailyTotals(db, activityDate, rows, updatedAt) {
  const totals = { text: { count: 0, tokens: 0 }, image: { count: 0, tokens: 0 } };
  for (const row of rows) {
    const bucket = totals[row.requestType];
    if (!bucket) continue;
    bucket.count += number(row.requestCount);
    bucket.tokens += number(row.totalTokens);
  }

  await db.prepare(`
    UPDATE stats_daily
    SET
      text_request_count = ?,
      text_total_tokens = ?,
      image_request_count = ?,
      image_total_tokens = ?,
      updated_at = ?
    WHERE project_name = ? AND activity_date = ?
  `).bind(totals.text.count, totals.text.tokens, totals.image.count, totals.image.tokens, updatedAt, projectName, activityDate).run();
}

// 与 Worker runModelsStage 同口径：当天全部明细与汇总写完后落完成哨兵行，
// 查询侧以哨兵划分 D1/AE 覆盖范围，写了一半中断的日期会自动交回 AE。
async function writeDailyDone(db, activityDate, updatedAt) {
  await db.prepare(`
    INSERT INTO stats_models_daily (project_name, activity_date, request_type, provider, endpoint_host, model, request_count, total_tokens, updated_at)
    VALUES (?, ?, '', '', '', '', 0, 0, ?)
    ON CONFLICT(project_name, activity_date, request_type, provider, endpoint_host, model) DO UPDATE SET
      updated_at = excluded.updated_at
  `).bind(projectName, activityDate, updatedAt).run();
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('This script does not accept arguments. Configure analytics/scripts/.env and run npm run backfill:models-daily.');
  }

  loadEnv();
  const credentials = readCredentials();
  const analyticsDatabaseId = await resolveD1DatabaseId(
    credentials.accountId,
    credentials.d1ApiToken,
    analyticsD1DatabaseName,
    credentials.analyticsDatabaseId,
  );
  const env = {
    ACCOUNT_ID: credentials.accountId,
    ANALYTICS_API_TOKEN: credentials.analyticsApiToken,
    ANALYTICS_DB: new RemoteD1Database({
      accountId: credentials.accountId,
      databaseId: analyticsDatabaseId,
      apiToken: credentials.d1ApiToken,
    }),
  };
  const db = env.ANALYTICS_DB;

  console.log('Models daily stats backfill');
  console.log(`Project: ${projectName}`);
  console.log(`Business date upper bound: before ${getBusinessToday()} Asia/Shanghai`);
  console.log(`Loaded .env: ${envPath}`);
  console.log(`Analytics D1 database: ${analyticsDatabaseId}`);

  await ensureSchema(db);

  const backfillDate = readBackfillDate();
  const rows = await queryModelDailyRows(env, backfillDate);
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.activityDate)) byDate.set(row.activityDate, []);
    byDate.get(row.activityDate).push(row);
  }
  if (!byDate.size && !backfillDate) {
    console.log('No ai_request rows found in Analytics Engine window.');
    return;
  }
  const dataDates = Array.from(byDate.keys()).sort();
  // 从最早有数据日到昨天连续补齐哨兵：查询窗口内没有模型行的日期已被 AE 证明为零用量，
  // 同样写哨兵，避免查询侧为已覆盖的零用量日期重复回退到 AE。
  const dates = backfillDate ? [backfillDate] : (() => {
    const list = [];
    for (let cursor = dataDates[0]; cursor < getBusinessToday(); cursor = addBusinessDateDays(cursor, 1)) {
      list.push(cursor);
    }
    return list;
  })();
  console.log(backfillDate
    ? `Date: ${backfillDate}`
    : `Dates: ${dates[0]}..${dates[dates.length - 1]} (${dates.length} days, ${dataDates.length} with model rows)`);

  const updatedAt = formatBusinessDateTime(new Date());
  let writtenRows = 0;
  for (const activityDate of dates) {
    const dayRows = byDate.get(activityDate) || [];
    if (dayRows.length) {
      await writeDailyRows(db, activityDate, dayRows, updatedAt);
    }
    // stats_daily 行缺失 = 该天完整汇总未跑过：不写模型列和哨兵，留给完整 rollup。
    if (await hasDailyRow(db, activityDate)) {
      if (dayRows.length) {
        await writeDailyTotals(db, activityDate, dayRows, updatedAt);
      }
      await writeDailyDone(db, activityDate, updatedAt);
    } else {
      console.warn(`[skip] ${activityDate} has no stats_daily row (daily stage not rolled); left for full rollup`);
    }
    writtenRows += dayRows.length;
    console.log(`[done] ${activityDate} rows=${dayRows.length}`);
  }

  console.log(`Models daily backfill finished. days=${dates.length}, rows=${writtenRows}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
