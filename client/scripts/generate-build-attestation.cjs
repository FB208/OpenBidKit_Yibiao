const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(projectRoot, 'electron', 'resources');
const attestationPath = path.join(resourcesDir, 'build-attestation.json');
const publicKeyPath = path.join(resourcesDir, 'license-public-key.json');
const packageJson = require(path.join(projectRoot, 'package.json'));

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function parseJwkEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON Web Key: ${error.message}`);
  }
}

function publicJwkFromPrivate(privateJwk) {
  if (!privateJwk) return null;
  const { kty, crv, x, y } = privateJwk;
  if (!kty || !crv || !x || !y) {
    throw new Error('private JWK must contain kty, crv, x and y');
  }
  return { key_ops: ['verify'], ext: true, kty, crv, x, y };
}

async function signPayload(payload, privateJwk) {
  if (!privateJwk) return '';
  const key = await webcrypto.subtle.importKey(
    'jwk',
    { ...privateJwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const data = Buffer.from(canonicalJson(payload), 'utf-8');
  const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return base64UrlEncode(signature);
}

function getGitCommitSha() {
  const envSha = String(process.env.GITHUB_SHA || '').trim();
  if (envSha) return envSha;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getBuildId() {
  const explicit = String(process.env.YIBIAO_BUILD_ID || '').trim();
  if (explicit) return explicit;
  const runId = String(process.env.GITHUB_RUN_ID || '').trim();
  const attempt = String(process.env.GITHUB_RUN_ATTEMPT || '').trim();
  const ref = String(process.env.GITHUB_REF_NAME || '').trim();
  if (runId) {
    return ['github', runId, attempt || '1', ref].filter(Boolean).join('-');
  }
  return 'development-build';
}

async function main() {
  const privateJwk = parseJwkEnv('YIBIAO_LICENSE_PRIVATE_KEY_JWK');
  const publicJwk = publicJwkFromPrivate(privateJwk)
    || parseJwkEnv('YIBIAO_LICENSE_PUBLIC_KEY_JWK')
    || readJsonFile(publicKeyPath);
  if (!publicJwk) {
    throw new Error('license public key is missing');
  }

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(publicKeyPath, `${JSON.stringify(publicJwk, null, 2)}\n`, 'utf-8');

  const payload = {
    projectName: packageJson.name || 'yibiao-client',
    appId: packageJson.build?.appId || 'com.yibiao.openbidkit',
    productName: packageJson.build?.productName || '易标投标工具箱',
    buildId: getBuildId(),
    gitCommitSha: getGitCommitSha(),
    builtAt: String(process.env.YIBIAO_BUILT_AT || '').trim() || new Date().toISOString(),
    keyId: String(process.env.YIBIAO_LICENSE_KEY_ID || '').trim() || 'official-build-key-2026-01',
    algorithm: 'ECDSA_P256_SHA256',
  };
  const signature = await signPayload(payload, privateJwk);
  fs.writeFileSync(attestationPath, `${JSON.stringify({ ...payload, signature }, null, 2)}\n`, 'utf-8');

  if (signature) {
    console.log(`[license] signed build attestation ${payload.buildId}`);
  } else {
    console.log('[license] wrote unsigned development build attestation');
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
