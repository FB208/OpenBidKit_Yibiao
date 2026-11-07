import {
  RESOURCE_ALLOWED_IMAGE_TYPES,
  RESOURCE_IMAGE_MAX_BYTES,
} from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  createAdId,
  deleteAd,
  listAdminAds,
  listPublicAds,
  normalizeLinkUrl,
  readAd,
  upsertAd,
} from '../services/adStore.js';
import { createResourceImageKey, normalizeImageKey } from '../services/resourceStore.js';
import { normalizeText } from '../utils.js';

const allowedImageTypes = new Set(RESOURCE_ALLOWED_IMAGE_TYPES);

export async function handlePublicAds(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  try {
    const ads = await listPublicAds(env, { origin: url.origin });
    return json({ code: 0, ads: ads.map((ad) => ({ id: ad.id, linkUrl: ad.linkUrl, imageUrl: ad.imageUrl })) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[analytics] public ads failed', error?.message || String(error));
    return json({ code: 0, ads: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function handleAdminAds(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (request.method === 'GET') {
    return handleAdminGetAds(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveAd(request, env, url);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteAd(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetAds(env, url) {
  try {
    const ads = await listAdminAds(env, { origin: url.origin });
    return json({ code: 0, ads }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] admin list ads failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'ads query failed' }, { status: 500 });
  }
}

async function handleAdminSaveAd(request, env, url) {
  if (!env.RESOURCE_BUCKET) {
    return json({ code: 500, message: 'RESOURCE_BUCKET is not configured' }, { status: 500 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ code: 400, message: 'invalid form data' }, { status: 400 });
  }

  const id = normalizeText(formData.get('id'), 120);
  const existing = id ? await readAd(env, id, { origin: url.origin }) : null;
  const imageFile = getUploadFile(formData.get('image'));
  const targetId = existing?.id || id || createAdId();
  const oldImageKey = existing?.imageKey || '';
  const linkUrl = normalizeLinkUrl(formData.get('linkUrl'));

  if (!linkUrl) {
    return json({ code: 400, message: 'missing or invalid linkUrl' }, { status: 400 });
  }

  let imageKey = oldImageKey;
  try {
    if (imageFile) {
      imageKey = await uploadAdImage(env, targetId, imageFile);
    }

    if (!imageKey) {
      return json({ code: 400, message: 'missing image' }, { status: 400 });
    }

    const ad = await upsertAd(env, {
      id: targetId,
      linkUrl,
      imageKey,
      enabled: formData.get('enabled'),
      sortOrder: formData.get('sortOrder'),
    }, { origin: url.origin });

    // 配置已提交成功：旧图清理失败只记日志，不能进外层 catch 误删已生效的新图。
    if (imageFile && oldImageKey && oldImageKey !== imageKey) {
      try {
        await deleteStoredImage(env, oldImageKey);
      } catch (cleanupError) {
        console.error('[analytics] delete old ad image failed', cleanupError?.message || String(cleanupError));
      }
    }

    return json({ code: 0, ad });
  } catch (error) {
    // 上传了新图但保存配置失败时清掉刚传的图，避免孤儿对象。
    if (imageFile && imageKey && imageKey !== oldImageKey) {
      await deleteStoredImage(env, imageKey);
    }
    console.error('[analytics] save ad failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'ad save failed' }, { status: 500 });
  }
}

async function handleAdminDeleteAd(env, url) {
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!id) {
    return json({ code: 400, message: 'missing id' }, { status: 400 });
  }

  try {
    const deleted = await deleteAd(env, id);
    try {
      await deleteStoredImage(env, deleted?.imageKey || '');
    } catch (cleanupError) {
      console.error('[analytics] delete ad image failed', cleanupError?.message || String(cleanupError));
    }
    return json({ code: 0, ad: null });
  } catch (error) {
    console.error('[analytics] delete ad failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'ad delete failed' }, { status: 500 });
  }
}

function getUploadFile(value) {
  if (!value || typeof value !== 'object' || typeof value.arrayBuffer !== 'function') {
    return null;
  }

  const size = Number(value.size || 0);
  return size > 0 ? value : null;
}

async function uploadAdImage(env, adId, file) {
  const size = Number(file.size || 0);
  const type = String(file.type || '').toLowerCase();
  if (size > RESOURCE_IMAGE_MAX_BYTES) {
    throw new Error('image too large');
  }
  if (!allowedImageTypes.has(type)) {
    throw new Error('unsupported image type');
  }

  const key = createResourceImageKey(adId, file.name, type);
  const body = await file.arrayBuffer();
  await env.RESOURCE_BUCKET.put(key, body, {
    httpMetadata: { contentType: type },
  });
  return key;
}

async function deleteStoredImage(env, imageKey) {
  const key = normalizeImageKey(imageKey);
  if (!key || !env.RESOURCE_BUCKET) {
    return;
  }

  await env.RESOURCE_BUCKET.delete(key);
}
