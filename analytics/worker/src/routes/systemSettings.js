import {
  RESOURCE_ALLOWED_IMAGE_TYPES,
  RESOURCE_IMAGE_MAX_BYTES,
  SYSTEM_GROUP_CHAT_QR_KEY,
} from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { buildResourceImageUrl } from '../services/resourceStore.js';

const allowedImageTypes = new Set(RESOURCE_ALLOWED_IMAGE_TYPES);

// 返回客户端当前可用的系统设置；未上传二维码时保持空地址。
export async function handlePublicSystemSettings(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed();

  try {
    return json({ code: 0, settings: await readSystemSettings(env, url.origin) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[analytics] public system settings failed', error?.message || String(error));
    return json({ code: 0, settings: { groupChatQrUrl: '' } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

// 管理端上传当前加群二维码，固定覆盖同一个 R2 对象。
export async function handleAdminSystemSettings(request, env, url) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.RESOURCE_BUCKET) {
    return json({ code: 500, message: 'RESOURCE_BUCKET is not configured' }, { status: 500 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ code: 400, message: 'invalid form data' }, { status: 400 });
  }

  const image = formData.get('image');
  if (!image || typeof image.arrayBuffer !== 'function' || Number(image.size || 0) <= 0) {
    return json({ code: 400, message: 'missing image' }, { status: 400 });
  }

  const type = String(image.type || '').toLowerCase();
  if (Number(image.size || 0) > RESOURCE_IMAGE_MAX_BYTES) {
    return json({ code: 400, message: 'image too large' }, { status: 400 });
  }
  if (!allowedImageTypes.has(type)) {
    return json({ code: 400, message: 'unsupported image type' }, { status: 400 });
  }

  try {
    await env.RESOURCE_BUCKET.put(SYSTEM_GROUP_CHAT_QR_KEY, await image.arrayBuffer(), {
      httpMetadata: { contentType: type },
    });
    return json({ code: 0, settings: await readSystemSettings(env, url.origin) });
  } catch (error) {
    console.error('[analytics] save system settings failed', error?.message || String(error));
    return json({ code: 500, message: 'system settings save failed' }, { status: 500 });
  }
}

async function readSystemSettings(env, origin) {
  if (!env.RESOURCE_BUCKET) return { groupChatQrUrl: '' };

  const object = await env.RESOURCE_BUCKET.head(SYSTEM_GROUP_CHAT_QR_KEY);
  if (!object) return { groupChatQrUrl: '' };

  const version = object.httpEtag || object.etag || object.uploaded?.getTime?.() || Date.now();
  const imageUrl = buildResourceImageUrl(origin, SYSTEM_GROUP_CHAT_QR_KEY);
  return { groupChatQrUrl: `${imageUrl}&v=${encodeURIComponent(version)}` };
}
