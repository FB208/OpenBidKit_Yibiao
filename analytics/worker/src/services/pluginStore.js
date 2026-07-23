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
const PLUGIN_SYNC_CACHE_KEY = 'plugin-market:last-github-sync';
const PLUGIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

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

/** 请求 GitHub JSON 接口并转换为管理端可读错误 */
async function fetchGitHubJson(env, url, resourceName) {
  let response;
  try {
    response = await fetch(url, { headers: buildGitHubHeaders(env) });
  } catch (error) {
    throw createPluginError(`无法连接 GitHub 读取${resourceName}：${error?.message || String(error)}`, 502);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应统一由下面的状态处理。
  }

  if (!response.ok) {
    const detail = normalizeText(data?.message, 160);
    throw createPluginError(`无法读取 GitHub ${resourceName}（${response.status}）${detail ? `：${detail}` : ''}`, 502);
  }

  return data;
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

/** 根据仓库最新正式 Release 解析客户端所需的完整插件信息 */
export async function resolveGitHubPlugin(env, repositoryUrl) {
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
    throw createPluginError(`最新 Release 缺少安装包：${expectedAssetName}`);
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
    tags: normalizeTagsText(manifest?.tags),
  };
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
  return (result.results || []).map((row) => normalizePluginRow(row)).filter(Boolean);
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
  `;
  const result = await env.RESOURCE_DB.prepare(sql).bind(pluginId).run();
  if (!Number(result.meta?.changes || 0)) {
    return null;
  }

  return readPlugin(env, pluginId);
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
  const now = formatNoticeTime(new Date());
  const existing = await readPlugin(env, id);

  if (existing) {
    const sql = `
      UPDATE plugins
      SET name = ?, description = ?, version = ?, author = ?,
          repository = ?, release_url = ?, tags = ?, enabled = ?,
          sort_order = ?, updated_at = ?
      WHERE id = ?
    `;
    await env.RESOURCE_DB.prepare(sql).bind(
      normalized.name,
      normalized.description,
      normalized.version,
      normalized.author,
      normalized.repository,
      normalized.releaseUrl,
      normalized.tags,
      normalized.enabled ? 1 : 0,
      normalized.sortOrder,
      now,
      id,
    ).run();
  } else {
    const sql = `
      INSERT INTO plugins (
        id, name, description, version, author, repository, release_url,
        tags, enabled, sort_order, download_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `;
    await env.RESOURCE_DB.prepare(sql).bind(
      id,
      normalized.name,
      normalized.description,
      normalized.version,
      normalized.author,
      normalized.repository,
      normalized.releaseUrl,
      normalized.tags,
      normalized.enabled ? 1 : 0,
      normalized.sortOrder,
      now,
      now,
    ).run();
  }

  return readPlugin(env, id);
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
  return persistResolvedPlugin(env, resolved, {
    id: input.id,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
  });
}

/** 定时同步全部市场插件的最新正式 Release */
export async function syncAllPlugins(env) {
  if (!env.RESOURCE_DB) {
    return [];
  }

  const result = await env.RESOURCE_DB.prepare('SELECT * FROM plugins ORDER BY id ASC').all();
  const synced = [];

  for (const row of result.results || []) {
    const current = normalizePluginRow(row);
    if (!current) continue;

    try {
      const resolved = await resolveGitHubPlugin(env, current.repository);
      const plugin = await persistResolvedPlugin(env, resolved, {
        id: current.id,
        enabled: current.enabled,
        sortOrder: current.sortOrder,
      });
      synced.push(plugin);
    } catch (error) {
      console.error(`[analytics] sync plugin failed: ${current.id}`, error?.message || String(error));
    }
  }

  return synced;
}

/** 市场被访问时最多每 15 分钟触发一次 GitHub 同步 */
export async function syncPluginsIfDue(env) {
  try {
    const now = Date.now();
    if (env.NOTICE_STORE) {
      const lastSyncAt = Number(await env.NOTICE_STORE.get(PLUGIN_SYNC_CACHE_KEY) || 0);
      if (Number.isFinite(lastSyncAt) && now - lastSyncAt < PLUGIN_SYNC_INTERVAL_MS) {
        return [];
      }

      // 先写入同步时间，避免并发市场请求重复访问 GitHub。
      await env.NOTICE_STORE.put(PLUGIN_SYNC_CACHE_KEY, String(now));
    }

    return await syncAllPlugins(env);
  } catch (error) {
    console.error('[analytics] plugin market sync failed', error?.message || String(error));
    return [];
  }
}

export async function deletePlugin(env, id) {
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
  }

  return existing;
}

function normalizeSortOrder(value) {
  const order = Number(value || 0);
  return Number.isFinite(order) ? Math.floor(order) : 0;
}

function normalizeDownloadCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
