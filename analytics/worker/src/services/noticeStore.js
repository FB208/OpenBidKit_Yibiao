import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_KEY_PREFIX, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { formatNoticeTime, normalizeText } from '../utils.js';

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

// 将 D1 公告记录转换为管理端使用的数据结构。
export function normalizeAdminNoticeRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id, 120),
    clientNoticeId: normalizeText(row.client_notice_id, 80),
    projectName: normalizeText(row.project_name, 80),
    enabled: Number(row.enabled) !== 0,
    title: normalizeText(row.title, NOTICE_TITLE_MAX_LENGTH),
    content: normalizeText(row.content, NOTICE_CONTENT_MAX_LENGTH),
    deliveredUserCount: Math.max(0, Number(row.delivered_user_count) || 0),
    createdAt: normalizeText(row.created_at, 40),
    updatedAt: normalizeText(row.updated_at, 40),
  };
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

// 查询指定项目永久保存的全部公告。
export async function listProjectNotices(env, projectName) {
  const result = await requireResourceDb(env).prepare(
    `SELECT id, client_notice_id, project_name, title, content, enabled,
       delivered_user_count, created_at, updated_at
     FROM notices
     WHERE project_name = ?
     ORDER BY updated_at DESC, id DESC`,
  ).bind(projectName).all();

  return (result.results || []).map(normalizeAdminNoticeRow).filter(Boolean);
}

// 按管理端稳定 ID 读取一条公告。
export async function readStoredNotice(env, projectName, id) {
  const row = await requireResourceDb(env).prepare(
    `SELECT id, client_notice_id, project_name, title, content, enabled,
       delivered_user_count, created_at, updated_at
     FROM notices
     WHERE project_name = ? AND id = ?`,
  ).bind(projectName, id).first();

  return normalizeAdminNoticeRow(row);
}

// 新增或更新 D1 公告；每次保存生成新的客户端版本并重置送达计数。
export async function saveStoredNotice(env, input) {
  const db = requireResourceDb(env);
  const now = formatNoticeTime();
  const clientNoticeId = createNoticeId(now);
  const id = normalizeText(input.id, 120);
  let row;

  if (id) {
    row = await db.prepare(
      `UPDATE notices
       SET client_notice_id = ?, title = ?, content = ?, enabled = ?,
         delivered_user_count = 0, updated_at = ?
       WHERE project_name = ? AND id = ?
       RETURNING id, client_notice_id, project_name, title, content, enabled,
         delivered_user_count, created_at, updated_at`,
    ).bind(
      clientNoticeId,
      input.title,
      input.content,
      input.enabled ? 1 : 0,
      now,
      input.projectName,
      id,
    ).first();
  } else {
    const recordId = `notice-record-${createNoticeId(now).slice('notice-'.length)}`;
    row = await db.prepare(
      `INSERT INTO notices (
         id, client_notice_id, project_name, title, content, enabled,
         delivered_user_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       RETURNING id, client_notice_id, project_name, title, content, enabled,
         delivered_user_count, created_at, updated_at`,
    ).bind(
      recordId,
      clientNoticeId,
      input.projectName,
      input.title,
      input.content,
      input.enabled ? 1 : 0,
      now,
      now,
    ).first();
  }

  return normalizeAdminNoticeRow(row);
}

// 将管理端公告转换为客户端既有格式并写入 KV。
export async function writeLatestNotice(env, notice) {
  const payload = {
    id: notice.clientNoticeId,
    projectName: notice.projectName,
    enabled: notice.enabled,
    title: notice.title,
    content: notice.content,
    createdAt: notice.createdAt,
    updatedAt: notice.updatedAt,
  };
  await env.NOTICE_STORE.put(buildNoticeKey(notice.projectName), JSON.stringify(payload));
}

// 永久删除一条 D1 公告。
export async function deleteStoredNotice(env, projectName, id) {
  await requireResourceDb(env).prepare(
    'DELETE FROM notices WHERE project_name = ? AND id = ?',
  ).bind(projectName, id).run();
}

// 按客户端公告版本原子累加送达次数。
export async function incrementDeliveredUserCount(env, projectName, clientNoticeId) {
  const row = await requireResourceDb(env).prepare(
    `UPDATE notices
     SET delivered_user_count = delivered_user_count + 1
     WHERE project_name = ? AND client_notice_id = ?
     RETURNING delivered_user_count`,
  ).bind(projectName, clientNoticeId).first();

  return row ? Math.max(0, Number(row.delivered_user_count) || 0) : null;
}

function requireResourceDb(env) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }
  return env.RESOURCE_DB;
}
