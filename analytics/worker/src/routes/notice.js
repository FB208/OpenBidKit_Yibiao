import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  buildNoticeKey,
  buildNoticeMediaContent,
  deleteStoredNotice,
  incrementDeliveredUserCount,
  listEnabledNotices,
  listProjectNotices,
  readLatestEnabledNoticeUpdatedAt,
  readProjectNotice,
  readStoredNotice,
  saveStoredNotice,
  writeLatestNotice,
} from '../services/noticeStore.js';
import { isValidProjectName, normalizeText } from '../utils.js';

// 当前公告读取失败返回错误，避免客户端将网络故障视为清空当前版本。
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
    return json({ code: 500, message: 'notice query failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

// 客户端"公告"按钮读取全部启用的公告，已按更新时间倒序。
export async function handlePublicNotices(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const notices = await listEnabledNotices(env, projectName);
    return json({ code: 0, notices }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public notices failed', error?.message || String(error));
    return json({ code: 500, message: 'notices query failed' }, { status: 500 });
  }
}

// 客户端轮询红点时只读取最新启用公告的更新时间。
export async function handlePublicNoticeLatest(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const latestUpdatedAt = await readLatestEnabledNoticeUpdatedAt(env, projectName);
    return json({ code: 0, latestUpdatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public notice latest failed', error?.message || String(error));
    return json({ code: 500, message: 'notice latest query failed' }, { status: 500 });
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

// 校验管理端输入的 HTTP(S) 地址，不按扩展名推断媒体类型。
function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// 只校验当前公告类型所需的字段，并清除文字公告的隐藏媒体配置。
function readNoticePresentation(body, title) {
  const noticeType = body.noticeType === undefined ? 'text' : body.noticeType;
  if (noticeType === 'text') {
    const content = normalizeText(body.content || body.markdown, NOTICE_CONTENT_MAX_LENGTH);
    if (!content) throw new Error('请先填写 Markdown 内容');
    return { noticeType, content, media: null };
  }
  if (noticeType !== 'image') throw new Error('请选择文字公告或图片公告');

  const input = body.media;
  if (!input || !['image', 'video'].includes(input.kind)) throw new Error('请选择图片或视频');
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const linkUrl = typeof input.linkUrl === 'string' ? input.linkUrl.trim() : '';
  if (!isHttpUrl(url)) throw new Error('请填写有效的 HTTP(S) 图片或视频地址');
  if (linkUrl && !isHttpUrl(linkUrl)) throw new Error('点击跳转链接必须是 HTTP(S) 地址');
  if (!Number.isSafeInteger(input.closeDelaySeconds) || input.closeDelaySeconds < 0) {
    throw new Error('关闭倒计时必须是非负安全整数');
  }
  if (typeof input.openLinkOnClose !== 'boolean') throw new Error('请选择关闭时是否强制跳转');
  if (input.openLinkOnClose && !linkUrl) throw new Error('关闭时强制跳转需要填写点击跳转链接');
  const media = { kind: input.kind, url, linkUrl, closeDelaySeconds: input.closeDelaySeconds, openLinkOnClose: input.openLinkOnClose };
  if (buildNoticeMediaContent(title, media).length > NOTICE_CONTENT_MAX_LENGTH) {
    throw new Error('媒体或跳转地址过长，请缩短后保存');
  }
  return { noticeType, media };
}

// 保存公告当前类型的内容，沿用版本更新、KV 同步和送达计数规则。
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
  let presentation;

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (!title) {
    return json({ code: 400, message: '请先填写公告标题' }, { status: 400 });
  }

  try {
    presentation = readNoticePresentation(body, title);
  } catch (error) {
    return json({ code: 400, message: error.message }, { status: 400 });
  }

  try {
    const notice = await saveStoredNotice(env, {
      id,
      projectName,
      enabled: body.enabled !== false,
      title,
      ...presentation,
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
