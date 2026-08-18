import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBusinessDateTime } from '../worker/src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
const analyticsD1DatabaseName = 'openbidkit-analytics';
const projectName = 'yibiao-client';
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

// 读取与现有 Analytics 回填脚本共用的本地凭据文件。
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
    analyticsDatabaseId: String(process.env.ANALYTICS_DB_ID || '').trim(),
  };
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

// 从已有模型历史统计覆盖回填概览 AI 指标。
async function backfillOverviewAiTotals(db, updatedAt) {
  await db.prepare(`
    INSERT INTO stats_totals (
      project_name,
      total_text_tokens,
      total_generated_images,
      updated_at
    ) VALUES (
      ?,
      COALESCE((
        SELECT SUM(total_tokens)
        FROM stats_models
        WHERE project_name = ? AND request_type = 'text'
      ), 0),
      COALESCE((
        SELECT SUM(request_count)
        FROM stats_models
        WHERE project_name = ? AND request_type = 'image'
      ), 0),
      ?
    )
    ON CONFLICT(project_name) DO UPDATE SET
      total_text_tokens = excluded.total_text_tokens,
      total_generated_images = excluded.total_generated_images,
      updated_at = excluded.updated_at
  `).bind(projectName, projectName, projectName, updatedAt).run();

  const result = await db.prepare(`
    SELECT total_text_tokens AS totalTextTokens, total_generated_images AS totalGeneratedImages
    FROM stats_totals
    WHERE project_name = ?
  `).bind(projectName).all();
  return result.results?.[0] || {};
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('This script does not accept arguments. Configure analytics/scripts/.env and run npm run backfill:overview-ai-totals.');
  }

  loadEnv();
  const credentials = readCredentials();
  const analyticsDatabaseId = await resolveD1DatabaseId(
    credentials.accountId,
    credentials.d1ApiToken,
    analyticsD1DatabaseName,
    credentials.analyticsDatabaseId,
  );
  const db = new RemoteD1Database({
    accountId: credentials.accountId,
    databaseId: analyticsDatabaseId,
    apiToken: credentials.d1ApiToken,
  });

  console.log('Overview AI totals backfill');
  console.log(`Project: ${projectName}`);
  console.log(`Loaded .env: ${envPath}`);
  console.log(`Analytics D1 database: ${analyticsDatabaseId}`);

  const totals = await backfillOverviewAiTotals(db, formatBusinessDateTime(new Date()));
  console.log(`Total text tokens: ${Number(totals.totalTextTokens || 0)}`);
  console.log(`Total generated images: ${Number(totals.totalGeneratedImages || 0)}`);
  console.log('Overview AI totals backfill finished.');
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
