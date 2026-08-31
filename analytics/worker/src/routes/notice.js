import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  buildNoticeKey,
  deleteStoredNotice,
  incrementDeliveredUserCount,
  listProjectNotices,
  readProjectNotice,
  readStoredNotice,
  saveStoredNotice,
  writeLatestNotice,
} from '../services/noticeStore.js';
import { isValidProjectName, normalizeText } from '../utils.js';

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

// 接收客户端公告弹窗展示后的送达计数。
export async function handlePublicNoticeDelivered(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'RESOURCE_DB is not configured' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const noticeId = normalizeText(body.noticeId || body.notice_id, 80);
  if (!isValidProjectName(projectName) || !noticeId) {
    return json({ code: 400, message: 'invalid projectName or noticeId' }, { status: 400 });
  }

  try {
    const deliveredUserCount = await incrementDeliveredUserCount(env, projectName, noticeId);
    if (deliveredUserCount === null) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    return json({ code: 0, deliveredUserCount }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] notice delivered count failed', error?.message || String(error));
    return json({ code: 500, message: 'notice delivered count failed' }, { status: 500 });
  }
}

export async function handleAdminNotice(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB || !env.NOTICE_STORE) {
    return json({ code: 500, message: 'notice storage is not configured' }, { status: 500 });
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

  try {
    const [notices, currentNotice] = await Promise.all([
      listProjectNotices(env, projectName),
      readProjectNotice(env, projectName),
    ]);
    return json({
      code: 0,
      notices: notices.map((notice) => ({
        ...notice,
        current: currentNotice?.id === notice.clientNoticeId,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] admin notices query failed', error?.message || String(error));
    return json({ code: 500, message: 'notices query failed' }, { status: 500 });
  }
}

async function handleAdminSaveNotice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const id = normalizeText(body.id, 120);
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

  try {
    const notice = await saveStoredNotice(env, {
      id,
      projectName,
      enabled: body.enabled !== false,
      title,
      content,
    });
    if (!notice) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    try {
      await writeLatestNotice(env, notice);
    } catch (error) {
      if (!id) {
        await deleteStoredNotice(env, projectName, notice.id).catch(() => undefined);
      }
      throw error;
    }
    return json({ code: 0, notice: { ...notice, current: true } });
  } catch (error) {
    console.error('[analytics] save notice failed', error?.message || String(error));
    return json({ code: 500, message: 'notice save failed' }, { status: 500 });
  }
}

async function handleAdminDeleteNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!isValidProjectName(projectName) || !id) {
    return json({ code: 400, message: 'invalid projectName or id' }, { status: 400 });
  }

  try {
    const [notice, currentNotice] = await Promise.all([
      readStoredNotice(env, projectName, id),
      readProjectNotice(env, projectName),
    ]);
    if (!notice) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    if (currentNotice?.id === notice.clientNoticeId) {
      await env.NOTICE_STORE.delete(buildNoticeKey(projectName));
    }
    await deleteStoredNotice(env, projectName, id);
    return json({ code: 0, notice: null });
  } catch (error) {
    console.error('[analytics] delete notice failed', error?.message || String(error));
    return json({ code: 500, message: 'notice delete failed' }, { status: 500 });
  }
}
