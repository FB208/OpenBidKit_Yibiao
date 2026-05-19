import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerConfigPath = resolve(__dirname, '../worker/wrangler.jsonc');
const bindingName = 'NOTICE_STORE';

function readConfig() {
  return readFileSync(workerConfigPath, 'utf8');
}

function getWorkerName(source) {
  return source.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || '';
}

function getConfiguredNamespaceId(source) {
  const escapedBinding = bindingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"id"\\s*:\\s*"([^"]*)"[\\s\\S]*?\\}`);
  const id = source.match(pattern)?.[1]?.trim() || '';
  return id && !id.includes('<') ? id : '';
}

function runWrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();

  return {
    status: result.status ?? 1,
    output,
  };
}

function parseNamespaceId(output) {
  const patterns = [
    /id\s*=\s*"([^"]+)"/i,
    /"id"\s*:\s*"([^"]+)"/i,
    /id[:=]\s*([0-9a-f]{32})/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return '';
}

function parseNamespaceList(output, workerName) {
  const preferredTitles = new Set([
    bindingName,
    workerName ? `${workerName}-${bindingName}` : '',
  ].filter(Boolean));
  let namespaces;

  try {
    namespaces = JSON.parse(output);
  } catch {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      return parseTextNamespaceList(output, preferredTitles);
    }

    try {
      namespaces = JSON.parse(output.slice(start, end + 1));
    } catch {
      return parseTextNamespaceList(output, preferredTitles);
    }
  }

  const items = Array.isArray(namespaces) ? namespaces : [];

  const exact = items.find((item) => preferredTitles.has(String(item.title || '')));
  if (exact?.id) {
    return exact.id;
  }

  const suffix = items.find((item) => String(item.title || '').endsWith(`-${bindingName}`));
  if (suffix?.id) {
    return suffix.id;
  }

  const textId = parseTextNamespaceList(output, preferredTitles);
  if (textId) {
    return textId;
  }

  return '';
}

function parseTextNamespaceList(output, preferredTitles) {
  const lines = String(output || '').split(/\r?\n/);
  const hexIdPattern = /\b[0-9a-f]{32}\b/i;

  for (const title of preferredTitles) {
    for (const line of lines) {
      if (!line.includes(title)) {
        continue;
      }

      const id = line.match(hexIdPattern)?.[0] || '';
      if (id) {
        return id;
      }
    }
  }

  for (const line of lines) {
    const cells = line.split('│').map((cell) => cell.trim()).filter(Boolean);
    const id = cells.find((cell) => hexIdPattern.test(cell))?.match(hexIdPattern)?.[0] || '';
    if (!id) {
      continue;
    }

    const title = cells.find((cell) => preferredTitles.has(cell) || cell.endsWith(`-${bindingName}`));
    if (title) {
      return id;
    }
  }

  return '';
}

function updateWranglerConfig(namespaceId) {
  const source = readConfig();
  const escapedBinding = bindingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bindingObjectPattern = new RegExp(`(\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"id"\\s*:\\s*")[^"]*("[\\s\\S]*?\\})`);

  if (bindingObjectPattern.test(source)) {
    writeFileSync(workerConfigPath, source.replace(bindingObjectPattern, `$1${namespaceId}$2`), 'utf8');
    return;
  }

  const namespaceBlock = `  "kv_namespaces": [\n    {\n      "binding": "${bindingName}",\n      "id": "${namespaceId}"\n    }\n  ]`;
  const existingKvPattern = /"kv_namespaces"\s*:\s*\[/;
  if (existingKvPattern.test(source)) {
    const updated = source.replace(existingKvPattern, `"kv_namespaces": [\n    {\n      "binding": "${bindingName}",\n      "id": "${namespaceId}"\n    },`);
    writeFileSync(workerConfigPath, updated, 'utf8');
    return;
  }

  const insertAt = source.lastIndexOf('\n}');
  if (insertAt === -1) {
    throw new Error('Unable to locate closing brace in wrangler.jsonc');
  }

  const updated = `${source.slice(0, insertAt)},\n${namespaceBlock}${source.slice(insertAt)}`;
  writeFileSync(workerConfigPath, updated, 'utf8');
}

function printCredentialHelp(output) {
  if (output) {
    console.error(output);
  }
  console.error([
    'Unable to create or find Cloudflare KV namespace NOTICE_STORE.',
    'For CI, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment that runs analytics/worker deployment.',
    'For local setup, run `npx wrangler login` or set CLOUDFLARE_API_TOKEN before `npm run setup:notice-kv`.',
  ].join('\n'));
}

const source = readConfig();
const configuredId = getConfiguredNamespaceId(source);
if (configuredId) {
  console.log(`NOTICE_STORE KV namespace already configured: ${configuredId}`);
  process.exit(0);
}

const envNamespaceId = String(process.env.NOTICE_STORE_ID || '').trim();
if (envNamespaceId) {
  updateWranglerConfig(envNamespaceId);
  console.log(`NOTICE_STORE KV namespace configured from NOTICE_STORE_ID: ${envNamespaceId}`);
  process.exit(0);
}

const workerName = getWorkerName(source);
const listResult = runWrangler(['kv', 'namespace', 'list']);
if (listResult.status === 0) {
  const existingId = parseNamespaceList(listResult.output, workerName);
  if (existingId) {
    updateWranglerConfig(existingId);
    console.log(`NOTICE_STORE KV namespace reused: ${existingId}`);
    process.exit(0);
  }
}

const createResult = runWrangler(['kv', 'namespace', 'create', bindingName]);
if (createResult.status !== 0) {
  if (/already exists/i.test(createResult.output)) {
    const retryListResult = runWrangler(['kv', 'namespace', 'list']);
    if (retryListResult.status === 0) {
      const existingId = parseNamespaceList(retryListResult.output, workerName);
      if (existingId) {
        updateWranglerConfig(existingId);
        console.log(`NOTICE_STORE KV namespace reused after create conflict: ${existingId}`);
        process.exit(0);
      }
    }
  }

  printCredentialHelp(createResult.output || listResult.output);
  process.exit(createResult.status || 1);
}

const namespaceId = parseNamespaceId(createResult.output);
if (!namespaceId) {
  console.error(createResult.output);
  throw new Error('Unable to parse KV namespace id from Wrangler output.');
}

updateWranglerConfig(namespaceId);
console.log(`NOTICE_STORE KV namespace created and configured: ${namespaceId}`);
