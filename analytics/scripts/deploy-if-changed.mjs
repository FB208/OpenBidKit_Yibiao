import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const watchPath = process.argv[2];
const isWorkersBuild = Boolean(process.env.WORKERS_CI || process.env.WORKERS_CI_COMMIT_SHA);
const forceDeploy = process.env.FORCE_DEPLOY === '1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const noticeBindingName = 'NOTICE_STORE';

if (!watchPath) {
  console.error('Usage: node deploy-if-changed.mjs <watch-path>');
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

function deploy() {
  runPreDeploySetupIfNeeded();
  console.log(`Running wrangler deploy for ${watchPath}.`);

  const result = spawnSync('npx', ['wrangler', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.exit(result.status ?? 1);
}

function runPreDeploySetupIfNeeded() {
  if (String(watchPath || '').replace(/\\/g, '/') !== 'analytics/worker') {
    return;
  }

  const workerConfigPath = resolve(__dirname, '../worker/wrangler.jsonc');
  const source = readFileSync(workerConfigPath, 'utf8');
  if (hasNoticeStoreBinding(source)) {
    console.log('NOTICE_STORE KV namespace already configured; skipping setup.');
  } else {
    console.log('NOTICE_STORE KV namespace is not configured; running setup.');
    const setupScript = resolve(__dirname, 'setup-notice-kv.mjs');
    const result = spawnSync(process.execPath, [setupScript], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  console.log('Ensuring resource D1 database and R2 bucket.');
  const resourceSetupScript = resolve(__dirname, 'setup-resource-storage.mjs');
  const resourceResult = spawnSync(process.execPath, [resourceSetupScript], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (resourceResult.status !== 0) {
    process.exit(resourceResult.status ?? 1);
  }

  console.log('Ensuring analytics D1 database and stats schema.');
  const analyticsSetupScript = resolve(__dirname, 'setup-analytics-storage.mjs');
  const analyticsResult = spawnSync(process.execPath, [analyticsSetupScript], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (analyticsResult.status !== 0) {
    process.exit(analyticsResult.status ?? 1);
  }
}

function hasNoticeStoreBinding(source) {
  const escapedBinding = noticeBindingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\{[\\s\\S]*?"binding"\\s*:\\s*"${escapedBinding}"[\\s\\S]*?"id"\\s*:\\s*"[^"<]+"[\\s\\S]*?\\}`);
  return pattern.test(source);
}

function getTrimmedStdout(result) {
  return String(result.stdout || '').trim();
}

if (!isWorkersBuild || forceDeploy) {
  deploy();
}

const repoRootResult = run('git', ['rev-parse', '--show-toplevel']);
if (repoRootResult.status !== 0) {
  console.warn('Unable to find git root, deploying normally.');
  deploy();
}

const repoRoot = getTrimmedStdout(repoRootResult);
const parentResult = run('git', ['rev-parse', 'HEAD^'], { cwd: repoRoot });
if (parentResult.status !== 0) {
  console.warn('Unable to find parent commit, deploying normally.');
  deploy();
}

const parentCommit = getTrimmedStdout(parentResult);
const diffResult = run('git', ['diff', '--name-only', parentCommit, 'HEAD', '--', watchPath], { cwd: repoRoot });
if (diffResult.status !== 0) {
  console.warn('Unable to inspect changed files, deploying normally.');
  deploy();
}

const changedFiles = getTrimmedStdout(diffResult);
if (!changedFiles) {
  console.log(`No changes under ${watchPath}; skipping wrangler deploy.`);
  process.exit(0);
}

console.log(`Changes detected under ${watchPath}:`);
console.log(changedFiles);
deploy();
