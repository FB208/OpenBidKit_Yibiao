import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const workerDir = resolve(__dirname, '..', '..', 'worker');

// 解析部署凭据值。
function parseEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}

// 将调查脚本共用的 .env 注入 Wrangler 子进程。
function loadEnv() {
  if (!existsSync(envPath)) throw new Error(`.env file not found: ${envPath}`);
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).replace(/^export\s+/, '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) process.env[key] = parseEnvValue(line.slice(equalsIndex + 1));
  }
  process.env.CLOUDFLARE_ACCOUNT_ID ||= process.env.ACCOUNT_ID || '';
  process.env.FORCE_DEPLOY = '1';
}

// 使用已配置的生产绑定直接发布 Worker。
function main() {
  loadEnv();
  delete process.env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync('npx', ['wrangler', 'deploy'], {
    cwd: workerDir,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(result.status ?? 1);
}

main();
