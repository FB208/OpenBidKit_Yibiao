const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function walkDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((name) => {
    const filePath = path.join(root, name);
    if (!fs.statSync(filePath).isDirectory()) return [];
    return [filePath, ...walkDirs(filePath)];
  });
}

function findResourceRoot(releaseDir, platform) {
  if (platform === 'darwin') {
    const appDir = walkDirs(releaseDir).find((dir) => dir.endsWith('.app'));
    if (!appDir) throw new Error(`没有找到 macOS .app：${releaseDir}`);
    return path.join(appDir, 'Contents', 'Resources');
  }
  if (platform === 'win32') {
    const unpackedDir = walkDirs(releaseDir).find((dir) => path.basename(dir).toLowerCase() === 'win-unpacked');
    if (!unpackedDir) throw new Error(`没有找到 win-unpacked：${releaseDir}`);
    return path.join(unpackedDir, 'resources');
  }
  throw new Error(`暂不支持校验平台：${platform}`);
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const releaseDir = path.resolve(readArg('--release', 'release'));
  const key = `${platform}-${arch}`;
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binaryPath = path.join(findResourceRoot(releaseDir, platform), 'opencode', key, binaryName);
  if (!fs.existsSync(binaryPath)) throw new Error(`打包产物缺少 OpenCode binary：${binaryPath}`);
  if (platform !== 'win32') fs.accessSync(binaryPath, fs.constants.X_OK);
  try { execFileSync(binaryPath, ['--version'], { stdio: 'pipe', timeout: 15000 }); } catch { execFileSync(binaryPath, ['--help'], { stdio: 'pipe', timeout: 15000 }); }
  console.log(`Packaged OpenCode binary verified: ${binaryPath}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
