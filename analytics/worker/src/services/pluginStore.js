import { formatNoticeTime, normalizeText } from '../utils.js';

const PLUGIN_ID_MAX_LENGTH = 80;
const PLUGIN_NAME_MAX_LENGTH = 120;
const PLUGIN_DESCRIPTION_MAX_LENGTH = 500;
const PLUGIN_VERSION_MAX_LENGTH = 40;
const PLUGIN_AUTHOR_MAX_LENGTH = 120;
const PLUGIN_REPOSITORY_MAX_LENGTH = 300;
const PLUGIN_RELEASE_URL_MAX_LENGTH = 500;
const PLUGIN_TAGS_MAX_LENGTH = 200;

export function splitPluginTags(value) {
  const tags = String(value || '')
    .split(/[，,;；\n\r]+/)
    .map((item) => normalizeText(item, 40))
    .filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 10);
}

export function normalizeTagsText(value) {
  return normalizeText(splitPluginTags(value).join(', '), PLUGIN_TAGS_MAX_LENGTH);
}

export function buildPluginIconUrl(repository) {
  const repo = normalizeText(repository, PLUGIN_REPOSITORY_MAX_LENGTH);
  if (!repo || !repo.includes('github.com')) {
    return '';
  }

  // 从 https://github.com/user/repo 提取 user/repo
  const match = repo.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) {
    return '';
  }

  return `https://raw.githubusercontent.com/${match[1]}/main/assets/icon.png`;
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

export async function upsertPlugin(env, input) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }

  const id = normalizeText(input.id, PLUGIN_ID_MAX_LENGTH);
  const normalized = normalizePluginInput(input);

  if (!id) {
    throw new Error('missing id');
  }

  if (!normalized.name) {
    throw new Error('missing name');
  }

  if (!normalized.repository) {
    throw new Error('missing repository');
  }

  if (!normalized.releaseUrl) {
    throw new Error('missing release URL');
  }

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
