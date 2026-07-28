import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  readCachedModelInfo,
  readModelInfoCacheStatus,
  syncModelInfoCache,
} from '../services/modelInfoCache.js';
import { normalizeText } from '../utils.js';

// 返回客户端按模型名称查询的思考强度和上下文限制。
export async function handlePublicModelInfo(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed();

  const modelName = normalizeText(url.searchParams.get('modelName'), 200);
  if (!modelName) {
    return json({ code: 400, message: 'missing modelName' }, { status: 400 });
  }

  try {
    const cached = await readCachedModelInfo(env, modelName);
    if (!cached.available) {
      return json({ code: 503, message: 'model info cache is unavailable' }, { status: 503 });
    }
    return json({
      code: 0,
      modelName,
      model: cached.model,
      syncedAt: cached.index?.syncedAt || '',
      message: cached.model ? 'ok' : 'model info not found',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public model info failed', error?.message || String(error));
    return json({ code: 500, message: 'model info query failed' }, { status: 500 });
  }
}

// 提供管理端缓存状态读取和手动同步。
export async function handleAdminModelInfoCache(request, env) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (!env.NOTICE_STORE) {
    return json({ code: 500, message: 'NOTICE_STORE is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return json({ code: 0, status: await readModelInfoCacheStatus(env) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST') {
    try {
      const result = await syncModelInfoCache(env, 'manual');
      return json({ code: 0, status: result.status }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('[analytics] manual model info sync failed', error?.message || String(error));
      return json({ code: 502, message: error?.message || 'model info sync failed' }, { status: 502 });
    }
  }
  return methodNotAllowed();
}
