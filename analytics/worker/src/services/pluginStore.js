import { formatNoticeTime, normalizeText } from '../utils.js';

const PLUGIN_ID_MAX_LENGTH = 80;
const PLUGIN_NAME_MAX_LENGTH = 120;
const PLUGIN_DESCRIPTION_MAX_LENGTH = 500;
const PLUGIN_VERSION_MAX_LENGTH = 40;
const PLUGIN_AUTHOR_MAX_LENGTH = 120;
const PLUGIN_REPOSITORY_MAX_LENGTH = 300;
const PLUGIN_RELEASE_URL_MAX_LENGTH = 500;
const PLUGIN_TAGS_MAX_LENGTH = 200;
const GITHUB_API_VERSION = '2022-11-28';
const SEMVER_TAG_PATTERN = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
const GITHUB_REQUEST_MAX_ATTEMPTS = 3;
const RELEASE_RESOLVE_MAX_ATTEMPTS = 4;
const GITHUB_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const PLUGIN_PACKAGE_KEY_PREFIX = 'plugins/';
const PLUGIN_PACKAGE_STAGING_KEY_PREFIX = `${PLUGIN_PACKAGE_KEY_PREFIX}.staging/`;
const PLUGIN_PACKAGE_PUBLIC_BASE_URL = 'https://openbidkit-oss.agnet.top';
const PLUGIN_PACKAGE_PUBLICATION_TTL_MS = 30 * 60 * 1000;
const PLUGIN_PACKAGE_OPERATION_LOCK_NAME = 'plugin-packages';
const PLUGIN_PACKAGE_OPERATION_LOCK_TTL_MS = 30 * 60 * 1000;

/** 创建可被接口映射为指定状态码的插件错误 */
function createPluginError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function splitPluginTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[，,;；\n\r]+/);
  const tags = source
    .map((item) => normalizeText(item, 40))
    .filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 10);
}

export function normalizeTagsText(value) {
  return normalizeText(splitPluginTags(value).join(', '), PLUGIN_TAGS_MAX_LENGTH);
}

/** 校验并规范化 GitHub 仓库地址 */
export function normalizeGitHubRepository(value) {
  const repository = normalizeText(value, PLUGIN_REPOSITORY_MAX_LENGTH);
  let url;

  try {
    url = new URL(repository);
  } catch {
    throw createPluginError('GitHub 仓库地址格式不正确');
  }

  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(hostname) || parts.length !== 2 || url.search || url.hash) {
    throw createPluginError('请填写 https://github.com/所有者/仓库 格式的公开仓库地址');
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const validPart = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repo || !validPart.test(owner) || !validPart.test(repo)) {
    throw createPluginError('GitHub 仓库地址格式不正确');
  }

  return {
    owner,
    repo,
    repository: `https://github.com/${owner}/${repo}`,
  };
}

