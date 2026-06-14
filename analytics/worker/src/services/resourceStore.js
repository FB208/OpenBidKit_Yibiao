import {
  RESOURCE_DESCRIPTION_MAX_LENGTH,
  RESOURCE_MODAL_CONTENT_MAX_LENGTH,
  RESOURCE_TAGS_MAX_LENGTH,
  RESOURCE_TITLE_MAX_LENGTH,
} from '../constants.js';
import { formatNoticeTime, normalizeText } from '../utils.js';

const RESOURCE_IMAGE_KEY_PREFIX = 'resources/';

export function createResourceId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `resource-${timestamp}-${random}`;
}

export function splitResourceTags(value) {
  const tags = String(value || '')
    .split(/[，,;；\n\r]+/)
    .map((item) => normalizeText(item, 40))
    .filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 20);
}

export function normalizeTagsText(value) {
  return normalizeText(splitResourceTags(value).join(', '), RESOURCE_TAGS_MAX_LENGTH);
}

export function normalizeResourceInput(input) {
  return {
    title: normalizeText(input.title, RESOURCE_TITLE_MAX_LENGTH),
    tags: normalizeTagsText(input.tags),
    description: normalizeText(input.description, RESOURCE_DESCRIPTION_MAX_LENGTH),
    modalContent: normalizeText(input.modalContent ?? input.modal_content, RESOURCE_MODAL_CONTENT_MAX_LENGTH),
    enabled: input.enabled !== false && input.enabled !== 'false' && input.enabled !== '0',
    sortOrder: normalizeSortOrder(input.sortOrder ?? input.sort_order),
  };
}

export function normalizeResourceRow(row, origin = '') {
  if (!row) {
    return null;
  }

  const id = normalizeText(row.id, 120);
  const imageKey = normalizeImageKey(row.image_key);
  const imageUrl = imageKey ? buildResourceImageUrl(origin, imageKey) : '';

  return {
    id,
    title: normalizeText(row.title, RESOURCE_TITLE_MAX_LENGTH),
    tags: splitResourceTags(row.tags),
    tagsText: normalizeText(row.tags, RESOURCE_TAGS_MAX_LENGTH),
    description: normalizeText(row.description, RESOURCE_DESCRIPTION_MAX_LENGTH),
    modalContent: normalizeText(row.modal_content, RESOURCE_MODAL_CONTENT_MAX_LENGTH),
    imageKey,
    imageUrl,
    analyticsKey: createResourceAnalyticsKey(id),
    clickCount: normalizeClickCount(row.click_count),
    sortOrder: normalizeSortOrder(row.sort_order),
    enabled: Number(row.enabled) !== 0,
    createdAt: normalizeText(row.created_at, 40),
    updatedAt: normalizeText(row.updated_at, 40),
  };
}

