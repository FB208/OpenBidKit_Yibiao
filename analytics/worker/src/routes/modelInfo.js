import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  deleteModelInfoOverride,
  listAdminModelInfo,
  readCachedModelInfo,
  readModelInfoCacheStatus,
  saveModelInfoOverride,
  syncModelInfoCache,
} from '../services/modelInfoCache.js';
import { normalizeText } from '../utils.js';

function parseNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

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
export async function handleAdminModelInfoCache(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (!env.NOTICE_STORE) {
    return json({ code: 500, message: 'NOTICE_STORE is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    const [status, details] = await Promise.all([
      readModelInfoCacheStatus(env),
      listAdminModelInfo(env, {
        query: normalizeText(url.searchParams.get('q'), 200),
        scope: url.searchParams.get('scope') === 'overridden' ? 'overridden' : 'all',
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
      }),
    ]);
    return json({ code: 0, status, ...details }, { headers: { 'Cache-Control': 'no-store' } });
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

// 保存或恢复管理员对单条模型索引的人工覆盖。
export async function handleAdminModelInfoOverride(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (!env.NOTICE_STORE) {
    return json({ code: 500, message: 'NOTICE_STORE is not configured' }, { status: 500 });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const modelName = normalizeText(body?.modelName, 200);
    const context = parseNonNegativeInteger(body?.context);
    const output = parseNonNegativeInteger(body?.output);
    if (!modelName) {
      return json({ code: 400, message: 'missing modelName' }, { status: 400 });
    }
    if (!Array.isArray(body?.reasoningEfforts) || body.reasoningEfforts.length > 20 || context === null || output === null) {
      return json({ code: 400, message: 'invalid model info' }, { status: 400 });
    }

    const cached = await readCachedModelInfo(env, modelName);
    if (!cached.available) {
      return json({ code: 503, message: 'model info cache is unavailable' }, { status: 503 });
    }
    if (!cached.model) {
      return json({ code: 404, message: 'model info not found' }, { status: 404 });
    }

    const reasoningEfforts = [...new Set(body.reasoningEfforts
      .map((value) => normalizeText(value, 40))
      .filter(Boolean))];
    const model = await saveModelInfoOverride(env, modelName, { reasoningEfforts, context, output });
    return json({ code: 0, modelName, model }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'DELETE') {
    const modelName = normalizeText(url.searchParams.get('modelName'), 200);
    if (!modelName) {
      return json({ code: 400, message: 'missing modelName' }, { status: 400 });
    }
    await deleteModelInfoOverride(env, modelName);
    const restored = await readCachedModelInfo(env, modelName);
    return json({ code: 0, modelName, model: restored.model }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return methodNotAllowed();
}