export function buildPluginIconUrl(repository) {
  try {
    const parsed = normalizeGitHubRepository(repository);
    return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/assets/icon.png`;
  } catch {
    return '';
  }
}

/** 构建 GitHub API 请求头，复用后端已有的可选 Token */
function buildGitHubHeaders(env) {
  const token = String(env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || '').trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenBidKit-Yibiao-Plugin-Market',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 生成插件最新版安装包在 R2 中的版本化对象键。 */
export function createPluginPackageKey(id, version) {
  const pluginId = normalizeText(id, PLUGIN_ID_MAX_LENGTH);
  const pluginVersion = normalizeText(version, PLUGIN_VERSION_MAX_LENGTH);
  return `${PLUGIN_PACKAGE_KEY_PREFIX}${pluginId}/${pluginId}-v${pluginVersion}.zip`;
}

/** 生成客户端直接使用的 Cloudflare R2 公网下载地址。 */
export function buildPluginPackageUrl(id, version) {
  const key = createPluginPackageKey(id, version);
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${PLUGIN_PACKAGE_PUBLIC_BASE_URL}/${encodedKey}`;
}

/** 生成发布期间使用的临时对象键。 */
function createPluginPackageStagingKey(id, version) {
  const nonce = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${PLUGIN_PACKAGE_STAGING_KEY_PREFIX}${id}/${version}-${nonce}.zip`;
}

/** 创建一次插件包发布操作的跨请求唯一标识。 */
function createPluginPackagePublicationId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 在写入 R2 前登记本次发布涉及的全部对象键。 */
async function beginPluginPackagePublication(env, pluginId, objectKeys) {
  if (!env.RESOURCE_DB) {
    throw createPluginError('RESOURCE_DB is not configured', 500);
  }

  const publicationId = createPluginPackagePublicationId();
  const now = Date.now();
  const expiresAt = now + PLUGIN_PACKAGE_PUBLICATION_TTL_MS;
  const placeholders = objectKeys.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const values = objectKeys.flatMap((objectKey) => [publicationId, pluginId, objectKey, now, expiresAt]);
  await env.RESOURCE_DB.prepare(`
    INSERT INTO plugin_package_publications (
      publication_id, plugin_id, object_key, created_at, expires_at
    ) VALUES ${placeholders}
  `).bind(...values).run();
  return publicationId;
}

/** 仅释放指定发布操作登记的对象保护。 */
async function finishPluginPackagePublication(env, publicationId) {
  if (!publicationId || !env.RESOURCE_DB) return;
  await env.RESOURCE_DB.prepare(
    'DELETE FROM plugin_package_publications WHERE publication_id = ?',
  ).bind(publicationId).run();
}

/** 判断对象键是否仍被任意有效发布操作保护。 */
async function isPluginPackagePublicationActive(env, objectKey) {
  const row = await env.RESOURCE_DB.prepare(`
    SELECT publication_id
    FROM plugin_package_publications
    WHERE object_key = ? AND expires_at > ?
    LIMIT 1
  `).bind(objectKey, Date.now()).first();
  return Boolean(row);
}

/** 清除已过期的发布标记，遗留 R2 对象由随后清理流程处理。 */
async function cleanupExpiredPluginPackagePublications(env) {
  await env.RESOURCE_DB.prepare(
    'DELETE FROM plugin_package_publications WHERE expires_at <= ?',
  ).bind(Date.now()).run();
}

/** 获取跨 Worker 的插件包操作租约锁。 */
async function acquirePluginPackageOperationLock(env) {
  if (!env.RESOURCE_DB) {
    throw createPluginError('RESOURCE_DB is not configured', 500);
  }

  const ownerId = createPluginPackagePublicationId();
  const now = Date.now();
  const row = await env.RESOURCE_DB.prepare(`
    INSERT INTO plugin_package_operation_locks (lock_name, owner_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_id = excluded.owner_id,
      expires_at = excluded.expires_at
    WHERE plugin_package_operation_locks.expires_at <= ?
    RETURNING owner_id
  `).bind(
    PLUGIN_PACKAGE_OPERATION_LOCK_NAME,
    ownerId,
    now + PLUGIN_PACKAGE_OPERATION_LOCK_TTL_MS,
    now,
  ).first();

  if (row?.owner_id !== ownerId) {
    throw createPluginError('其他插件发布或清理任务正在执行，请稍后重试', 409);
  }
  return ownerId;
}

/** 仅由租约持有者释放插件包操作锁。 */
async function releasePluginPackageOperationLock(env, ownerId) {
  if (!ownerId || !env.RESOURCE_DB) return;
  await env.RESOURCE_DB.prepare(`
    DELETE FROM plugin_package_operation_locks
    WHERE lock_name = ? AND owner_id = ?
  `).bind(PLUGIN_PACKAGE_OPERATION_LOCK_NAME, ownerId).run();
}

/** 在全局租约锁内执行插件包发布、删除或清理。 */
async function withPluginPackageOperationLock(env, operation) {
  const ownerId = await acquirePluginPackageOperationLock(env);
  try {
    return await operation();
  } finally {
    await releasePluginPackageOperationLock(env, ownerId).catch(() => undefined);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 请求 GitHub JSON 接口并转换为管理端可读错误 */
async function fetchGitHubJson(env, url, resourceName) {
  let lastError = null;

  for (let attempt = 1; attempt <= GITHUB_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: buildGitHubHeaders(env),
        cache: 'no-store',
      });
    } catch (error) {
      lastError = createPluginError(`无法连接 GitHub 读取${resourceName}：${error?.message || String(error)}`, 502);
      if (attempt < GITHUB_REQUEST_MAX_ATTEMPTS) {
        await sleep(500 * attempt);
        continue;
      }
      throw lastError;
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // 非 JSON 响应统一由下面的状态处理。
    }

    if (response.ok) {
      return data;
    }

    const detail = normalizeText(data?.message, 160);
    lastError = createPluginError(`无法读取 GitHub ${resourceName}（${response.status}）${detail ? `：${detail}` : ''}`, 502);
    const retryable = GITHUB_RETRYABLE_STATUSES.has(response.status)
      || (resourceName === 'manifest.json' && response.status === 404);
    if (!retryable || attempt >= GITHUB_REQUEST_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(500 * attempt);
  }

  throw lastError || createPluginError(`无法读取 GitHub ${resourceName}`, 502);
}

/** 从 GitHub Release 下载公开插件包，二进制响应将直接流式写入 R2。 */
async function fetchGitHubPluginPackage(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= GITHUB_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'OpenBidKit-Yibiao-Plugin-Market' },
        redirect: 'follow',
        cache: 'no-store',
      });
    } catch (error) {
      lastError = createPluginError(`无法下载 GitHub 插件安装包：${error?.message || String(error)}`, 502);
      if (attempt < GITHUB_REQUEST_MAX_ATTEMPTS) {
        await sleep(500 * attempt);
        continue;
      }
      throw lastError;
    }

    if (response.ok && response.body) {
      return response;
    }

    lastError = createPluginError(`无法下载 GitHub 插件安装包（${response.status}）`, 502);
    if (!GITHUB_RETRYABLE_STATUSES.has(response.status) || attempt >= GITHUB_REQUEST_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(500 * attempt);
  }

  throw lastError || createPluginError('无法下载 GitHub 插件安装包', 502);
}

/** 从指定 Git Tag 读取仓库根目录 manifest.json */
async function readReleaseManifest(env, repository, tagName) {
  const path = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/manifest.json?ref=${encodeURIComponent(tagName)}`;
  const file = await fetchGitHubJson(env, path, 'manifest.json');

  if (file?.type !== 'file' || file?.encoding !== 'base64' || !file?.content) {
    throw createPluginError('仓库根目录缺少可读取的 manifest.json');
  }

  try {
    const binary = atob(String(file.content).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw createPluginError('manifest.json 不是有效的 UTF-8 JSON 文件');
  }
}

/** 单次解析仓库最新正式 Release 中的完整插件信息 */
async function resolveGitHubPluginOnce(env, repositoryUrl) {
  const repository = normalizeGitHubRepository(repositoryUrl);
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const release = await fetchGitHubJson(env, `${apiBase}/releases/latest`, '最新正式 Release');
  const tagName = normalizeText(release?.tag_name, PLUGIN_VERSION_MAX_LENGTH + 1);
  const tagMatch = tagName.match(SEMVER_TAG_PATTERN);

  if (!tagMatch) {
    throw createPluginError('最新正式 Release 的 Tag 必须使用 vX.Y.Z 格式');
  }

  const version = tagMatch[1];
  const manifest = await readReleaseManifest(env, repository, tagName);
  const id = normalizeText(manifest?.id, PLUGIN_ID_MAX_LENGTH);
  const name = normalizeText(manifest?.name, PLUGIN_NAME_MAX_LENGTH);

  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
    throw createPluginError('manifest.json 中的插件 ID 缺失或格式不正确');
  }
  if (!name) {
    throw createPluginError('manifest.json 中缺少插件名称');
  }

  if (manifest?.repository) {
    const manifestRepository = normalizeGitHubRepository(manifest.repository);
    if (manifestRepository.repository.toLowerCase() !== repository.repository.toLowerCase()) {
      throw createPluginError('manifest.json 中的仓库地址与上架仓库不一致');
    }
  }

  const expectedAssetName = `${id}-v${version}.zip`;
  const asset = Array.isArray(release?.assets)
    ? release.assets.find((item) => item?.name === expectedAssetName && item?.state === 'uploaded')
    : null;

  if (!asset?.browser_download_url) {
    const error = createPluginError(`最新 Release 缺少安装包：${expectedAssetName}`, 502);
    error.releaseNotReady = true;
    throw error;
  }

  const authorValue = typeof manifest?.author === 'string' ? manifest.author : manifest?.author?.name;
  return {
    id,
    name,
    description: normalizeText(manifest?.description, PLUGIN_DESCRIPTION_MAX_LENGTH),
    version,
    author: normalizeText(authorValue, PLUGIN_AUTHOR_MAX_LENGTH),
    repository: repository.repository,
    releaseUrl: normalizeText(asset.browser_download_url, PLUGIN_RELEASE_URL_MAX_LENGTH),
    releaseSize: Number(asset.size || 0),
    tags: normalizeTagsText(manifest?.tags),
  };
}

/** 判断 R2 对象是否为完整的目标安装包。 */
function isCompletePluginPackage(object, expectedSize) {
  return Boolean(object && object.size > 0 && (!expectedSize || object.size === expectedSize));
}

/** 将 GitHub Release 安装包经临时对象校验后发布到正式版本键。 */
async function mirrorPluginPackage(env, resolved, existing) {
  if (!env.RESOURCE_BUCKET) {
    throw createPluginError('RESOURCE_BUCKET is not configured', 500);
  }

  const key = createPluginPackageKey(resolved.id, resolved.version);
  const releaseUrl = buildPluginPackageUrl(resolved.id, resolved.version);
  const expectedSize = Number(resolved.releaseSize || 0);
  const isCurrentPublishedObject = existing?.version === resolved.version
    && existing?.releaseUrl === releaseUrl;
  const isPreviousPublishedObject = existing?.previousVersion === resolved.version
    && existing?.previousReleaseUrl === releaseUrl;
  const currentObject = await env.RESOURCE_BUCKET.head(key);

  if (isCompletePluginPackage(currentObject, expectedSize)) {
    return { ...resolved, releaseUrl, packageKey: key, reused: true };
  }
  if ((isCurrentPublishedObject || isPreviousPublishedObject) && currentObject) {
    throw createPluginError('GitHub 安装包与已发布 R2 对象大小不一致，已保留线上对象', 409);
  }

  const stagingKey = createPluginPackageStagingKey(resolved.id, resolved.version);
  const publicationId = await beginPluginPackagePublication(env, resolved.id, [stagingKey, key]);
  let packageReady = false;
  try {
    const response = await fetchGitHubPluginPackage(resolved.releaseUrl);
    await env.RESOURCE_BUCKET.put(stagingKey, response.body, {
      httpMetadata: {
        contentType: 'application/zip',
        cacheControl: 'no-store',
      },
      customMetadata: {
        pluginId: resolved.id,
        version: resolved.version,
        source: 'github-release',
        state: 'staging',
      },
    });

    const stagingObject = await env.RESOURCE_BUCKET.head(stagingKey);
    if (!isCompletePluginPackage(stagingObject, expectedSize)) {
      throw createPluginError('插件安装包写入 R2 临时对象后大小校验失败', 502);
    }

    const stagedPackage = await env.RESOURCE_BUCKET.get(stagingKey);
    if (!stagedPackage?.body) {
      throw createPluginError('无法读取已校验的 R2 临时安装包', 502);
    }

    await env.RESOURCE_BUCKET.put(key, stagedPackage.body, {
      httpMetadata: {
        contentType: 'application/zip',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        pluginId: resolved.id,
        version: resolved.version,
        source: 'github-release',
        state: 'published',
      },
    });

    const publishedObject = await env.RESOURCE_BUCKET.head(key);
    if (!isCompletePluginPackage(publishedObject, expectedSize)) {
      await env.RESOURCE_BUCKET.delete(key);
      throw createPluginError('插件安装包写入 R2 正式对象后大小校验失败', 502);
    }
    packageReady = true;
  } catch (error) {
    if (Number(error?.statusCode)) throw error;
    throw createPluginError(`插件安装包写入 R2 失败：${error?.message || String(error)}`, 502);
  } finally {
    await env.RESOURCE_BUCKET.delete(stagingKey).catch(() => undefined);
    if (!packageReady) {
      await finishPluginPackagePublication(env, publicationId).catch(() => undefined);
    }
  }

  return {
    ...resolved,
    releaseUrl,
    packageKey: key,
    publicationId,
    reused: false,
  };
}

/** 删除指定插件在 R2 中除保留版本外的全部正式安装包。 */
async function cleanupPluginPackages(env, pluginId, keepKeys = new Set()) {
  if (!env.RESOURCE_BUCKET) {
    throw createPluginError('RESOURCE_BUCKET is not configured', 500);
  }

  const prefix = `${PLUGIN_PACKAGE_KEY_PREFIX}${pluginId}/`;
  const keys = await listPluginPackageKeys(env, prefix);
  const staleKeys = keys.filter((key) => !keepKeys.has(key));
  let deletedCount = 0;
  for (const key of staleKeys) {
    if (await isPluginPackagePublicationActive(env, key)) continue;
    await env.RESOURCE_BUCKET.delete(key);
    deletedCount += 1;
  }
  return deletedCount;
}

/** 分页读取 R2 中指定前缀下的全部插件对象键。 */
async function listPluginPackageKeys(env, prefix = PLUGIN_PACKAGE_KEY_PREFIX) {
  const keys = [];
  let cursor;
  do {
    const result = await env.RESOURCE_BUCKET.list({ prefix, cursor });
    keys.push(...(result.objects || []).map((object) => object.key));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return keys;
}

/** 以数据库当前版和上一版为权威，清除历史版本、临时对象和孤立对象。 */
async function cleanupAllPluginPackagesLocked(env) {
  if (!env.RESOURCE_DB || !env.RESOURCE_BUCKET) {
    throw createPluginError('RESOURCE_DB or RESOURCE_BUCKET is not configured', 500);
  }

  await cleanupExpiredPluginPackagePublications(env);
  const rows = await env.RESOURCE_DB.prepare(`
    SELECT id, version, release_url, previous_version, previous_release_url
    FROM plugins
  `).all();
  const keepKeys = new Set();
  for (const row of rows.results || []) {
    if (normalizeText(row.release_url, PLUGIN_RELEASE_URL_MAX_LENGTH) === buildPluginPackageUrl(row.id, row.version)) {
      keepKeys.add(createPluginPackageKey(row.id, row.version));
    }
    const previousVersion = normalizeText(row.previous_version, PLUGIN_VERSION_MAX_LENGTH);
    if (previousVersion
      && normalizeText(row.previous_release_url, PLUGIN_RELEASE_URL_MAX_LENGTH) === buildPluginPackageUrl(row.id, previousVersion)) {
      keepKeys.add(createPluginPackageKey(row.id, previousVersion));
    }
  }
  const keys = await listPluginPackageKeys(env);
  const staleKeys = keys.filter((key) => !keepKeys.has(key));
  let deletedCount = 0;
  for (const key of staleKeys) {
    if (await isPluginPackagePublicationActive(env, key)) continue;
    await env.RESOURCE_BUCKET.delete(key);
    deletedCount += 1;
  }
  return deletedCount;
}

/** 在跨 Worker 租约锁内执行全局插件包清理。 */
async function cleanupAllPluginPackages(env) {
  return withPluginPackageOperationLock(env, () => cleanupAllPluginPackagesLocked(env));
}

/** 根据仓库最新正式 Release 解析客户端所需的完整插件信息 */
export async function resolveGitHubPlugin(env, repositoryUrl) {
  for (let attempt = 1; attempt <= RELEASE_RESOLVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await resolveGitHubPluginOnce(env, repositoryUrl);
    } catch (error) {
      if (!error?.releaseNotReady || attempt >= RELEASE_RESOLVE_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(750 * attempt);
    }
  }

  throw createPluginError('最新 Release 尚未准备完成', 502);
}

export function normalizePluginInput(input) {
  const repository = normalizeText(input.repository, PLUGIN_REPOSITORY_MAX_LENGTH);

  return {
    name: normalizeText(input.name, PLUGIN_NAME_MAX_LENGTH),
    description: normalizeText(input.description, PLUGIN_DESCRIPTION_MAX_LENGTH),
    version: normalizeText(input.version, PLUGIN_VERSION_MAX_LENGTH),
    author: normalizeText(input.author, PLUGIN_AUTHOR_MAX_LENGTH),
    repository,
    releaseUrl: normalizeText(input.releaseUrl, PLUGIN_RELEASE_URL_MAX_LENGTH),
    tags: normalizeTagsText(input.tags),
    enabled: input.enabled === true,
    sortOrder: normalizeSortOrder(input.sortOrder),
  };
}

export function normalizePluginRow(row) {
  if (!row) {
    return null;
  }

  const repository = normalizeText(row.repository, PLUGIN_REPOSITORY_MAX_LENGTH);
  const iconUrl = buildPluginIconUrl(repository);

  return {
    id: normalizeText(row.id, PLUGIN_ID_MAX_LENGTH),
    name: normalizeText(row.name, PLUGIN_NAME_MAX_LENGTH),
    description: normalizeText(row.description, PLUGIN_DESCRIPTION_MAX_LENGTH),
    version: normalizeText(row.version, PLUGIN_VERSION_MAX_LENGTH),
    author: normalizeText(row.author, PLUGIN_AUTHOR_MAX_LENGTH),
    repository,
    releaseUrl: normalizeText(row.release_url, PLUGIN_RELEASE_URL_MAX_LENGTH),
    previousVersion: normalizeText(row.previous_version, PLUGIN_VERSION_MAX_LENGTH),
    previousReleaseUrl: normalizeText(row.previous_release_url, PLUGIN_RELEASE_URL_MAX_LENGTH),
    tags: splitPluginTags(row.tags),
    tagsText: normalizeText(row.tags, PLUGIN_TAGS_MAX_LENGTH),
    iconUrl,
    downloadCount: normalizeDownloadCount(row.download_count),
    sortOrder: normalizeSortOrder(row.sort_order),
    enabled: Number(row.enabled) !== 0,
    createdAt: normalizeText(row.created_at, 40),
    updatedAt: normalizeText(row.updated_at, 40),
  };
}

export async function listPublicPlugins(env, options = {}) {
  if (!env.RESOURCE_DB) {
    return [];
  }

  const query = normalizeText(options.query, 200).toLowerCase();
  let sql = 'SELECT * FROM plugins WHERE enabled = 1';
  const params = [];

  if (query) {
    sql += ' AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)';
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern);
  }

  sql += ' ORDER BY sort_order DESC, id DESC';

  const result = await env.RESOURCE_DB.prepare(sql).bind(...params).all();
  return (result.results || [])
    .map((row) => normalizePluginRow(row))
    .filter((plugin) => plugin && plugin.releaseUrl === buildPluginPackageUrl(plugin.id, plugin.version));
}

export async function listAdminPlugins(env) {
  if (!env.RESOURCE_DB) {
    return [];
  }

  const sql = 'SELECT * FROM plugins ORDER BY sort_order DESC, id DESC';
  const result = await env.RESOURCE_DB.prepare(sql).all();
  return (result.results || []).map((row) => normalizePluginRow(row)).filter(Boolean);
}

export async function readPlugin(env, id) {
  if (!env.RESOURCE_DB) {
    return null;
  }

  const pluginId = normalizeText(id, PLUGIN_ID_MAX_LENGTH);
  if (!pluginId) {
    return null;
  }

  const sql = 'SELECT * FROM plugins WHERE id = ? LIMIT 1';
  const result = await env.RESOURCE_DB.prepare(sql).bind(pluginId).first();
  return normalizePluginRow(result);
}

/** 原子累计一次已启用插件的下载量 */
export async function incrementPluginDownload(env, id) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }

  const pluginId = normalizeText(id, PLUGIN_ID_MAX_LENGTH);
  if (!pluginId) {
    return null;
  }

  const sql = `
    UPDATE plugins
    SET download_count = COALESCE(download_count, 0) + 1
    WHERE id = ? AND enabled = 1
    RETURNING download_count AS downloadCount
  `;
  const change = await env.RESOURCE_DB.prepare(sql).bind(pluginId).first();
  return change ? { downloadCount: normalizeDownloadCount(change.downloadCount) } : null;
}

