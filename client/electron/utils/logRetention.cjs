const fs = require('node:fs/promises');
const path = require('node:path');
const { getLogsDir } = require('./paths.cjs');
const { enqueueLogRemoval } = require('./silentFileLog.cjs');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HIGH_WATER_BYTES = 2 * 1024 ** 3;
const LOW_WATER_BYTES = 1.5 * 1024 ** 3;
const CLEAN_INTERVAL_MS = 30 * 60 * 1000;

// 日志目录可尚未创建，扫描过程中也可能被手动清理。
function ignoreMissing(error) {
  if (error.code !== 'ENOENT') throw error;
  return null;
}

// 只看日志文件的元数据，先清过期文件，超出高水位才排序清容量。
async function cleanLogs(logsDir) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const root = await fs.lstat(logsDir).catch(ignoreMissing);
  const directories = root?.isDirectory() ? [logsDir] : [];
  const candidates = [];
  let bytes = 0;

  while (directories.length) {
    const directory = directories.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(ignoreMissing);
    for (const entry of entries || []) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(filePath);
      } else if (entry.isFile()) {
        const stats = await fs.lstat(filePath).catch(ignoreMissing);
        if (!stats?.isFile()) continue;
        const file = { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
        if (file.mtimeMs < cutoff) {
          if (await enqueueLogRemoval(filePath, file)) continue;
        } else {
          candidates.push(file);
        }
        bytes += file.size;
      }
    }
  }

  if (bytes <= HIGH_WATER_BYTES) return;
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of candidates) {
    if (await enqueueLogRemoval(file.filePath, file)) bytes -= file.size;
    if (bytes <= LOW_WATER_BYTES) break;
  }
}

// 启动后扫一次，上一轮结束再安排下一轮，不为日志延长进程寿命。
function startLogCleanup(app) {
  const logsDir = getLogsDir(app);

  // 统一报告扫描失败，下一轮按原间隔执行。
  async function run() {
    try {
      await cleanLogs(logsDir);
    } catch (error) {
      console.warn('[logs] 清理失败', error.message);
    }
    setTimeout(run, CLEAN_INTERVAL_MS).unref();
  }

  void run();
}

module.exports = { cleanLogs, startLogCleanup };
