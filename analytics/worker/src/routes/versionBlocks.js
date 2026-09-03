import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { blockVersionAndDeleteStatsClients, unblockVersionAndReleaseStatsClients } from '../services/analyticsStatsStore.js';
import { listVersionBlocks } from '../services/versionBlockStore.js';
import { isValidProjectName, logQueryError, normalizeText } from '../utils.js';

// 管理员读取、添加和删除项目级版本号封禁规则；version 允许空字符串表示“空版本号”规则。
export async function handleAdminVersionBlocks(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();

  if (request.method === 'GET') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }
    return json({ code: 0, versionBlocks: await listVersionBlocks(env, projectName) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ code: 400, message: 'invalid json body' }, { status: 400 }); }
    const projectName = normalizeText(body.projectName, 80);
    const version = normalizeText(body.version, 50);
    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid params' }, { status: 400 });
    }
    try {
      return json({
        code: 0,
        ...(await blockVersionAndDeleteStatsClients(env, projectName, version, body.reason)),
      });
    } catch (error) {
      logQueryError('version-block-save', error);
      return json({ code: 500, message: 'save failed' }, { status: 500 });
    }
  }

  if (request.method === 'DELETE') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    const version = normalizeText(url.searchParams.get('version') ?? '', 50);
    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid params' }, { status: 400 });
    }
    try {
      return json({
        code: 0,
        ...(await unblockVersionAndReleaseStatsClients(env, projectName, version)),
      });
    } catch (error) {
      logQueryError('version-block-delete', error);
      return json({ code: 500, message: 'delete failed' }, { status: 500 });
    }
  }

  return methodNotAllowed();
}
