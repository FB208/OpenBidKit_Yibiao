const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [, , requestedArch, releaseDirectory = 'release'] = process.argv;
const lipoArch = {
  x64: 'x86_64',
  arm64: 'arm64',
}[requestedArch];

if (!lipoArch) {
  console.error('Usage: node scripts/verify-macos-native-arch.cjs <x64|arm64> [release-directory]');
  process.exit(2);
}

const releaseRoot = path.resolve(releaseDirectory);

function collectTopLevelApps(directory, apps = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.endsWith('.app')) {
      apps.push(entryPath);
      continue;
    }
    collectTopLevelApps(entryPath, apps);
  }
  return apps;
}

function collectNativeBinaries(directory, binaries = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      collectNativeBinaries(entryPath, binaries);
      continue;
    }

    const normalizedPath = entryPath.split(path.sep).join('/');
    if (entry.name.endsWith('.node') || normalizedPath.includes('/Contents/MacOS/')) {
      binaries.push(entryPath);
    }
  }
  return binaries;
}

function verifyArchitecture(binaryPath) {
  const result = spawnSync('lipo', [binaryPath, '-verify_arch', lipoArch], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${binaryPath} does not contain ${lipoArch}${details ? `\n${details}` : ''}`);
  }
}

if (!fs.existsSync(releaseRoot)) {
  throw new Error(`Release directory does not exist: ${releaseRoot}`);
}

const apps = collectTopLevelApps(releaseRoot);
if (apps.length === 0) {
  throw new Error(`No .app bundle found under ${releaseRoot}`);
}

const binaries = apps.flatMap((appPath) => collectNativeBinaries(appPath));
const nativeModules = binaries.filter((binaryPath) => binaryPath.endsWith('.node'));
const executables = binaries.filter((binaryPath) => !binaryPath.endsWith('.node'));

if (nativeModules.length === 0) {
  throw new Error('No native Node modules were found in the packaged app.');
}
if (executables.length === 0) {
  throw new Error('No app executables were found in the packaged app.');
}

for (const binaryPath of binaries) {
  verifyArchitecture(binaryPath);
}

console.log(
  `[native-arch] verified ${executables.length} executables and ${nativeModules.length} native modules contain ${lipoArch}.`,
);
