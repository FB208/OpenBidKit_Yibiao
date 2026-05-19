import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_KEY_PREFIX, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { normalizeText } from '../utils.js';

export function buildNoticeKey(projectName) {
  return `${NOTICE_KEY_PREFIX}${projectName}`;
}

export function createNoticeId(now) {
  const timestamp = now.replace(/[-: ]/g, '').slice(0, 14);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `notice-${timestamp}-${random}`;
}

export function normalizeNoticeForResponse(notice) {
  if (!notice || typeof notice !== 'object') {
    return null;
  }

  return {
    id: normalizeText(notice.id, 80),
    projectName: normalizeText(notice.projectName, 80),
    enabled: notice.enabled !== false,
    title: normalizeText(notice.title, NOTICE_TITLE_MAX_LENGTH),
    content: normalizeText(notice.content, NOTICE_CONTENT_MAX_LENGTH),
    createdAt: normalizeText(notice.createdAt, 40),
    updatedAt: normalizeText(notice.updatedAt, 40),
  };
}

export async function readProjectNotice(env, projectName) {
  if (!env.NOTICE_STORE) {
    return null;
  }

  const raw = await env.NOTICE_STORE.get(buildNoticeKey(projectName));
  if (!raw) {
    return null;
  }

  try {
    return normalizeNoticeForResponse(JSON.parse(raw));
  } catch {
    return null;
  }
}
