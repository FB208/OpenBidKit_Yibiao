import {
  AD_LINK_MAX_LENGTH,
  ADS_MAX_COUNT,
} from '../constants.js';
import { formatNoticeTime, normalizeText } from '../utils.js';
import { buildResourceImageUrl, normalizeImageKey } from './resourceStore.js';

// 每条广告是独立 R2 对象，增删改只动自己那条，不存在整份配置的读改写覆盖。
const AD_OBJECT_KEY_PREFIX = 'resources/system/ads/';

export function createAdId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `ad-${timestamp}-${random}`;
}

// 广告跳转链接只允许 http/https，避免客户端 openExternal 打开异常协议。
export function normalizeLinkUrl(value) {
  const text = normalizeText(value, AD_LINK_MAX_LENGTH);
  if (!text) {
    return '';
  }

  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeAdRow(object, origin = '') {
  if (!object) {
    return null;
  }

  const key = normalizeText(object.key, 500);
  const meta = object.customMetadata || {};
  const id = key.startsWith(AD_OBJECT_KEY_PREFIX) ? normalizeText(key.slice(AD_OBJECT_KEY_PREFIX.length), 120) : '';
  if (!id) {
    return null;
  }

  const imageKey = normalizeImageKey(meta.image_key);
  return {
    id,
    linkUrl: normalizeLinkUrl(meta.link_url),
    imageKey,
    imageUrl: imageKey ? buildResourceImageUrl(origin, imageKey) : '',
    enabled: meta.enabled !== '0' && meta.enabled !== 'false',
    sortOrder: normalizeSortOrder(meta.sort_order),
    createdAt: normalizeText(meta.created_at, 40),
    updatedAt: normalizeText(meta.updated_at, 40) || object.uploaded?.toISOString?.() || '',
  };
}

function adObjectKey(id) {
  return `${AD_OBJECT_KEY_PREFIX}${id}`;
}

function requireBucket(env) {
  if (!env.RESOURCE_BUCKET) {
    throw new Error('RESOURCE_BUCKET is not configured');
  }
  return env.RESOURCE_BUCKET;
}

// 读取或写入失败直接抛错，由调用方决定降级；不存在只是 list 结果为空。
async function listAdObjects(env) {
  const bucket = requireBucket(env);
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({
      prefix: AD_OBJECT_KEY_PREFIX,
      include: ['customMetadata'],
      cursor,
      limit: 1000,
    });
    objects.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function sortAds(ads) {
  return [...ads].sort((a, b) => (a.sortOrder - b.sortOrder) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function listAdminAds(env, { origin = '' } = {}) {
  const objects = await listAdObjects(env);
  return sortAds(objects.map((object) => normalizeAdRow(object, origin)).filter(Boolean));
}

// 客户端只拿到启用且图片、链接齐全的广告；读取失败时降级为空列表。
export async function listPublicAds(env, { origin = '' } = {}) {
  try {
    const ads = await listAdminAds(env, { origin });
    return ads.filter((ad) => ad.enabled && ad.linkUrl && ad.imageUrl);
  } catch (error) {
    console.error('[analytics] list public ads failed', error?.message || String(error));
    return [];
  }
}

export async function readAd(env, id, { origin = '' } = {}) {
  const adId = normalizeText(id, 120);
  if (!adId) {
    return null;
  }

  const object = await requireBucket(env).head(adObjectKey(adId));
  return normalizeAdRow(object, origin);
}

export async function upsertAd(env, input, { origin = '' } = {}) {
  const bucket = requireBucket(env);
  const requestedId = normalizeText(input.id, 120);
  const id = requestedId || createAdId();
  const key = adObjectKey(id);

  const existing = await bucket.head(key);
  if (!existing) {
    const page = await bucket.list({ prefix: AD_OBJECT_KEY_PREFIX, limit: ADS_MAX_COUNT + 1 });
    if ((page.objects || []).length >= ADS_MAX_COUNT) {
      throw new Error('ads limit reached');
    }
  }

  const now = formatNoticeTime();
  const metadata = {
    link_url: normalizeLinkUrl(input.linkUrl ?? input.link_url),
    image_key: normalizeImageKey(input.imageKey ?? input.image_key),
    enabled: input.enabled !== false && input.enabled !== 'false' && input.enabled !== '0' ? '1' : '0',
    sort_order: String(normalizeSortOrder(input.sortOrder ?? input.sort_order)),
    created_at: normalizeText(existing?.customMetadata?.created_at, 40) || now,
    updated_at: now,
  };

  await bucket.put(key, '', { customMetadata: metadata });
  return normalizeAdRow({ key, customMetadata: metadata }, origin);
}

export async function deleteAd(env, id) {
  const adId = normalizeText(id, 120);
  if (!adId) {
    return null;
  }

  const bucket = requireBucket(env);
  const key = adObjectKey(adId);
  const existing = await bucket.head(key);
  if (!existing) {
    return null;
  }

  await bucket.delete(key);
  return normalizeAdRow(existing);
}

function normalizeSortOrder(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(-999999, Math.min(999999, Math.trunc(number)));
}
