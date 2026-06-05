import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../worker');
const workerConfigPath = resolve(workerDir, 'wrangler.jsonc');

const d1BindingName = 'RESOURCE_DB';
const d1DatabaseName = 'openbidkit-resources';
const r2BindingName = 'RESOURCE_BUCKET';
const r2BucketName = 'openbidkit';

function readConfig() {
  return readFileSync(workerConfigPath, 'utf8');
}

function writeConfig(source) {
  writeFileSync(workerConfigPath, source, 'utf8');
}

function runWrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();

  return {
    status: result.status ?? 1,
    output,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonArrayFromOutput(output) {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      return [];
    }

    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function parseD1List(output) {
  const items = parseJsonArrayFromOutput(output);
  const exact = items.find((item) => String(item.name || item.database_name || '') === d1DatabaseName);
  const id = exact?.uuid || exact?.id || exact?.database_id || '';
  return id ? String(id) : '';
}

function parseD1CreateId(output) {
  const patterns = [
    /database_id\s*=\s*"([^"]+)"/i,
    /"database_id"\s*:\s*"([^"]+)"/i,
    /"uuid"\s*:\s*"([^"]+)"/i,
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return '';
}

function getConfiguredD1DatabaseId(source) {
  const escapedBinding = escapeRegExp(d1BindingName);
  const pattern = new RegExp(`\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"database_id"\\s*:\\s*"([^"]*)"[\\s\\S]*?\\}`);
  const id = source.match(pattern)?.[1]?.trim() || '';
  return id && !id.includes('<') ? id : '';
}

function hasR2BucketBinding(source) {
  const escapedBinding = escapeRegExp(r2BindingName);
  const escapedBucket = escapeRegExp(r2BucketName);
  const pattern = new RegExp(`\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"bucket_name"\\s*:\\s*"${escapedBucket}"[\\s\\S]*?\\}`);
  return pattern.test(source);
}

function insertConfigBlock(source, propertyName, objectBlock) {
  const propertyPattern = new RegExp(`"${escapeRegExp(propertyName)}"\\s*:\\s*\\[`);
  if (propertyPattern.test(source)) {
    return source.replace(propertyPattern, `"${propertyName}": [\n    ${objectBlock},`);
  }

  const insertAt = source.lastIndexOf('\n}');
  if (insertAt === -1) {
    throw new Error('Unable to locate closing brace in wrangler.jsonc');
  }

  const block = `  "${propertyName}": [\n    ${objectBlock}\n  ]`;
  return `${source.slice(0, insertAt)},\n${block}${source.slice(insertAt)}`;
}

function updateD1Config(databaseId) {
  const source = readConfig();
  const escapedBinding = escapeRegExp(d1BindingName);
  const bindingObjectPattern = new RegExp(`(\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"database_id"\\s*:\\s*")[^"]*("[\\s\\S]*?\\})`);

  if (bindingObjectPattern.test(source)) {
    writeConfig(source.replace(bindingObjectPattern, `$1${databaseId}$2`));
    return;
  }

  const objectBlock = `{
      "binding": "${d1BindingName}",
      "database_name": "${d1DatabaseName}",
      "database_id": "${databaseId}"
    }`;
  writeConfig(insertConfigBlock(source, 'd1_databases', objectBlock));
}

function updateR2Config() {
  const source = readConfig();
  if (hasR2BucketBinding(source)) {
    return;
  }

  const objectBlock = `{
      "binding": "${r2BindingName}",
      "bucket_name": "${r2BucketName}"
    }`;
  writeConfig(insertConfigBlock(source, 'r2_buckets', objectBlock));
}

function printCredentialHelp(output) {
  if (output) {
    console.error(output);
  }
  console.error([
    'Unable to create or find Cloudflare D1/R2 resources for resource management.',
    'For CI, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID with D1, R2, KV and Worker deployment permissions.',
    'For local setup, run `npx wrangler login` or set CLOUDFLARE_API_TOKEN before `npm run setup:resources`.',
  ].join('\n'));
}

function ensureD1Database() {
  const configuredId = getConfiguredD1DatabaseId(readConfig());
  if (configuredId) {
    console.log(`RESOURCE_DB D1 database already configured: ${configuredId}`);
    return configuredId;
  }

  const envDatabaseId = String(process.env.RESOURCE_DB_ID || '').trim();
  if (envDatabaseId) {
    updateD1Config(envDatabaseId);
    console.log(`RESOURCE_DB D1 database configured from RESOURCE_DB_ID: ${envDatabaseId}`);
    return envDatabaseId;
  }

  const listResult = runWrangler(['d1', 'list', '--json']);
  if (listResult.status === 0) {
    const existingId = parseD1List(listResult.output);
    if (existingId) {
      updateD1Config(existingId);
      console.log(`RESOURCE_DB D1 database reused: ${existingId}`);
      return existingId;
    }
  }

  const createResult = runWrangler(['d1', 'create', d1DatabaseName]);
  if (createResult.status !== 0 && !/already exists/i.test(createResult.output)) {
    printCredentialHelp(createResult.output || listResult.output);
    process.exit(createResult.status || 1);
  }

  let databaseId = parseD1CreateId(createResult.output);
  if (!databaseId) {
    const retryListResult = runWrangler(['d1', 'list', '--json']);
    if (retryListResult.status === 0) {
      databaseId = parseD1List(retryListResult.output);
    }
  }

  if (!databaseId) {
    console.error(createResult.output || listResult.output);
    throw new Error('Unable to parse D1 database id from Wrangler output.');
  }

  updateD1Config(databaseId);
  console.log(`RESOURCE_DB D1 database created and configured: ${databaseId}`);
  return databaseId;
}

function ensureR2Bucket() {
  if (hasR2BucketBinding(readConfig())) {
    console.log(`RESOURCE_BUCKET R2 bucket already configured: ${r2BucketName}`);
    return;
  }

  const infoResult = runWrangler(['r2', 'bucket', 'info', r2BucketName]);
  if (infoResult.status === 0) {
    updateR2Config();
    console.log(`RESOURCE_BUCKET R2 bucket reused: ${r2BucketName}`);
    return;
  }

  const createResult = runWrangler(['r2', 'bucket', 'create', r2BucketName]);
  if (createResult.status !== 0 && !/already exists/i.test(createResult.output)) {
    printCredentialHelp(createResult.output || infoResult.output);
    process.exit(createResult.status || 1);
  }

  updateR2Config();
  console.log(`RESOURCE_BUCKET R2 bucket created and configured: ${r2BucketName}`);
}

function applyD1Migrations() {
  const result = runWrangler(['d1', 'migrations', 'apply', d1BindingName, '--remote']);
  if (result.status !== 0) {
    console.error(result.output);
    process.exit(result.status || 1);
  }

  console.log('RESOURCE_DB D1 migrations applied.');
}

ensureD1Database();
ensureR2Bucket();
applyD1Migrations();
