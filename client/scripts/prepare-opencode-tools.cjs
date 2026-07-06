const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode-tools');

const TOOL_SOURCES = {
  rg: {
    repo: 'BurntSushi/ripgrep',
    versionEnv: 'RIPGREP_VERSION',
    assetEnv: 'RIPGREP_ASSET_URL',
    defaultVersion: '14.1.1',
    patterns: {
      'win32-x64': [/ripgrep-.*x86_64-pc-windows-msvc\.zip$/i],
      'darwin-x64': [/ripgrep-.*x86_64-apple-darwin\.tar\.gz$/i],
      'darwin-arm64': [/ripgrep-.*aarch64-apple-darwin\.tar\.gz$/i],
    },
    binaryPattern: /^rg(\.exe)?$/i,
  },
  fd: {
    repo: 'sharkdp/fd',
    versionEnv: 'FD_VERSION',
    assetEnv: 'FD_ASSET_URL',
    defaultVersion: 'v10.3.0',
    patterns: {
      'win32-x64': [/fd-.*x86_64-pc-windows-msvc\.zip$/i],
      'darwin-x64': [/fd-.*x86_64-apple-darwin\.tar\.gz$/i],
      'darwin-arm64': [/fd-.*aarch64-apple-darwin\.tar\.gz$/i],
    },
    binaryPattern: /^fd(\.exe)?$/i,
  },
  jq: {
    repo: 'jqlang/jq',
    versionEnv: 'JQ_VERSION',
    assetEnv: 'JQ_ASSET_URL',
    defaultVersion: 'jq-1.7.1',
    patterns: {
      'win32-x64': [/jq-windows-amd64\.exe$/i],
      'darwin-x64': [/jq-macos-amd64$/i],
      'darwin-arm64': [/jq-macos-arm64$/i],
    },
    binaryPattern: /^jq(\.exe)?$|^jq-(windows|macos)/i,
  },
};

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'yibiao-opencode-tools-preparer', Accept: 'application/vnd.github+json' };
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
      https.get(currentUrl, { headers: { 'User-Agent': 'yibiao-opencode-tools-preparer' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount > 5) return reject(new Error('下载 OpenCode tools 重定向过多'));
          request(new URL(res.headers.location, currentUrl).toString(), redirectCount + 1);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`下载 OpenCode tools 失败：HTTP ${res.statusCode}`));
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

function findAsset(release, source, key) {
  if (process.env[source.assetEnv]) {
    return { name: path.basename(new URL(process.env[source.assetEnv]).pathname), browser_download_url: process.env[source.assetEnv] };
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const patterns = source.patterns[key] || [];
  for (const pattern of patterns) {
    const matched = assets.find((asset) => pattern.test(asset.name));
    if (matched) return matched;
  }
  throw new Error(`没有找到 ${key} 对应的工具 release asset。可用资产：\n${assets.map((asset) => asset.name).join('\n')}`);
}

function walkFiles(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const filePath = path.join(dir, name);
    return fs.statSync(filePath).isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function extractAsset(assetPath, extractDir) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  if (/\.zip$/i.test(assetPath)) {
    new AdmZip(assetPath).extractAllTo(extractDir, true);
    return extractDir;
  }
  if (/\.(tar\.gz|tgz)$/i.test(assetPath)) {
    execFileSync('tar', ['-xzf', assetPath, '-C', extractDir], { stdio: 'pipe' });
    return extractDir;
  }
  return '';
}

function findBinary(assetPath, extractDir, source) {
  if (!extractDir) return assetPath;
  const files = walkFiles(extractDir);
  const matched = files.find((file) => source.binaryPattern.test(path.basename(file)));
  if (!matched) throw new Error(`解压后没有找到工具可执行文件：${assetPath}`);
  return matched;
}

function verifyExecutable(filePath, command) {
  execFileSync(filePath, ['--version'], { stdio: 'pipe', timeout: 15000 });
  if (command === 'jq') {
    execFileSync(filePath, ['-n', '1+1'], { stdio: 'pipe', timeout: 15000 });
  }
}

async function prepareTool({ command, source, key, platform, arch, tmpRoot, binDir }) {
  const version = String(process.env[source.versionEnv] || source.defaultVersion).trim();
  const release = await requestJson(`https://api.github.com/repos/${source.repo}/releases/tags/${encodeURIComponent(version)}`);
  const asset = findAsset(release, source, key);
  const downloadPath = path.join(tmpRoot, `${command}-${asset.name}`);
  const extractDir = path.join(tmpRoot, `${command}-extract`);
  await downloadFile(asset.browser_download_url, downloadPath);
  const extractedDir = extractAsset(downloadPath, extractDir);
  const binaryPath = findBinary(downloadPath, extractedDir, source);
  const targetName = platform === 'win32' ? `${command}.exe` : command;
  const targetPath = path.join(binDir, targetName);
  fs.copyFileSync(binaryPath, targetPath);
  if (platform !== 'win32') fs.chmodSync(targetPath, 0o755);
  verifyExecutable(targetPath, command);
  return { command, version, repo: source.repo, asset: asset.name, platform, arch, key };
}

async function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  if (!['win32-x64', 'darwin-x64', 'darwin-arm64'].includes(key)) {
    throw new Error(`第一版只支持 win32-x64、darwin-x64、darwin-arm64，当前为 ${key}`);
  }

  const tmpRoot = path.join(ROOT, '.tmp-opencode-tools-download', key);
  const binDir = path.join(VENDOR_ROOT, key, 'bin');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });

  const tools = [];
  for (const command of ['rg', 'fd', 'jq']) {
    tools.push(await prepareTool({ command, source: TOOL_SOURCES[command], key, platform, arch, tmpRoot, binDir }));
  }

  fs.writeFileSync(path.join(VENDOR_ROOT, 'manifest.json'), JSON.stringify({
    platform,
    arch,
    key,
    tools,
    prepared_at: new Date().toISOString(),
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(VENDOR_ROOT, 'VERSION'), tools.map((item) => `${item.command}=${item.version}`).join('\n') + '\n', 'utf-8');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Prepared OpenCode tools: ${binDir}`);
}

main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