/** 保存已经从 GitHub 解析完成的插件信息 */
async function persistResolvedPlugin(env, resolved, options = {}) {
  const requestedId = normalizeText(options.id, PLUGIN_ID_MAX_LENGTH);
  if (requestedId && requestedId !== resolved.id) {
    throw createPluginError(`插件 ID 不允许变更：仓库 manifest.json 当前为 ${resolved.id}`);
  }

  const id = resolved.id;
  const normalized = normalizePluginInput({
    ...resolved,
    enabled: options.enabled,
    sortOrder: options.sortOrder,
  });
  const previousVersion = normalizeText(options.previousVersion, PLUGIN_VERSION_MAX_LENGTH);
  const previousReleaseUrl = normalizeText(options.previousReleaseUrl, PLUGIN_RELEASE_URL_MAX_LENGTH);
  const now = formatNoticeTime(new Date());
  const sql = `
    INSERT INTO plugins (
      id, name, description, version, author, repository, release_url,
      previous_version, previous_release_url,
      tags, enabled, sort_order, download_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      version = excluded.version,
      author = excluded.author,
      repository = excluded.repository,
      release_url = excluded.release_url,
      previous_version = excluded.previous_version,
      previous_release_url = excluded.previous_release_url,
      tags = excluded.tags,
      enabled = excluded.enabled,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
    RETURNING *
  `;
  const row = await env.RESOURCE_DB.prepare(sql).bind(
    id,
    normalized.name,
    normalized.description,
    normalized.version,
    normalized.author,
    normalized.repository,
    normalized.releaseUrl,
    previousVersion || null,
    previousReleaseUrl || null,
    normalized.tags,
    normalized.enabled ? 1 : 0,
    normalized.sortOrder,
    now,
    now,
  ).first();

  return normalizePluginRow(row);
}

