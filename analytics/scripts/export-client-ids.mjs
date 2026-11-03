import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
const outputDir = resolve(__dirname, 'exports');
const databaseName = 'openbidkit-analytics';
const pageSize = 2000;
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function readRequiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function requestCloudflareJson(url, { method = 'GET', apiToken, body } = {}) {
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

    if (response.ok && data?.success) return data;

    const errors = data?.errors?.map((item) => item.message).filter(Boolean).join('; ');
    const details = `Cloudflare request failed; status=${response.status}; attempt=${attempt}; body=${(errors || text || '').slice(0, 1000)}`;
    if (!retryableStatuses.has(response.status) || attempt === 4) {
      throw new Error(details);
    }
    console.warn(`${details}; retrying`);
    await sleep(500 * attempt);
  }

  throw new Error('Cloudflare request failed after retries');
}

async function resolveDatabaseId(accountId, apiToken) {
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=50`;
  const data = await requestCloudflareJson(api, { apiToken });
  const match = (data.result || []).find((item) => item.name === databaseName);
  if (!match?.uuid) {
    throw new Error(`Unable to find D1 database: ${databaseName}`);
  }
  return match.uuid;
}

async function queryD1(accountId, databaseId, apiToken, sql, params) {
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const data = await requestCloudflareJson(api, {
    method: 'POST',
    apiToken,
    body: { sql, params },
  });
  const result = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!result || result.success === false) {
    throw new Error(`D1 query failed: ${JSON.stringify(result || data).slice(0, 1000)}`);
  }
  return result.results || [];
}

async function exportClientIds(accountId, databaseId, apiToken) {
  const clientIds = [];
  let cursor = '';

  while (true) {
    const rows = await queryD1(
      accountId,
      databaseId,
      apiToken,
      `SELECT DISTINCT client_id
       FROM stats_clients
       WHERE client_id > ?
       ORDER BY client_id
       LIMIT ?`,
      [cursor, pageSize],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const clientId = String(row.client_id || '').trim();
      if (clientId) clientIds.push(clientId);
    }

    cursor = String(rows[rows.length - 1].client_id || '');
    console.log(`fetched ${clientIds.length}`);
    if (rows.length < pageSize) break;
  }

  return clientIds;
}

async function main() {
  loadEnv();
  const accountId = readRequiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = readRequiredEnv('CLOUDFLARE_API_TOKEN');
  const databaseId = await resolveDatabaseId(accountId, apiToken);
  const clientIds = await exportClientIds(accountId, databaseId, apiToken);

  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outputPath = resolve(outputDir, `client-ids-${stamp}.txt`);
  writeFileSync(outputPath, `${clientIds.join('\n')}${clientIds.length ? '\n' : ''}`, 'utf8');
  console.log(`exported ${clientIds.length} client ids to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
