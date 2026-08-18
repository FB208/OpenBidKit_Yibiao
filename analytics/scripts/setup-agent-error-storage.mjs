import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../worker');
const workerConfigPath = resolve(workerDir, 'wrangler.jsonc');
const bindingName = 'AGENT_ERROR_BUCKET';
const bucketName = 'openbidkit-agent-errors';
const lifecycleRuleName = 'agent-errors-7-days';

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
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasBucketBinding(source) {
  const binding = escapeRegExp(bindingName);
  const bucket = escapeRegExp(bucketName);
  return new RegExp(`\\{[\\s\\S]*?"binding"\\s*:\\s*"${binding}"[\\s\\S]*?"bucket_name"\\s*:\\s*"${bucket}"[\\s\\S]*?\\}`).test(source);
}

function insertR2Binding(source) {
  const objectBlock = `{
      "binding": "${bindingName}",
      "bucket_name": "${bucketName}"
    }`;
  const propertyPattern = /"r2_buckets"\s*:\s*\[/;
  if (propertyPattern.test(source)) {
    return source.replace(propertyPattern, `"r2_buckets": [\n    ${objectBlock},`);
  }
  const insertAt = source.lastIndexOf('\n}');
  if (insertAt === -1) throw new Error('Unable to locate closing brace in wrangler.jsonc');
  return `${source.slice(0, insertAt)},\n  "r2_buckets": [\n    ${objectBlock}\n  ]${source.slice(insertAt)}`;
}

function ensureBucket() {
  if (!hasBucketBinding(readConfig())) {
    const info = runWrangler(['r2', 'bucket', 'info', bucketName]);
    if (info.status !== 0) {
      const created = runWrangler(['r2', 'bucket', 'create', bucketName]);
      if (created.status !== 0 && !/already exists/i.test(created.output)) {
        console.error(created.output || info.output);
        process.exit(created.status || 1);
      }
    }
    writeConfig(insertR2Binding(readConfig()));
    console.log(`AGENT_ERROR_BUCKET R2 bucket configured: ${bucketName}`);
  } else {
    console.log(`AGENT_ERROR_BUCKET R2 bucket already configured: ${bucketName}`);
  }
}

function ensureLifecycleRule() {
  runWrangler(['r2', 'bucket', 'lifecycle', 'remove', bucketName, '--name', lifecycleRuleName]);
  const result = runWrangler([
    'r2', 'bucket', 'lifecycle', 'add', bucketName, lifecycleRuleName,
    '--expire-days', '7', '--force',
  ]);
  if (result.status !== 0) {
    console.error(result.output);
    process.exit(result.status || 1);
  }
  console.log(`AGENT_ERROR_BUCKET lifecycle configured: ${lifecycleRuleName}`);
}

ensureBucket();
ensureLifecycleRule();
