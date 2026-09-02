import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { blockIpAndDeleteStatsClients, unblockIpAndReleaseStatsClients } from '../services/analyticsStatsStore.js';
import { listBlockedIps } from '../services/ipBlockStore.js';
import {
  addBusinessDateDays,
  getBusinessToday,
  getRequestClientIp,
  isValidProjectName,
  logQueryError,
  normalizeIpAddress,
  normalizeText,
} from '../utils.js';

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
    const ip = normalizeIpAddress(body.ip);
    const projectName = normalizeText(body.projectName, 80);
    const activityDate = normalizeText(body.date, 10);
    const validDate = !activityDate || (
      /^\d{4}-\d{2}-\d{2}$/.test(activityDate)
      && addBusinessDateDays(activityDate, 0) === activityDate
      && activityDate <= getBusinessToday()
    );
    if (!ip || !isValidProjectName(projectName) || !validDate) {
      return json({ code: 400, message: 'invalid params' }, { status: 400 });
    }
    try {
      return json({
        code: 0,
        ...(await blockIpAndDeleteStatsClients(env, projectName, ip, body.reason, activityDate)),
      });
    } catch (error) {
      logQueryError('ip-block-save', error);
      return json({ code: 500, message: 'save failed' }, { status: 500 });
    }
  }
  if (request.method === 'DELETE') {
    const ip = normalizeIpAddress(url.searchParams.get('ip'));
    if (!ip) {
      return json({ code: 400, message: 'invalid ip' }, { status: 400 });
    }
    try {
      return json({ code: 0, ...(await unblockIpAndReleaseStatsClients(env, ip)) });
    } catch (error) {
      logQueryError('ip-block-delete', error);
      return json({ code: 500, message: 'delete failed' }, { status: 500 });
    }
  }
  return methodNotAllowed();
}
