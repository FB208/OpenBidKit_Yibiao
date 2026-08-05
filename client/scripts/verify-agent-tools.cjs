const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'agent-tools');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function verifyExecutable(filePath, command) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少智能体常用命令：${filePath}`);
  if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
  execFileSync(filePath, ['--version'], { stdio: 'pipe', timeout: 15000 });
  if (command === 'jq') execFileSync(filePath, ['-n', '1+1'], { stdio: 'pipe', timeout: 15000 });
}

// 校验目标平台的版本和资源清单。
function verifyTargetMetadata(targetRoot, platform, arch, key) {
  const versionPath = path.join(targetRoot, 'VERSION');
  const manifestPath = path.join(targetRoot, 'manifest.json');
  if (!fs.existsSync(versionPath)) throw new Error(`缺少智能体工具版本文件：${versionPath}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少智能体工具清单：${manifestPath}`);

  const versions = Object.fromEntries(fs.readFileSync(versionPath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('=', 2)));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.key !== key || !Array.isArray(manifest.tools)) {
    throw new Error(`智能体工具清单与目标平台不一致：${manifestPath}`);
  }
  ['rg', 'fd', 'jq'].forEach((command) => {
    const tool = manifest.tools.find((item) => item.command === command);
    if (!versions[command] || !tool || tool.version !== versions[command]) {
      throw new Error(`智能体工具版本与清单不一致：${command}`);
    }
  });
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const extension = platform === 'win32' ? '.exe' : '';
  const targetRoot = path.join(VENDOR_ROOT, key);
  const binDir = path.join(targetRoot, 'bin');
  verifyTargetMetadata(targetRoot, platform, arch, key);
  ['rg', 'fd', 'jq'].forEach((command) => verifyExecutable(path.join(binDir, `${command}${extension}`), command));
  console.log(`Agent tools verified: ${binDir}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
