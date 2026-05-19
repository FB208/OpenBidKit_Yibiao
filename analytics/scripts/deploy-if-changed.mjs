import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const watchPath = process.argv[2];
const isWorkersBuild = Boolean(process.env.WORKERS_CI || process.env.WORKERS_CI_COMMIT_SHA);
const forceDeploy = process.env.FORCE_DEPLOY === '1';
const __dirname = dirname(fileURLToPath(import.meta.url));

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
  runPreDeploySetup();

  const result = spawnSync('npx', ['wrangler', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.exit(result.status ?? 1);
}

function runPreDeploySetup() {
  if (String(watchPath || '').replace(/\\/g, '/') !== 'analytics/worker') {
    return;
  }

  const setupScript = resolve(__dirname, 'setup-notice-kv.mjs');
  const result = spawnSync(process.execPath, [setupScript], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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
