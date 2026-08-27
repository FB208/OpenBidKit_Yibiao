import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { addBlockedIp, deleteBlockedIp, listBlockedIps } from '../services/ipBlockStore.js';
import { getRequestClientIp } from '../utils.js';

// 返回客户端启动检查所需的封禁列表和公网出口 IP。
export async function handlePublicIpBlocks(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();
  try {
    const entries = await listBlockedIps(env);
    return json({
      code: 0,
      clientIp: getRequestClientIp(request),
      blockedIps: entries.map((item) => item.ip),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return json({ code: 0, clientIp: '', blockedIps: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

// 管理员读取、添加和删除全局封禁 IP。
export async function handleAdminIpBlocks(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (request.method === 'GET') {
    return json({ code: 0, blockedIps: await listBlockedIps(env) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ code: 400, message: 'invalid json body' }, { status: 400 }); }
    try {
      return json({ code: 0, blockedIp: await addBlockedIp(env, body.ip, body.reason) });
    } catch (error) {
      return json({ code: 400, message: error?.message || 'save failed' }, { status: 400 });
    }
  }
  if (request.method === 'DELETE') {
    try {
      return json({ code: 0, ip: await deleteBlockedIp(env, url.searchParams.get('ip')) });
    } catch (error) {
      return json({ code: 400, message: error?.message || 'delete failed' }, { status: 400 });
    }
  }
  return methodNotAllowed();
}
