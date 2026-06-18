import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../worker');
const workerConfigPath = resolve(workerDir, 'wrangler.jsonc');
const migrationsDir = resolve(workerDir, 'analytics-migrations');

const d1BindingName = 'ANALYTICS_DB';
const d1DatabaseName = 'openbidkit-analytics';
const dailyRollupCrons = [
  '0 17 * * *',
  '30 17 * * *',
  '0 18 * * *',
  '30 18 * * *',
  '0 19 * * *',
];

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

function normalizeD1Item(item) {
  return {
    id: String(item.uuid || item.id || item.database_id || '').trim(),
    name: String(item.name || item.database_name || '').trim(),
  };
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

function insertConfigArrayBlock(source, propertyName, objectBlock) {
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

function insertTopLevelObjectBlock(source, propertyName, objectBody) {
  const insertAt = source.lastIndexOf('\n}');
  if (insertAt === -1) {
    throw new Error('Unable to locate closing brace in wrangler.jsonc');
  }

  const block = `  "${propertyName}": {\n${objectBody}\n  }`;
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
  writeConfig(insertConfigArrayBlock(source, 'd1_databases', objectBlock));
}

function ensureCronTrigger() {
  let source = readConfig();
  const oldCron = '15 18 * * *';
  if (source.includes(`"${oldCron}"`)) {
    source = source.replace(`"${oldCron}"`, '"0 18 * * *"');
    writeConfig(source);
  }

  source = readConfig();
  const missingCrons = dailyRollupCrons.filter((cron) => !source.includes(`"${cron}"`));
  if (!missingCrons.length) {
    console.log(`Analytics staged daily rollup crons configured: ${dailyRollupCrons.join(', ')}`);
    return;
  }

  const cronsPattern = /"crons"\s*:\s*\[/;
  if (cronsPattern.test(source)) {
    writeConfig(source.replace(cronsPattern, `"crons": [\n      ${missingCrons.map((cron) => `"${cron}"`).join(',\n      ')},`));
    console.log(`Analytics staged daily rollup crons added: ${missingCrons.join(', ')}`);
    return;
  }

  writeConfig(insertTopLevelObjectBlock(source, 'triggers', `    "crons": [\n      ${dailyRollupCrons.map((cron) => `"${cron}"`).join(',\n      ')}\n    ]`));
  console.log(`Analytics staged daily rollup crons configured: ${dailyRollupCrons.join(', ')}`);
}

function printCredentialHelp(output) {
  if (output) {
    console.error(output);
  }
  console.error([
    'Unable to create or find Cloudflare D1 resources for analytics stats.',
    'For CI, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID with D1 and Worker deployment permissions.',
    'For local setup, run `npx wrangler login` or set CLOUDFLARE_API_TOKEN before `npm run setup:analytics-storage`.',
  ].join('\n'));
}

function listD1Databases() {
  const result = runWrangler(['d1', 'list', '--json']);
  if (result.status !== 0) {
    return { ok: false, output: result.output, items: [] };
  }
  return { ok: true, output: result.output, items: parseJsonArrayFromOutput(result.output).map(normalizeD1Item) };
}

function ensureD1Database() {
  const configuredId = getConfiguredD1DatabaseId(readConfig());
  const envDatabaseId = String(process.env.ANALYTICS_DB_ID || '').trim();

  if (envDatabaseId) {
    updateD1Config(envDatabaseId);
    console.log(`ANALYTICS_DB D1 database configured from ANALYTICS_DB_ID: ${envDatabaseId}`);
    return envDatabaseId;
  }

  const listResult = listD1Databases();
  if (listResult.ok) {
    const configured = configuredId ? listResult.items.find((item) => item.id === configuredId) : null;
    if (configured?.id) {
      console.log(`ANALYTICS_DB D1 database already configured: ${configured.id}`);
      return configured.id;
    }

    const existingByName = listResult.items.find((item) => item.name === d1DatabaseName);
    if (existingByName?.id) {
      updateD1Config(existingByName.id);
      console.log(`ANALYTICS_DB D1 database reused: ${existingByName.id}`);
      return existingByName.id;
    }
  } else if (configuredId) {
    console.warn('Unable to verify configured ANALYTICS_DB, using current wrangler.jsonc database_id.');
    console.warn(listResult.output);
    return configuredId;
  }

  const createResult = runWrangler(['d1', 'create', d1DatabaseName]);
  if (createResult.status !== 0 && !/already exists/i.test(createResult.output)) {
    printCredentialHelp(createResult.output || listResult.output);
    process.exit(createResult.status || 1);
  }

  let databaseId = parseD1CreateId(createResult.output);
  if (!databaseId) {
    const retryListResult = listD1Databases();
    if (retryListResult.ok) {
      databaseId = retryListResult.items.find((item) => item.name === d1DatabaseName)?.id || '';
    }
  }

  if (!databaseId) {
    console.error(createResult.output || listResult.output);
    throw new Error('Unable to parse D1 database id from Wrangler output.');
  }

  updateD1Config(databaseId);
  console.log(`ANALYTICS_DB D1 database created and configured: ${databaseId}`);
  return databaseId;
}

function applyAnalyticsMigrations() {
  const files = readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  for (const fileName of files) {
    const filePath = resolve(migrationsDir, fileName);
    const result = runWrangler(['d1', 'execute', d1BindingName, '--remote', '--file', filePath]);
    if (result.status !== 0) {
      console.error(result.output);
      process.exit(result.status || 1);
    }
    console.log(`ANALYTICS_DB migration applied: ${fileName}`);
  }
}

function ensureAnalyticsColumns() {
  const columns = [
    {
      table: 'stats_versions',
      column: 'client_count',
      sql: 'ALTER TABLE stats_versions ADD COLUMN client_count INTEGER NOT NULL DEFAULT 0',
    },
    {
      table: 'stats_models',
      column: 'total_tokens',
      sql: 'ALTER TABLE stats_models ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      table: 'stats_clients',
      column: 'last_access_ip',
      sql: 'ALTER TABLE stats_clients ADD COLUMN last_access_ip TEXT NOT NULL DEFAULT \'\'',
    },
  ];

  for (const item of columns) {
    const result = runWrangler(['d1', 'execute', d1BindingName, '--remote', '--command', item.sql]);
    if (result.status === 0) {
      console.log(`ANALYTICS_DB column added: ${item.table}.${item.column}`);
      continue;
    }

    if (/duplicate column name|already exists/i.test(result.output)) {
      console.log(`ANALYTICS_DB column already exists: ${item.table}.${item.column}`);
      continue;
    }

    console.error(result.output);
    process.exit(result.status || 1);
  }
}

function ensureAnalyticsIndexes() {
  const indexes = [
    {
      name: 'idx_stats_clients_project_last_access_ip',
      sql: 'CREATE INDEX IF NOT EXISTS idx_stats_clients_project_last_access_ip ON stats_clients (project_name, last_access_ip)',
    },
  ];

  for (const item of indexes) {
    const result = runWrangler(['d1', 'execute', d1BindingName, '--remote', '--command', item.sql]);
    if (result.status === 0) {
      console.log(`ANALYTICS_DB index ensured: ${item.name}`);
      continue;
    }

    console.error(result.output);
    process.exit(result.status || 1);
  }
}

ensureD1Database();
ensureCronTrigger();
applyAnalyticsMigrations();
ensureAnalyticsColumns();
ensureAnalyticsIndexes();
