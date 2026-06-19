const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const REPO = 'anomalyco/opencode';
const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode');
const VERSION_FILE = path.join(VENDOR_ROOT, 'VERSION');

const ASSET_PATTERNS = {
  'win32-x64': [/opencode-(windows|win32|win)-x64.*\.zip$/i, /opencode.*(windows|win32|win).*x64.*\.zip$/i, /opencode.*(windows|win32|win).*amd64.*\.zip$/i],
  'darwin-arm64': [/^opencode-darwin-arm64\.zip$/i, /opencode.*darwin.*arm64.*\.zip$/i, /opencode.*mac.*arm64.*\.zip$/i],
  'darwin-x64': [/^opencode-darwin-x64\.zip$/i, /opencode.*darwin.*x64.*\.zip$/i, /opencode.*mac.*x64.*\.zip$/i],
};

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function readVersion() {
  const envVersion = String(process.env.OPENCODE_VERSION || '').trim();
  if (envVersion) return envVersion;
  if (fs.existsSync(VERSION_FILE)) return fs.readFileSync(VERSION_FILE, 'utf-8').trim();
  throw new Error('缺少 OpenCode 版本：请设置 OPENCODE_VERSION 或创建 client/vendor/opencode/VERSION');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'yibiao-opencode-binary-preparer', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    https.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API 请求失败 ${res.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const file = fs.createWriteStream(targetPath);
    const request = (currentUrl, redirectCount = 0) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'yibiao-opencode-binary-preparer' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount > 5) return reject(new Error('下载 OpenCode binary 重定向过多'));
          request(new URL(res.headers.location, currentUrl).toString(), redirectCount + 1);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`下载 OpenCode binary 失败：HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    file.on('error', reject);
    request(url);
  });
}

function findAsset(release, key) {
  if (process.env.OPENCODE_ASSET_URL) {
    return { name: path.basename(new URL(process.env.OPENCODE_ASSET_URL).pathname), browser_download_url: process.env.OPENCODE_ASSET_URL };
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const patterns = ASSET_PATTERNS[key];
  for (const pattern of patterns || []) {
    const matched = assets.find((asset) => pattern.test(asset.name));
    if (matched) return matched;
  }
  throw new Error(`没有找到 ${key} 对应的 OpenCode release asset。可用资产：\n${assets.map((asset) => asset.name).join('\n')}`);
}

function walkFiles(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const filePath = path.join(dir, name);
    return fs.statSync(filePath).isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function findBinary(extractDir, platform) {
  const files = walkFiles(extractDir);
  const expectedName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const direct = files.find((file) => path.basename(file).toLowerCase() === expectedName.toLowerCase());
  if (direct) return direct;
  const fallback = files.find((file) => {
    const base = path.basename(file).toLowerCase();
    return platform === 'win32' ? base.includes('opencode') && base.endsWith('.exe') : base.includes('opencode') && !base.includes('.');
  });
  if (fallback) return fallback;
  throw new Error('解压后没有找到 OpenCode 可执行文件');
}

function verifyExecutable(target) {
  try { execFileSync(target, ['--version'], { stdio: 'pipe', timeout: 15000 }); return; } catch {}
  execFileSync(target, ['--help'], { stdio: 'pipe', timeout: 15000 });
}

async function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const version = readVersion();
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  if (!ASSET_PATTERNS[key]) throw new Error(`第一版只支持 win32-x64、darwin-x64、darwin-arm64，当前为 ${key}`);

  const release = await requestJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(version)}`);
  const asset = findAsset(release, key);
  const tmpRoot = path.join(ROOT, '.tmp-opencode-download', key);
  const zipPath = path.join(tmpRoot, asset.name);
  const extractDir = path.join(tmpRoot, 'extract');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await downloadFile(asset.browser_download_url, zipPath);
  new AdmZip(zipPath).extractAllTo(extractDir, true);

  fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
  const targetBinary = path.join(VENDOR_ROOT, key, binaryName);
  fs.mkdirSync(path.dirname(targetBinary), { recursive: true });
  fs.copyFileSync(findBinary(extractDir, platform), targetBinary);
  if (platform !== 'win32') {
    fs.chmodSync(targetBinary, 0o755);
    try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', targetBinary], { stdio: 'ignore' }); } catch {}
  }
  fs.writeFileSync(VERSION_FILE, `${version}\n`, 'utf-8');
  fs.writeFileSync(path.join(VENDOR_ROOT, 'manifest.json'), JSON.stringify({ version, platform, arch, key, asset: asset.name, prepared_at: new Date().toISOString() }, null, 2), 'utf-8');
  verifyExecutable(targetBinary);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Prepared ${targetBinary}`);
}

main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
