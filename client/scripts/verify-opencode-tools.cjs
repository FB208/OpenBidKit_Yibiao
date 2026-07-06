const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode-tools');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function verifyExecutable(filePath, command) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少 OpenCode 常用命令：${filePath}`);
  if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
  execFileSync(filePath, ['--version'], { stdio: 'pipe', timeout: 15000 });
  if (command === 'jq') execFileSync(filePath, ['-n', '1+1'], { stdio: 'pipe', timeout: 15000 });
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const extension = platform === 'win32' ? '.exe' : '';
  const binDir = path.join(VENDOR_ROOT, key, 'bin');
  const platformDirs = fs.existsSync(VENDOR_ROOT)
    ? fs.readdirSync(VENDOR_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : [];
  if (platformDirs.length !== 1 || platformDirs[0] !== key) {
    throw new Error(`本次构建只能包含 ${key}，实际包含：${platformDirs.join(', ') || '(empty)'}`);
  }
  ['rg', 'fd', 'jq'].forEach((command) => verifyExecutable(path.join(binDir, `${command}${extension}`), command));
  console.log(`OpenCode tools verified: ${binDir}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
