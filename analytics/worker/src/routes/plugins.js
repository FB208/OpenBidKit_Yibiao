import { corsHeaders, json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  deletePlugin,
  incrementPluginDownload,
  listAdminPlugins,
  listPublicPlugins,
  normalizePluginRow,
  readPlugin,
  upsertPlugin,
} from '../services/pluginStore.js';
import { normalizeText } from '../utils.js';

export async function handlePublicPlugins(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  try {
    const plugins = await listPublicPlugins(env, {
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
    });
    return json({ code: 0, plugins }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public plugins failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'plugins query failed' }, { status: 500 });
  }
}

/** 记录客户端成功完成的插件下载 */
export async function handlePublicPluginDownload(request, env) {
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
    const plugin = await incrementPluginDownload(env, id);
    if (!plugin) {
      return json({ code: 404, message: 'plugin not found' }, { status: 404 });
    }
    return json({ code: 0, downloadCount: plugin.downloadCount });
  } catch (error) {
    console.error('[analytics] record plugin download failed', error?.message || String(error));
    return json({ code: 500, message: 'plugin download record failed' }, { status: 500 });
  }
}

export async function handleAdminPlugins(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'RESOURCE_DB is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetPlugins(env);
  }

  if (request.method === 'POST') {
    return handleAdminSavePlugin(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeletePlugin(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetPlugins(env) {
  try {
    const plugins = await listAdminPlugins(env);
    return json({ code: 0, plugins }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] admin get plugins failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'plugins query failed' }, { status: 500 });
  }
}

async function handleAdminSavePlugin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const plugin = await upsertPlugin(env, body);
    return json({ code: 0, plugin });
  } catch (error) {
    console.error('[analytics] save plugin failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'plugin save failed' }, { status: 500 });
  }
}

async function handleAdminDeletePlugin(env, url) {
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!id) {
    return json({ code: 400, message: 'missing id' }, { status: 400 });
  }

  try {
    const deleted = await deletePlugin(env, id);
    if (!deleted) {
      return json({ code: 404, message: 'plugin not found' }, { status: 404 });
    }
    return json({ code: 0, plugin: null });
  } catch (error) {
    console.error('[analytics] delete plugin failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'plugin delete failed' }, { status: 500 });
  }
}
