import { formatNoticeTime, normalizeText } from '../utils.js';

const DEPENDENCY_ID_MAX_LENGTH = 80;
const DEPENDENCY_NAME_MAX_LENGTH = 120;
const DEPENDENCY_DESCRIPTION_MAX_LENGTH = 500;
const DEPENDENCY_VERSION_MAX_LENGTH = 40;
const DEPENDENCY_URL_MAX_LENGTH = 500;
const DEPENDENCY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 安装包适用平台：all 表示各平台通用，其余与客户端的 `${process.platform}-${process.arch}` 一致。 */
export const DEPENDENCY_PLATFORMS = ['all', 'win32-x64', 'darwin-x64', 'darwin-arm64'];

/** 创建可被接口映射为指定状态码的依赖错误 */
function createDependencyError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireDependencyDb(env) {
  if (!env.RESOURCE_DB) {
    throw createDependencyError('RESOURCE_DB is not configured', 500);
  }
  return env.RESOURCE_DB;
}

function normalizeCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function normalizePlatform(value) {
  const platform = normalizeText(value, 40) || 'all';
  return DEPENDENCY_PLATFORMS.includes(platform) ? platform : '';
}

export function normalizeDependencyRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id, DEPENDENCY_ID_MAX_LENGTH),
    platform: normalizeText(row.platform, 40) || 'all',
    name: normalizeText(row.name, DEPENDENCY_NAME_MAX_LENGTH),
    description: normalizeText(row.description, DEPENDENCY_DESCRIPTION_MAX_LENGTH),
    version: normalizeText(row.version, DEPENDENCY_VERSION_MAX_LENGTH),
    downloadUrl: normalizeText(row.download_url, DEPENDENCY_URL_MAX_LENGTH),
    size: normalizeCount(row.size),
    downloadCount: normalizeCount(row.download_count),
    enabled: Number(row.enabled) !== 0,
    createdAt: normalizeText(row.created_at, 40),
    updatedAt: normalizeText(row.updated_at, 40),
  };
}

/** 客户端可见的依赖：只返回已启用的安装包。 */
export async function listPublicDependencies(env) {
  if (!env.RESOURCE_DB) {
    return [];
  }

  const result = await env.RESOURCE_DB.prepare(
    'SELECT * FROM dependencies WHERE enabled = 1 ORDER BY id ASC, platform ASC',
  ).all();
  return (result.results || []).map((row) => normalizeDependencyRow(row)).filter(Boolean);
}

export async function listAdminDependencies(env) {
  if (!env.RESOURCE_DB) {
    return [];
  }

  const result = await env.RESOURCE_DB.prepare(
    'SELECT * FROM dependencies ORDER BY id ASC, platform ASC',
  ).all();
  return (result.results || []).map((row) => normalizeDependencyRow(row)).filter(Boolean);
}

/** 读取安装包大小；链接打不开或拿不到大小时拒绝保存，避免客户端下载到一半才发现链接无效。 */
async function resolveDownloadSize(downloadUrl) {
  let response;
  try {
    response = await fetch(downloadUrl, { method: 'HEAD' });
  } catch (error) {
    throw createDependencyError(`下载链接无法访问：${error?.message || String(error)}`);
  }
  if (!response.ok) {
    throw createDependencyError(`下载链接无法访问：HTTP ${response.status}`);
  }

  let size = normalizeCount(response.headers.get('content-length'));
  if (!size) {
    // HEAD 响应不带长度时，只取第一个字节，从 Content-Range 读出总大小。
    const rangeResponse = await fetch(downloadUrl, { headers: { Range: 'bytes=0-0' } });
    await rangeResponse.body?.cancel().catch(() => undefined);
    size = normalizeCount(String(rangeResponse.headers.get('content-range') || '').split('/')[1]);
  }
  if (!size) {
    throw createDependencyError('下载链接没有返回文件大小，请确认链接指向安装包文件');
  }
  return size;
}

/** 新增或更新一份安装包；同一依赖 ID 和平台只保留一条，下载量和创建时间在更新时保留。 */
export async function upsertDependency(env, input) {
  const db = requireDependencyDb(env);
  const id = normalizeText(input.id, DEPENDENCY_ID_MAX_LENGTH);
  const platform = normalizePlatform(input.platform);
  const name = normalizeText(input.name, DEPENDENCY_NAME_MAX_LENGTH);
  const description = normalizeText(input.description, DEPENDENCY_DESCRIPTION_MAX_LENGTH);
  const version = normalizeText(input.version, DEPENDENCY_VERSION_MAX_LENGTH);
  const downloadUrl = normalizeText(input.downloadUrl ?? input.download_url, DEPENDENCY_URL_MAX_LENGTH);
  const enabled = input.enabled !== false && input.enabled !== 'false' && input.enabled !== '0';

  if (!id || !DEPENDENCY_ID_PATTERN.test(id)) {
    throw createDependencyError('依赖 ID 只能包含字母、数字、点、下划线和连字符');
  }
  if (!platform) {
    throw createDependencyError(`适用平台只能是：${DEPENDENCY_PLATFORMS.join('、')}`);
  }
  if (!name) {
    throw createDependencyError('请填写名称');
  }
  if (!version) {
    throw createDependencyError('请填写版本');
  }
  if (!/^https:\/\//i.test(downloadUrl)) {
    throw createDependencyError('请填写 https 开头的下载链接');
  }

  const size = await resolveDownloadSize(downloadUrl);
  const now = formatNoticeTime();
  const row = await db.prepare(
    `INSERT INTO dependencies (id, platform, name, description, version, download_url, size, enabled, download_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id, platform) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       download_url = excluded.download_url,
       size = excluded.size,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).bind(id, platform, name, description, version, downloadUrl, size, enabled ? 1 : 0, now, now).first();

  return normalizeDependencyRow(row);
}

export async function deleteDependency(env, id, platform) {
  const db = requireDependencyDb(env);
  const row = await db.prepare(
    'DELETE FROM dependencies WHERE id = ? AND platform = ? RETURNING *',
  ).bind(normalizeText(id, DEPENDENCY_ID_MAX_LENGTH), normalizeText(platform, 40) || 'all').first();
  return normalizeDependencyRow(row);
}

/** 原子累计一次已启用安装包的下载量 */
export async function incrementDependencyDownload(env, id, platform) {
  const db = requireDependencyDb(env);
  const change = await db.prepare(
    `UPDATE dependencies
     SET download_count = COALESCE(download_count, 0) + 1
     WHERE id = ? AND platform = ? AND enabled = 1
     RETURNING download_count AS downloadCount`,
  ).bind(normalizeText(id, DEPENDENCY_ID_MAX_LENGTH), normalizeText(platform, 40) || 'all').first();
  return change ? { downloadCount: normalizeCount(change.downloadCount) } : null;
}