/** 只保留确实存在于 R2 的上一版正式安装包。 */
async function resolvePreviousRelease(env, existing, sameVersion, nextVersion) {
  const version = normalizeText(
    sameVersion ? existing?.previousVersion : existing?.version,
    PLUGIN_VERSION_MAX_LENGTH,
  );
  const releaseUrl = normalizeText(
    sameVersion ? existing?.previousReleaseUrl : existing?.releaseUrl,
    PLUGIN_RELEASE_URL_MAX_LENGTH,
  );
  if (!version || version === nextVersion || releaseUrl !== buildPluginPackageUrl(existing?.id, version)) {
    return { version: '', releaseUrl: '' };
  }

  const object = await env.RESOURCE_BUCKET.head(createPluginPackageKey(existing.id, version));
  return object?.size > 0 ? { version, releaseUrl } : { version: '', releaseUrl: '' };
}

/** 在已持有租约锁时镜像并发布插件。 */
async function publishResolvedPluginLocked(env, resolved, options = {}) {
  const requestedId = normalizeText(options.id, PLUGIN_ID_MAX_LENGTH);
  if (requestedId && requestedId !== resolved.id) {
    throw createPluginError(`插件 ID 不允许变更：仓库 manifest.json 当前为 ${resolved.id}`);
  }

  const existing = await readPlugin(env, resolved.id);
  const mirrored = await mirrorPluginPackage(env, resolved, existing);
  const sameVersion = existing?.version === mirrored.version;
  const previousRelease = await resolvePreviousRelease(env, existing, sameVersion, mirrored.version);
  let persisted = false;

  try {
    const plugin = await persistResolvedPlugin(env, mirrored, {
      ...options,
      previousVersion: previousRelease.version,
      previousReleaseUrl: previousRelease.releaseUrl,
    });
    persisted = true;
    const keepKeys = new Set([mirrored.packageKey]);
    if (plugin.previousVersion
      && plugin.previousReleaseUrl === buildPluginPackageUrl(plugin.id, plugin.previousVersion)) {
      keepKeys.add(createPluginPackageKey(plugin.id, plugin.previousVersion));
    }
    await cleanupPluginPackages(env, mirrored.id, keepKeys);
    return plugin;
  } catch (error) {
    if (!persisted && !mirrored.reused && existing?.releaseUrl !== mirrored.releaseUrl) {
      await env.RESOURCE_BUCKET.delete(mirrored.packageKey).catch(() => undefined);
    }
    throw error;
  } finally {
    await finishPluginPackagePublication(env, mirrored.publicationId).catch(() => undefined);
  }
}

