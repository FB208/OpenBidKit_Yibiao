const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { getBundledDiagnosisSourceDir, getDiagnosisSourceDir } = require('../utils/paths.cjs');

// 诊断资料只供空转诊断 Agent 阅读，不参与程序运行。安装版在启动时按 VERSION 同步到 userData：
// 版本不一致或缺失时清除旧副本后解压随包归档；开发版直接使用仓库根目录。
const VERSION_FILE = 'VERSION';
const ARCHIVE_FILE = 'source.zip';
let syncPromise = null;

async function readVersion(dir) {
  try {
    return (await fs.promises.readFile(path.join(dir, VERSION_FILE), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function syncDiagnosisSource(app) {
  const target = getDiagnosisSourceDir(app);
  if (!app.isPackaged) return target;
  const source = getBundledDiagnosisSourceDir();
  const bundledVersion = await readVersion(source);
  if (!bundledVersion) throw new Error('安装包缺少诊断资料，请重新安装客户端');
  if (await readVersion(target) === bundledVersion) return target;
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // VERSION 最后写入：解压中断时副本没有版本标记，下次启动会重新解压。
  new AdmZip(path.join(source, ARCHIVE_FILE)).extractAllTo(target, true);
  await fs.promises.writeFile(path.join(target, VERSION_FILE), bundledVersion, 'utf8');
  return target;
}

// 返回诊断资料目录；同一进程共用一次同步，失败后下次调用重新尝试。
function ensureDiagnosisSource(app) {
  syncPromise ||= syncDiagnosisSource(app).catch((error) => {
    syncPromise = null;
    throw error;
  });
  return syncPromise;
}

module.exports = { ensureDiagnosisSource };
