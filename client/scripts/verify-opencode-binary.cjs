const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binaryPath = path.join(VENDOR_ROOT, key, binaryName);
  if (!fs.existsSync(binaryPath)) throw new Error(`缺少 OpenCode binary：${binaryPath}`);
  if (platform !== 'win32') fs.accessSync(binaryPath, fs.constants.X_OK);
  const platformDirs = fs.readdirSync(VENDOR_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
  if (platformDirs.length !== 1 || platformDirs[0] !== key) throw new Error(`本次构建只能包含 ${key}，实际包含：${platformDirs.join(', ') || '(empty)'}`);
  try { execFileSync(binaryPath, ['--version'], { stdio: 'pipe', timeout: 15000 }); } catch { execFileSync(binaryPath, ['--help'], { stdio: 'pipe', timeout: 15000 }); }
  console.log(`OpenCode binary verified: ${binaryPath}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