export function createResourceAnalyticsKey(id) {
  const text = normalizeText(id, 120);
  if (!text) {
    return '';
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r_${hash.toString(36)}`;
}

export function buildResourceImageUrl(origin, imageKey) {
  const key = normalizeImageKey(imageKey);
  if (!key) {
    return '';
  }
  const base = String(origin || '').replace(/\/+$/, '');
  const path = `/resource-image?key=${encodeURIComponent(key)}`;
  return base ? `${base}${path}` : path;
}

export function normalizeImageKey(value) {
  const key = String(value || '').trim().replace(/\\/g, '/');
  if (!key || !key.startsWith(RESOURCE_IMAGE_KEY_PREFIX)) {
    return '';
  }
  if (key.includes('..') || key.includes('//') || key.length > 500) {
    return '';
  }
  return key;
}

export function createResourceImageKey(resourceId, fileName, contentType) {
  const safeId = normalizeText(resourceId, 120).replace(/[^a-zA-Z0-9._-]/g, '-');
  const extension = getImageExtension(fileName, contentType);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${RESOURCE_IMAGE_KEY_PREFIX}${safeId}/${Date.now()}-${random}.${extension}`;
}

export async function listPublicResources(env, { query = '', origin = '' } = {}) {
  const db = requireResourceDb(env);
  const q = normalizeText(query, 120);
  const columns = 'id, title, tags, description, modal_content, image_key, image_url, click_count, sort_order, enabled, created_at, updated_at';

  let result;
  if (q) {
    const like = `%${escapeLike(q)}%`;
    result = await db.prepare(
      `SELECT ${columns}
       FROM resources
       WHERE enabled = 1
         AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR modal_content LIKE ? ESCAPE '\\')
       ORDER BY sort_order ASC, updated_at DESC
       LIMIT 200`,
    ).bind(like, like, like, like).all();
  } else {
    result = await db.prepare(
      `SELECT ${columns}
       FROM resources
       WHERE enabled = 1
       ORDER BY sort_order ASC, updated_at DESC
       LIMIT 200`,
    ).all();
  }

  return (result.results || []).map((row) => normalizeResourceRow(row, origin)).filter(Boolean);
}

export async function listAdminResources(env, { origin = '' } = {}) {
  const db = requireResourceDb(env);
  const result = await db.prepare(
    `SELECT id, title, tags, description, modal_content, image_key, image_url, click_count, sort_order, enabled, created_at, updated_at
     FROM resources
     ORDER BY sort_order ASC, updated_at DESC
     LIMIT 500`,
  ).all();

  return (result.results || []).map((row) => normalizeResourceRow(row, origin)).filter(Boolean);
}

export async function readResource(env, id, { origin = '' } = {}) {
  const db = requireResourceDb(env);
  const resourceId = normalizeText(id, 120);
  if (!resourceId) {
    return null;
  }

  const row = await db.prepare(
    `SELECT id, title, tags, description, modal_content, image_key, image_url, click_count, sort_order, enabled, created_at, updated_at
     FROM resources
     WHERE id = ?`,
  ).bind(resourceId).first();

  return normalizeResourceRow(row, origin);
}

export async function upsertResource(env, input, { origin = '' } = {}) {
  const db = requireResourceDb(env);
  const now = formatNoticeTime();
  const requestedId = normalizeText(input.id, 120);
  const id = requestedId || createResourceId();
  const existing = requestedId ? await readResource(env, requestedId, { origin }) : null;
  const normalized = normalizeResourceInput(input);

  if (!normalized.title) {
    throw new Error('missing title');
  }

  const imageKey = normalizeImageKey(input.imageKey ?? input.image_key);
  const imageUrl = imageKey ? buildResourceImageUrl(origin, imageKey) : '';
  const createdAt = existing?.createdAt || now;

  if (!existing) {
    await shiftSortOrderForInsert(db, normalized.sortOrder);
  }

  await db.prepare(
    `INSERT INTO resources (id, title, tags, description, modal_content, image_key, image_url, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       tags = excluded.tags,
       description = excluded.description,
       modal_content = excluded.modal_content,
       image_key = excluded.image_key,
       image_url = excluded.image_url,
       sort_order = excluded.sort_order,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).bind(
    id,
    normalized.title,
    normalized.tags,
    normalized.description,
    normalized.modalContent,
    imageKey,
    imageUrl,
    normalized.sortOrder,
    normalized.enabled ? 1 : 0,
    createdAt,
    now,
  ).run();

  return readResource(env, id, { origin });
}

export async function deleteResource(env, id) {
  const db = requireResourceDb(env);
  const resourceId = normalizeText(id, 120);
  if (!resourceId) {
    throw new Error('missing id');
  }

  const existing = await readResource(env, resourceId);
  await db.prepare('DELETE FROM resources WHERE id = ?').bind(resourceId).run();
  return existing;
}

async function shiftSortOrderForInsert(db, sortOrder) {
  const result = await db.prepare(
    `SELECT sort_order
     FROM resources
     WHERE sort_order >= ?
     ORDER BY sort_order ASC
     LIMIT 1000`,
  ).bind(sortOrder).all();

  let upperOrder = sortOrder;
  for (const row of result.results || []) {
    const order = normalizeSortOrder(row.sort_order);
    if (order < upperOrder) {
      continue;
    }
    if (order > upperOrder) {
      break;
    }
    upperOrder += 1;
  }

  if (upperOrder === sortOrder) {
    return;
  }

  await db.prepare(
    `UPDATE resources
     SET sort_order = sort_order + 1
     WHERE sort_order >= ?
       AND sort_order < ?`,
  ).bind(sortOrder, upperOrder).run();
}

function requireResourceDb(env) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }
  return env.RESOURCE_DB;
}

function normalizeSortOrder(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(-999999, Math.min(999999, Math.trunc(number)));
}

function normalizeClickCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function getImageExtension(fileName, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type === 'image/png') return 'png';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';

  const extension = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1] || 'png';
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? extension.replace('jpeg', 'jpg') : 'png';
}