/** 在跨 Worker 租约锁内发布插件，成功后只保留当前版和上一版。 */
async function publishResolvedPlugin(env, resolved, options = {}) {
  return withPluginPackageOperationLock(
    env,
    () => publishResolvedPluginLocked(env, resolved, options),
  );
}

/** 根据仓库地址自动解析并保存插件 */
export async function upsertPlugin(env, input) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }

  const repository = normalizeText(input.repository, PLUGIN_REPOSITORY_MAX_LENGTH);
  if (!repository) {
    throw createPluginError('missing repository');
  }

  const resolved = await resolveGitHubPlugin(env, repository);
  return publishResolvedPlugin(env, resolved, {
    id: input.id,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
  });
}

/** 同步全部市场插件的最新正式 Release。 */
export async function syncAllPlugins(env) {
  if (!env.RESOURCE_DB) {
    return {
      totalCount: 0,
      syncedCount: 0,
      failedCount: 0,
      failures: [],
      cleanupDeletedCount: 0,
      cleanupError: '',
    };
  }

  const result = await env.RESOURCE_DB.prepare(`
    SELECT id, repository, enabled, sort_order
    FROM plugins
    ORDER BY id ASC
  `).all();
  let syncedCount = 0;
  const failures = [];

  for (const row of result.results || []) {
    const current = {
      id: normalizeText(row.id, PLUGIN_ID_MAX_LENGTH),
      repository: normalizeText(row.repository, PLUGIN_REPOSITORY_MAX_LENGTH),
      enabled: Number(row.enabled) !== 0,
      sortOrder: normalizeSortOrder(row.sort_order),
    };
    if (!current.id || !current.repository) continue;

    try {
      const resolved = await resolveGitHubPlugin(env, current.repository);
      await publishResolvedPlugin(env, resolved, {
        id: current.id,
        enabled: current.enabled,
        sortOrder: current.sortOrder,
      });
      syncedCount += 1;
    } catch (error) {
      const message = normalizeText(error?.message || String(error), 300) || '未知错误';
      failures.push({ id: current.id, message });
      console.error(`[analytics] sync plugin failed: ${current.id}`, message);
    }
  }

  let cleanupDeletedCount = 0;
  let cleanupError = '';
  try {
    cleanupDeletedCount = await cleanupAllPluginPackages(env);
  } catch (error) {
    cleanupError = normalizeText(error?.message || String(error), 300) || '未知错误';
    console.error('[analytics] cleanup plugin packages failed', cleanupError);
  }

  return {
    totalCount: (result.results || []).length,
    syncedCount,
    failedCount: failures.length,
    failures,
    cleanupDeletedCount,
    cleanupError,
  };
}

async function deletePluginLocked(env, id) {
  if (!env.RESOURCE_DB) {
    return null;
  }

  const pluginId = normalizeText(id, PLUGIN_ID_MAX_LENGTH);
  if (!pluginId) {
    return null;
  }

  const existing = await readPlugin(env, pluginId);
  if (existing) {
    const sql = 'DELETE FROM plugins WHERE id = ?';
    await env.RESOURCE_DB.prepare(sql).bind(pluginId).run();
    await cleanupPluginPackages(env, pluginId);
  }

  return existing;
}

/** 在跨 Worker 租约锁内删除插件记录和全部安装包。 */
export async function deletePlugin(env, id) {
  return withPluginPackageOperationLock(env, () => deletePluginLocked(env, id));
}

function normalizeSortOrder(value) {
  const order = Number(value || 0);
  return Number.isFinite(order) ? Math.floor(order) : 0;
}

function normalizeDownloadCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
