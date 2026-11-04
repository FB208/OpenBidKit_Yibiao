const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const PROJECT_PATH = path.join(REPO_ROOT, 'openxmlhelper', 'src', 'OpenXmlHelper', 'OpenXmlHelper.csproj');
const VENDOR_ROOT = path.join(CLIENT_ROOT, 'vendor', 'openxml-tools');

const RID_BY_KEY = {
  'win32-x64': 'win-x64',
  'darwin-x64': 'osx-x64',
  'darwin-arm64': 'osx-arm64',
};

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function executableName(platform) {
  return platform === 'win32' ? 'openxmlhelper.exe' : 'openxmlhelper';
}

/** 展开目标架构；macOS 本地打包默认同时准备 Intel 与 Apple Silicon。 */
function resolveTargetArches(platform, arch) {
  if (arch !== 'all') return [arch];
  const prefix = `${platform}-`;
  const arches = Object.keys(RID_BY_KEY)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  if (!arches.length) {
    throw new Error(`不支持发布全部架构的平台：${platform}`);
  }
  return arches;
}

/** 按平台发布自包含单文件助手。 */
function publishTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  const rid = RID_BY_KEY[key];
  if (!rid) {
    throw new Error(`不支持的 Open XML 助手平台：${key}`);
  }
  if (!fs.existsSync(PROJECT_PATH)) {
    throw new Error(`找不到 Open XML 助手工程：${PROJECT_PATH}`);
  }

  const outputDir = path.join(VENDOR_ROOT, key);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  execFileSync('dotnet', [
    'publish',
    PROJECT_PATH,
    '-c', 'Release',
    '-r', rid,
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:PublishTrimmed=false',
    // 预编译 OpenXML SDK 等程序集，减少每次启动助手进程时的 JIT（暗标检查每次都新开进程）。
    '-p:PublishReadyToRun=true',
    '-o', outputDir,
  ], {
    cwd: REPO_ROOT,
    windowsHide: true,
    shell: false,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOTNET_NOLOGO: '1',
    },
  });

  const exePath = path.join(outputDir, executableName(platform));
  if (!fs.existsSync(exePath)) {
    throw new Error(`发布后未找到助手程序：${exePath}`);
  }
  if (platform !== 'win32') {
    fs.chmodSync(exePath, 0o755);
  }
  console.log(`Open XML helper published: ${exePath}`);
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', platform === 'darwin' ? 'all' : process.arch);
  for (const targetArch of resolveTargetArches(platform, arch)) {
    publishTarget(platform, targetArch);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
