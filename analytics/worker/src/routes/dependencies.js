import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  deleteDependency,
  incrementDependencyDownload,
  listAdminDependencies,
  listPublicDependencies,
  upsertDependency,
} from '../services/dependencyStore.js';
import { normalizeText } from '../utils.js';

/** 客户端读取可下载的功能组件 */
export async function handlePublicDependencies(request, env) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  try {
    const dependencies = await listPublicDependencies(env);
    return json({ code: 0, dependencies }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public dependencies failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'dependencies query failed' }, { status: 500 });
  }
}

/** 记录客户端成功完成的依赖下载 */
export async function handlePublicDependencyDownload(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid JSON body' }, { status: 400 });
  }

  const id = normalizeText(body.id, 80);
  if (!id) {
    return json({ code: 400, message: 'missing id' }, { status: 400 });
  }

  try {
    const change = await incrementDependencyDownload(env, id, body.platform);
    if (!change) {
      return json({ code: 404, message: 'dependency not found' }, { status: 404 });
    }
    return json({ code: 0, downloadCount: change.downloadCount });
  } catch (error) {
    console.error('[analytics] record dependency download failed', error?.message || String(error));
    return json({ code: 500, message: 'dependency download record failed' }, { status: 500 });
  }
}

export async function handleAdminDependencies(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'RESOURCE_DB is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetDependencies(env);
  }

  if (request.method === 'POST') {
    return handleAdminSaveDependency(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteDependency(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetDependencies(env) {
  try {
    const dependencies = await listAdminDependencies(env);
    return json({ code: 0, dependencies }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] admin get dependencies failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'dependencies query failed' }, { status: 500 });
  }
}

async function handleAdminSaveDependency(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const dependency = await upsertDependency(env, body);
    return json({ code: 0, dependency });
  } catch (error) {
    console.error('[analytics] save dependency failed', error?.message || String(error));
    const status = Number(error?.statusCode) || 500;
    return json({ code: status, message: error?.message || 'dependency save failed' }, { status });
  }
}

async function handleAdminDeleteDependency(env, url) {
  const id = normalizeText(url.searchParams.get('id'), 80);
  if (!id) {
    return json({ code: 400, message: 'missing id' }, { status: 400 });
  }

  try {
    const deleted = await deleteDependency(env, id, url.searchParams.get('platform'));
    if (!deleted) {
      return json({ code: 404, message: 'dependency not found' }, { status: 404 });
    }
    return json({ code: 0, dependency: null });
  } catch (error) {
    console.error('[analytics] delete dependency failed', error?.message || String(error));
    return json({ code: 500, message: 'dependency delete failed' }, { status: 500 });
  }
}
