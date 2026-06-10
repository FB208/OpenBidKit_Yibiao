import {
  DATASET,
  RESOURCE_ALLOWED_IMAGE_TYPES,
  RESOURCE_DESCRIPTION_MAX_LENGTH,
  RESOURCE_IMAGE_MAX_BYTES,
  RESOURCE_MODAL_CONTENT_MAX_LENGTH,
  RESOURCE_TAGS_MAX_LENGTH,
  RESOURCE_TITLE_MAX_LENGTH,
} from '../constants.js';
import { corsHeaders, json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import {
  buildResourceImageUrl,
  createResourceId,
  createResourceImageKey,
  deleteResource,
  listAdminResources,
  listPublicResources,
  normalizeImageKey,
  readResource,
  upsertResource,
} from '../services/resourceStore.js';
import { isValidProjectName, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

const allowedImageTypes = new Set(RESOURCE_ALLOWED_IMAGE_TYPES);

export async function handlePublicResources(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  try {
    const resources = await listPublicResources(env, {
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      origin: url.origin,
    });
    const resourcesWithStats = await attachResourceClickStats(env, resources, url);
    return json({ code: 0, resources: resourcesWithStats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public resources failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'resources query failed' }, { status: 500 });
  }
}

export async function handleResourceImage(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!env.RESOURCE_BUCKET) {
    return json({ code: 500, message: 'RESOURCE_BUCKET is not configured' }, { status: 500 });
  }

  const key = normalizeImageKey(url.searchParams.get('key'));
  if (!key) {
    return json({ code: 400, message: 'invalid image key' }, { status: 400 });
  }

  const object = await env.RESOURCE_BUCKET.get(key);
  if (!object) {
    return json({ code: 404, message: 'image not found' }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
    },
  });
}

export async function handleAdminResources(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'RESOURCE_DB is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetResources(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveResource(request, env, url);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteResource(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetResources(env, url) {
  const resources = await listAdminResources(env, { origin: url.origin });
  const resourcesWithStats = await attachResourceClickStats(env, resources, url);
  return json({ code: 0, resources: resourcesWithStats }, { headers: { 'Cache-Control': 'no-store' } });
}

async function attachResourceClickStats(env, resources, url) {
  const clickCounts = await queryResourceClickCounts(env, resources, url);
  return resources.map((resource) => ({
    ...resource,
    clickCount: clickCounts.get(resource.analyticsKey) || 0,
  }));
}

async function queryResourceClickCounts(env, resources, url) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN || !resources.length) {
    return new Map();
  }

  const projectName = normalizeText(url.searchParams.get('projectName') || 'yibiao-client', 80);
  if (!isValidProjectName(projectName)) {
    return new Map();
  }

  const days = safeDays(url.searchParams.get('days'));
  const resourceKeys = Array.from(new Set(
    resources.map((resource) => normalizeText(resource.analyticsKey, 80)).filter(Boolean),
  ));

  if (!resourceKeys.length) {
    return new Map();
  }

  const sql = `
    SELECT
      blob9 AS resourceKey,
      SUM(_sample_interval) AS clickCount
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
      AND blob2 = 'resource_click'
      AND blob9 IN (${resourceKeys.map((key) => sqlString(key)).join(', ')})
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY resourceKey
  `;

  try {
    const result = await queryAnalytics(env, sql);
    return new Map((result.data || []).map((row) => [row.resourceKey, Number(row.clickCount || 0)]));
  } catch (error) {
    logQueryError('resource clicks', error);
    return new Map();
  }
}

async function handleAdminSaveResource(request, env, url) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ code: 400, message: 'invalid form data' }, { status: 400 });
  }

  const id = normalizeText(formData.get('id'), 120);
  const existing = id ? await readResource(env, id, { origin: url.origin }) : null;
  const removeImage = String(formData.get('removeImage') || '') === 'true';
  const imageFile = getUploadFile(formData.get('image'));
  const targetId = id || createResourceId();
  const oldImageKey = existing?.imageKey || '';
  let imageKey = oldImageKey;

  if (imageFile && !env.RESOURCE_BUCKET) {
    return json({ code: 500, message: 'RESOURCE_BUCKET is not configured' }, { status: 500 });
  }

  const body = {
    id: targetId,
    title: formData.get('title'),
    tags: formData.get('tags'),
    description: formData.get('description'),
    modalContent: formData.get('modalContent'),
    enabled: formData.get('enabled') !== 'false',
    sortOrder: formData.get('sortOrder'),
    imageKey,
  };

  if (!normalizeText(body.title, RESOURCE_TITLE_MAX_LENGTH)) {
    return json({ code: 400, message: 'missing title' }, { status: 400 });
  }

  if (String(body.tags || '').length > RESOURCE_TAGS_MAX_LENGTH) {
    return json({ code: 400, message: 'tags too long' }, { status: 400 });
  }

  if (String(body.description || '').length > RESOURCE_DESCRIPTION_MAX_LENGTH) {
    return json({ code: 400, message: 'description too long' }, { status: 400 });
  }

  if (String(body.modalContent || '').length > RESOURCE_MODAL_CONTENT_MAX_LENGTH) {
    return json({ code: 400, message: 'modal content too long' }, { status: 400 });
  }

  try {
    if (imageFile) {
      imageKey = await uploadResourceImage(env, targetId, imageFile);
    } else if (removeImage) {
      imageKey = '';
    }

    const resource = await upsertResource(env, { ...body, imageKey }, { origin: url.origin });
    if ((removeImage || imageFile) && oldImageKey && oldImageKey !== imageKey) {
      await deleteStoredImage(env, oldImageKey);
    }

    return json({ code: 0, resource });
  } catch (error) {
    console.error('[analytics] save resource failed', error?.message || String(error));
    return json({ code: 500, message: error?.message || 'resource save failed' }, { status: 500 });
  }
}

async function handleAdminDeleteResource(env, url) {
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!id) {
    return json({ code: 400, message: 'missing id' }, { status: 400 });
  }

  const deleted = await deleteResource(env, id);
  await deleteStoredImage(env, deleted?.imageKey || '');
  return json({ code: 0, resource: null });
}

function getUploadFile(value) {
  if (!value || typeof value !== 'object' || typeof value.arrayBuffer !== 'function') {
    return null;
  }

  const size = Number(value.size || 0);
  return size > 0 ? value : null;
}

async function uploadResourceImage(env, resourceId, file) {
  const size = Number(file.size || 0);
  const type = String(file.type || '').toLowerCase();
  if (size > RESOURCE_IMAGE_MAX_BYTES) {
    throw new Error('image too large');
  }
  if (!allowedImageTypes.has(type)) {
    throw new Error('unsupported image type');
  }

  const key = createResourceImageKey(resourceId, file.name, type);
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

export function buildPreviewImageUrl(origin, imageKey) {
  return buildResourceImageUrl(origin, imageKey);
}
