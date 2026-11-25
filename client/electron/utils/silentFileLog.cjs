const fs = require('node:fs/promises');
const path = require('node:path');

const fileOperationTails = new Map();

// 生成同一文件稳定共享的队列键，并保留实际写入路径。
function resolveLogTarget(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return null;

  const targetPath = path.resolve(value);
  return {
    targetPath,
    queueKey: process.platform === 'win32' ? targetPath.toLowerCase() : targetPath,
  };
}

// 将文件操作加入对应路径的 FIFO，任何异常都只终止当前日志操作。
function enqueueFileOperation(filePath, operation) {
  try {
    const target = resolveLogTarget(filePath);
    if (!target) return;

    const previous = fileOperationTails.get(target.queueKey) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => operation(target.targetPath))
      .catch(() => undefined);

    fileOperationTails.set(target.queueKey, current);
    void current.then(() => {
      if (fileOperationTails.get(target.queueKey) === current) {
        fileOperationTails.delete(target.queueKey);
      }
    });
    return current;
  } catch {
    // 诊断日志不能影响主流程。
  }
}

// 序列化 JSON；无法序列化的日志由外层静默丢弃。
function serializeJson(value, space) {
  const content = JSON.stringify(value, null, space);
  if (typeof content !== 'string') {
    throw new Error('日志内容无法序列化');
  }
  return content;
}

// 异步追加一条紧凑 JSONL 记录。
function enqueueJsonLine(filePath, entry) {
  enqueueFileOperation(filePath, async (targetPath) => {
    const content = `${serializeJson(entry)}\n`;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, content, 'utf-8');
  });
}

// 异步覆盖 JSON 文件，可在终态写入失败时尽力清理旧文件。
function enqueueJsonReplace(filePath, payload, options = {}) {
  try {
    const space = options.space;
    const removeOnFailure = options.removeOnFailure === true;
    enqueueFileOperation(filePath, async (targetPath) => {
      try {
        const content = serializeJson(payload, space);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, 'utf-8');
      } catch (error) {
        if (removeOnFailure) {
          try {
            await fs.rm(targetPath, { force: true });
          } catch {
            // 文件系统不可用时允许残留旧日志。
          }
        }
        throw error;
      }
    });
  } catch {
    // 诊断日志不能影响主流程。
  }
}

// 根据同一条记录的 UTC 时间计算分日文件名。
function getDailyLogPath(baseFilePath, at) {
  const ext = path.extname(baseFilePath);
  return `${baseFilePath.slice(0, -ext.length)}.${at.slice(0, 10)}${ext}`;
}

// 按天追加仍走普通日志的文件队列。
function enqueueDailyJsonLine(baseFilePath, at, entry) {
  enqueueJsonLine(getDailyLogPath(baseFilePath, at), entry);
}

// 在已有写入后删除日志；定时清理只删扫描后未更新的文件。
async function enqueueLogRemoval(filePath, snapshot) {
  return (await enqueueFileOperation(filePath, async (targetPath) => {
    if (snapshot) {
      const stats = await fs.lstat(targetPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!stats) return true;
      if (!stats.isFile() || stats.mtimeMs !== snapshot.mtimeMs || stats.size !== snapshot.size) return false;
    }
    await fs.rm(targetPath, { force: true });
    return true;
  })) === true;
}

module.exports = {
  enqueueDailyJsonLine,
  enqueueJsonLine,
  enqueueJsonReplace,
  enqueueLogRemoval,
  getDailyLogPath,
};
