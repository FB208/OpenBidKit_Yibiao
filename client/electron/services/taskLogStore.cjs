const MAX_TASK_LOGS = 80;

function normalizeLogs(logs) {
  const normalized = [];
  for (const value of Array.isArray(logs) ? logs : []) {
    const message = String(value || '').trim();
    if (!message || normalized.at(-1) === message) continue;
    normalized.push(message);
  }
  return normalized.slice(-MAX_TASK_LOGS);
}

function createTaskLogStore({ db }) {
  const listRows = db.prepare(`
    SELECT id, task_id, message
    FROM task_logs
    WHERE task_domain = ? AND task_type = ?
    ORDER BY id ASC
  `);
  const insertRow = db.prepare(`
    INSERT INTO task_logs (task_domain, task_type, task_id, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteRow = db.prepare('DELETE FROM task_logs WHERE id = ?');
  const deleteTaskType = db.prepare('DELETE FROM task_logs WHERE task_domain = ? AND task_type = ?');

  // 将任务内存日志快照同步为最小的行级删除和追加操作。
  function sync(taskDomain, taskType, taskId, logs, createdAt) {
    const desired = normalizeLogs(logs);
    let rows = listRows.all(taskDomain, taskType);
    if (rows.some((row) => row.task_id !== taskId)) {
      deleteTaskType.run(taskDomain, taskType);
      rows = [];
    }

    const current = rows.map((row) => row.message);
    let overlap = Math.min(current.length, desired.length);
    while (overlap > 0) {
      const currentStart = current.length - overlap;
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        if (current[currentStart + index] !== desired[index]) {
          matches = false;
          break;
        }
      }
      if (matches) break;
      overlap -= 1;
    }

    const removeCount = current.length - overlap;
    for (let index = 0; index < removeCount; index += 1) {
      deleteRow.run(rows[index].id);
    }
    const timestamp = createdAt || new Date().toISOString();
    for (const message of desired.slice(overlap)) {
      insertRow.run(taskDomain, taskType, taskId, message, timestamp);
    }
  }

  // 读取当前任务的有限日志快照，供 Store 组装原有任务对象。
  function list(taskDomain, taskType, taskId) {
    return listRows.all(taskDomain, taskType)
      .filter((row) => row.task_id === taskId)
      .map((row) => row.message)
      .slice(-MAX_TASK_LOGS);
  }

  return {
    list,
    normalizeLogs,
    sync,
  };
}

module.exports = {
  MAX_TASK_LOGS,
  createTaskLogStore,
  normalizeLogs,
};
