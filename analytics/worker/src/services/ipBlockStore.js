import { getRequestClientIp } from '../utils.js';

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

// 读取 D1 中的全局封禁列表。
export async function listBlockedIps(env) {
  const result = await requireStatsDb(env).prepare(`
    SELECT ip, reason, created_at AS createdAt
    FROM ip_blocks
    ORDER BY created_at DESC, ip ASC
  `).all();
  return result.results || [];
}

// 判断请求公网出口是否已被封禁；D1 异常时保持公开服务可用。
export async function isRequestIpBlocked(env, request) {
  const clientIp = getRequestClientIp(request);
  if (!clientIp) return false;
  try {
    return Boolean(await requireStatsDb(env).prepare('SELECT 1 FROM ip_blocks WHERE ip = ? LIMIT 1').bind(clientIp).first());
  } catch {
    return false;
  }
}
