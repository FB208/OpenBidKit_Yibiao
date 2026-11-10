const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 诊断资料：从当前提交（HEAD）导出 sql、client、openxmlhelper 三个目录为单个 zip，供空转诊断 Agent 阅读，不参与程序运行。
// 读取提交而非工作区：未跟踪、被忽略的文件以及构建过程中改写的文件（如构建证明、同步后的版本号）都不会混入。
// 打成单归档而非目录：源码树含非 ASCII 文件名，散文件进包会让 WiX MSI 的 File 表无法按码页 1252 编码（LGHT0311）。
const CLIENT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const OUTPUT_DIR = path.join(CLIENT_ROOT, 'vendor', 'diagnosis-source');
const SOURCE_DIRS = ['sql', 'client', 'openxmlhelper'];
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: MAX_ARCHIVE_BYTES, ...options });
}

function main() {
  const commit = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { version } = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'));
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const archive = git(['archive', '--format=zip', 'HEAD', ...SOURCE_DIRS]);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'source.zip'), archive);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'VERSION'), `${version}+${commit}`, 'utf8');
  console.log(`[diagnosis-source] 已导出 ${SOURCE_DIRS.join('、')}（${commit.slice(0, 8)}，${(archive.length / 1024 / 1024).toFixed(1)}MB）到 ${OUTPUT_DIR}`);
}

main();
