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

function verifyExecutable(filePath, command, platform) {
  if (!fs.existsSync(filePath)) throw new Error(`打包产物缺少 OpenCode 常用命令：${filePath}`);
  if (platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
  execFileSync(filePath, ['--version'], { stdio: 'pipe', timeout: 15000 });
  if (command === 'jq') execFileSync(filePath, ['-n', '1+1'], { stdio: 'pipe', timeout: 15000 });
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const releaseDir = path.resolve(readArg('--release', 'release'));
  const key = `${platform}-${arch}`;
  const extension = platform === 'win32' ? '.exe' : '';
  const binDir = path.join(findResourceRoot(releaseDir, platform), 'opencode-tools', key, 'bin');
  ['rg', 'fd', 'jq'].forEach((command) => verifyExecutable(path.join(binDir, `${command}${extension}`), command, platform));
  console.log(`Packaged OpenCode tools verified: ${binDir}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
