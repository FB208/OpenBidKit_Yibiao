function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

// 读取指定项目的版本号封禁列表。
export async function listVersionBlocks(env, projectName) {
  const result = await requireStatsDb(env).prepare(`
    SELECT version, reason, created_at AS createdAt
    FROM version_blocks
    WHERE project_name = ?
    ORDER BY created_at DESC, version ASC
  `).bind(projectName).all();
  return result.results || [];
}

// 判断某项目的某个版本号（含空字符串）是否已被封禁；D1 异常时保持上报可用。
export async function isTrackVersionBlocked(env, projectName, version) {
  try {
    return Boolean(await requireStatsDb(env).prepare(`
      SELECT 1 FROM version_blocks WHERE project_name = ? AND version = ? LIMIT 1
    `).bind(projectName, version).first());
  } catch {
    return false;
  }
}

