import { IP_BLOCK_LIST_KEY } from '../constants.js';
import { formatNoticeTime, getRequestClientIp, normalizeIpAddress, normalizeText } from '../utils.js';

// 将 KV 内容规范为可返回的封禁记录。
function normalizeEntries(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of value) {
    const ip = normalizeIpAddress(item?.ip);
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    entries.push({
      ip,
      reason: normalizeText(item?.reason, 500),
      createdAt: normalizeText(item?.createdAt, 40),
    });
  }
  return entries;
}

// 读取全局封禁 IP 列表。
export async function listBlockedIps(env) {
  if (!env.NOTICE_STORE) return [];
  const value = await env.NOTICE_STORE.get(IP_BLOCK_LIST_KEY, 'json');
  return normalizeEntries(value);
}

// 添加一个精确 IPv4 或 IPv6 地址。
export async function addBlockedIp(env, value, reasonValue) {
  if (!env.NOTICE_STORE) throw new Error('NOTICE_STORE is not configured');
  const ip = normalizeIpAddress(value);
  if (!ip) throw new Error('invalid ip');
  const entries = await listBlockedIps(env);
  const existing = entries.find((item) => item.ip === ip);
  if (existing) return existing;
  const entry = {
    ip,
    reason: normalizeText(reasonValue, 500),
    createdAt: formatNoticeTime(),
  };
  await env.NOTICE_STORE.put(IP_BLOCK_LIST_KEY, JSON.stringify([...entries, entry]));
  return entry;
}

// 从全局封禁列表删除一个地址。
export async function deleteBlockedIp(env, value) {
  if (!env.NOTICE_STORE) throw new Error('NOTICE_STORE is not configured');
  const ip = normalizeIpAddress(value);
  if (!ip) throw new Error('invalid ip');
  const entries = await listBlockedIps(env);
  await env.NOTICE_STORE.put(IP_BLOCK_LIST_KEY, JSON.stringify(entries.filter((item) => item.ip !== ip)));
  return ip;
}

// 判断请求公网出口是否已被封禁；存储异常时保持公开服务可用。
export async function isRequestIpBlocked(env, request) {
  const clientIp = getRequestClientIp(request);
  if (!clientIp) return false;
  try {
    return (await listBlockedIps(env)).some((item) => item.ip === clientIp);
  } catch {
    return false;
  }
}
