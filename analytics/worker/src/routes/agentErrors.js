import { corsHeaders, json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  checkAgentErrorReception,
  deleteAgentErrors,
  getAgentErrorDownload,
  listAgentErrors,
  normalizeAgentErrorMeta,
  readAgentErrorConfig,
  saveAgentErrorConfig,
  storeAgentError,
  verifyAgentErrorLicense,
} from '../services/agentErrorStore.js';
import { isValidProjectName, normalizeText } from '../utils.js';

function decodeBase64UrlJson(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// 接收客户端 gzip 诊断包，未开启或版本不匹配时不读取正文。
export async function handleAgentErrorIngest(request, env, url) {
  if (request.method === 'GET') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    const version = normalizeText(url.searchParams.get('version'), 50);
    const reception = await checkAgentErrorReception(env, projectName, version);
    return json({ code: 0, accepted: reception.accepted === true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return methodNotAllowed();
  let meta;
  try {
    meta = normalizeAgentErrorMeta(decodeBase64UrlJson(request.headers.get('X-Yibiao-Report-Meta')));
  } catch {
    meta = null;
  }
  if (!meta) return json({ code: 400, message: 'invalid report meta' }, { status: 400 });

  const reception = await checkAgentErrorReception(env, meta.projectName, meta.version, meta.compressedBytes);
  if (!reception.accepted) {
    return json({ code: 0, accepted: false, reason: reception.reason }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let license;
  try {
    license = decodeBase64UrlJson(request.headers.get('X-Yibiao-License'));
  } catch {
    license = null;
  }
  if (!await verifyAgentErrorLicense(env, license, meta)) return unauthorized();
  if (request.headers.get('Content-Type') !== 'application/gzip') {
    return json({ code: 400, message: 'invalid content type' }, { status: 400 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength !== meta.compressedBytes) {
    return json({ code: 400, message: 'invalid content length' }, { status: 400 });
  }
  const result = await storeAgentError(env, meta, body, reception.retentionDays);
  return json({ code: 0, ...result }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function handleAdminAgentErrorConfig(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (request.method === 'GET') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    if (!isValidProjectName(projectName)) return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    return json({ code: 0, config: await readAgentErrorConfig(env, projectName) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ code: 400, message: 'invalid json body' }, { status: 400 }); }
    try {
      return json({ code: 0, config: await saveAgentErrorConfig(env, body) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return json({ code: 400, message: error?.message || 'save failed' }, { status: 400 });
    }
  }
  return methodNotAllowed();
}

export async function handleAdminAgentErrors(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  if (request.method === 'GET') {
    return json({
      code: 0,
      ...(await listAgentErrors(env, projectName, url.searchParams.get('page'), url.searchParams.get('pageSize'))),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    return json({ code: 0, ...(await deleteAgentErrors(env, projectName, body.ids || [])) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return methodNotAllowed();
}

export async function handleAdminAgentErrorDownload(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (request.method !== 'GET') return methodNotAllowed();
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const reportId = normalizeText(url.searchParams.get('id'), 80);
  if (!isValidProjectName(projectName) || !reportId) return json({ code: 400, message: 'invalid params' }, { status: 400 });
  const download = await getAgentErrorDownload(env, projectName, reportId);
  if (!download) return json({ code: 404, message: 'log not found' }, { status: 404 });
  return new Response(download.object.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="agent-error-${download.row.id}.json.gz"`,
      'Cache-Control': 'no-store',
    },
  });
}
