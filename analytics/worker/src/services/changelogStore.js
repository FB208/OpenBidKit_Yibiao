import { CHANGELOG_CONTENT_MAX_LENGTH, CHANGELOG_VERSION_MAX_LENGTH, CHANGELOG_VERSION_PATTERN } from '../constants.js';
import { formatBusinessDateTime, normalizeText } from '../utils.js';

const CHANGELOG_COLUMNS = 'id, project_name, version, content, created_at, updated_at';

// 规范化管理端录入的版本号：去掉开头的 v，不符合 x.y.z 时返回空串。
export function normalizeChangelogVersion(value) {
  const version = normalizeText(value, CHANGELOG_VERSION_MAX_LENGTH).replace(/^v/i, '');
  return CHANGELOG_VERSION_PATTERN.test(version) ? version : '';
}

// 按版本号数值逐段倒序；版本号相同时按首次发布时间倒序。
export function compareChangelogsDesc(a, b) {
  const left = a.version.split('.').map(Number);
  const right = b.version.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return b.createdAt.localeCompare(a.createdAt);
}

function createChangelogId(now) {
  const timestamp = now.replace(/[-: ]/g, '').slice(0, 14);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `changelog-${timestamp}-${random}`;
}

// 将 D1 更新日志记录转换为接口使用的数据结构。
function normalizeChangelogRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id, 120),
    projectName: normalizeText(row.project_name, 80),
    version: normalizeText(row.version, CHANGELOG_VERSION_MAX_LENGTH),
    content: normalizeText(row.content, CHANGELOG_CONTENT_MAX_LENGTH),
    createdAt: normalizeText(row.created_at, 40),
    updatedAt: normalizeText(row.updated_at, 40),
  };
}

// 查询指定项目的全部更新日志，按版本号倒序返回。
export async function listChangelogs(env, projectName) {
  const result = await requireResourceDb(env).prepare(
    `SELECT ${CHANGELOG_COLUMNS} FROM changelogs WHERE project_name = ?`,
  ).bind(projectName).all();

  return (result.results || [])
    .map(normalizeChangelogRow)
    .filter(Boolean)
    .sort(compareChangelogsDesc);
}

// 读取最新一条更新日志的首次发布时间，供客户端判断红点；修改旧日志不改变该值。
export async function readLatestChangelogPublishedAt(env, projectName) {
  const row = await requireResourceDb(env).prepare(
    'SELECT MAX(created_at) AS latest FROM changelogs WHERE project_name = ?',
  ).bind(projectName).first();

  return normalizeText(row?.latest, 40);
}

// 查找占用同一版本号的其他记录，用于保存前的唯一性检查。
export async function findChangelogByVersion(env, projectName, version, excludeId = '') {
  const row = await requireResourceDb(env).prepare(
    `SELECT ${CHANGELOG_COLUMNS} FROM changelogs
     WHERE project_name = ? AND version = ? AND id != ?`,
  ).bind(projectName, version, excludeId).first();

  return normalizeChangelogRow(row);
}

// 新增或更新一条更新日志；更新时保留首次发布时间。
export async function saveChangelog(env, input) {
  const db = requireResourceDb(env);
  const now = formatBusinessDateTime();
  let row;

  if (input.id) {
    row = await db.prepare(
      `UPDATE changelogs
       SET version = ?, content = ?, updated_at = ?
       WHERE project_name = ? AND id = ?
       RETURNING ${CHANGELOG_COLUMNS}`,
    ).bind(input.version, input.content, now, input.projectName, input.id).first();
  } else {
    row = await db.prepare(
      `INSERT INTO changelogs (${CHANGELOG_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${CHANGELOG_COLUMNS}`,
    ).bind(createChangelogId(now), input.projectName, input.version, input.content, now, now).first();
  }

  return normalizeChangelogRow(row);
}

// 永久删除一条更新日志，返回是否删除了记录。
export async function deleteChangelog(env, projectName, id) {
  const result = await requireResourceDb(env).prepare(
    'DELETE FROM changelogs WHERE project_name = ? AND id = ?',
  ).bind(projectName, id).run();

  return Number(result?.meta?.changes || 0) > 0;
}

function requireResourceDb(env) {
  if (!env.RESOURCE_DB) {
    throw new Error('RESOURCE_DB is not configured');
  }
  return env.RESOURCE_DB;
}
