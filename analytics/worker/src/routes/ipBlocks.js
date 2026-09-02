import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { cleanupTodayBlockRuleClients, deleteBlockRule, listBlockRules, saveBlockRule } from '../services/blockRuleStore.js';
import { listBlockedIps } from '../services/ipBlockStore.js';
import {
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

function normalizeRule(type, value, projectName) {
  if (type === 'ip') {
    const ip = normalizeIpAddress(value);
    return ip ? { type, value: ip, projectName: '' } : null;
  }
  if (type === 'version') {
    if (value == null) return null;
    const version = normalizeText(value, 50);
    if ((!version && String(value) !== '') || version === '-') return null;
    return { type, value: version, projectName };
  }
  return null;
}

// 管理员读取、添加和解除统一封禁规则。
export async function handleAdminBlockRules(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  const queryProjectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (request.method === 'GET') {
    if (!isValidProjectName(queryProjectName)) return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    return json({ code: 0, rules: await listBlockRules(env, queryProjectName) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ code: 400, message: 'invalid json body' }, { status: 400 }); }
    const projectName = normalizeText(body.projectName, 80);
    const rule = normalizeRule(normalizeText(body.type, 20), body.value, projectName);
    if (!rule || !isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid params' }, { status: 400 });
    }
    try {
      await saveBlockRule(env, rule, body.reason);
    } catch (error) {
      logQueryError('block-rule-save', error);
      return json({ code: 500, message: 'save failed' }, { status: 500 });
    }
    try {
      const cleanup = await cleanupTodayBlockRuleClients(env, rule, projectName);
      return json({ code: 0, rule, cleanup: { status: 'success', ...cleanup } });
    } catch (error) {
      logQueryError('block-rule-today-cleanup', error);
      return json({
        code: 0,
        rule,
        cleanup: { status: 'failed', error: normalizeText(error?.message || String(error), 1000) },
      });
    }
  }
  if (request.method === 'DELETE') {
    const rule = normalizeRule(normalizeText(url.searchParams.get('type'), 20), url.searchParams.get('value'), queryProjectName);
    if (!rule || !isValidProjectName(queryProjectName)) {
      return json({ code: 400, message: 'invalid params' }, { status: 400 });
    }
    try {
      return json({ code: 0, deleted: await deleteBlockRule(env, rule) });
    } catch (error) {
      logQueryError('block-rule-delete', error);
      return json({ code: 500, message: 'delete failed' }, { status: 500 });
    }
  }
  return methodNotAllowed();
}
