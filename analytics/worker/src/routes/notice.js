import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { buildNoticeKey, createNoticeId, readProjectNotice } from '../services/noticeStore.js';
import { formatNoticeTime, isValidProjectName, normalizeText } from '../utils.js';

export async function handlePublicNotice(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const notice = await readProjectNotice(env, projectName);
    return json({
      code: 0,
      notice: notice?.enabled && notice.content ? notice : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public notice failed', error?.message || String(error));
    return json({ code: 0, notice: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function handleAdminNotice(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.NOTICE_STORE) {
    return json({ code: 500, message: 'NOTICE_STORE is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetNotice(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveNotice(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteNotice(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const notice = await readProjectNotice(env, projectName);
  return json({ code: 0, notice }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleAdminSaveNotice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const title = normalizeText(body.title, NOTICE_TITLE_MAX_LENGTH);
  const content = normalizeText(body.content || body.markdown, NOTICE_CONTENT_MAX_LENGTH);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (!title) {
    return json({ code: 400, message: 'missing title' }, { status: 400 });
  }

  if (!content) {
    return json({ code: 400, message: 'missing content' }, { status: 400 });
  }

  const now = formatNoticeTime();
  const notice = {
    id: createNoticeId(now),
    projectName,
    enabled: body.enabled !== false,
    title,
    content,
    createdAt: now,
    updatedAt: now,
  };

  await env.NOTICE_STORE.put(buildNoticeKey(projectName), JSON.stringify(notice));
  return json({ code: 0, notice });
}

async function handleAdminDeleteNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  await env.NOTICE_STORE.delete(buildNoticeKey(projectName));
  return json({ code: 0, notice: null });
}
