import { CHANGELOG_CONTENT_MAX_LENGTH } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  deleteChangelog,
  findChangelogByVersion,
  listChangelogs,
  normalizeChangelogVersion,
  readLatestChangelogPublishedAt,
  saveChangelog,
} from '../services/changelogStore.js';
import { isValidProjectName, normalizeText } from '../utils.js';

const noStoreHeaders = { 'Cache-Control': 'no-store' };

// 客户端读取全部更新日志，已按版本号倒序。
export async function handlePublicChangelogs(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const changelogs = await listChangelogs(env, projectName);
    return json({
      code: 0,
      changelogs: changelogs.map((changelog) => ({
        version: changelog.version,
        content: changelog.content,
        publishedAt: changelog.createdAt,
      })),
    }, { headers: noStoreHeaders });
  } catch (error) {
    console.error('[analytics] public changelogs failed', error?.message || String(error));
    return json({ code: 500, message: 'changelogs query failed' }, { status: 500 });
  }
}

// 客户端轮询红点时只读取最新一条日志的首次发布时间。
export async function handlePublicChangelogLatest(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const latestPublishedAt = await readLatestChangelogPublishedAt(env, projectName);
    return json({ code: 0, latestPublishedAt }, { headers: noStoreHeaders });
  } catch (error) {
    console.error('[analytics] public changelog latest failed', error?.message || String(error));
    return json({ code: 500, message: 'changelog latest query failed' }, { status: 500 });
  }
}

export async function handleAdminChangelogs(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'RESOURCE_DB is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminListChangelogs(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveChangelog(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteChangelog(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminListChangelogs(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const changelogs = await listChangelogs(env, projectName);
    return json({ code: 0, changelogs }, { headers: noStoreHeaders });
  } catch (error) {
    console.error('[analytics] admin changelogs query failed', error?.message || String(error));
    return json({ code: 500, message: 'changelogs query failed' }, { status: 500 });
  }
}

async function handleAdminSaveChangelog(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const id = normalizeText(body.id, 120);
  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const version = normalizeChangelogVersion(body.version);
  const content = normalizeText(body.content, CHANGELOG_CONTENT_MAX_LENGTH);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (!version) {
    return json({ code: 400, message: 'invalid version' }, { status: 400 });
  }

  if (!content) {
    return json({ code: 400, message: 'missing content' }, { status: 400 });
  }

  try {
    if (await findChangelogByVersion(env, projectName, version, id)) {
      return json({ code: 409, message: 'version already exists' }, { status: 409 });
    }

    const changelog = await saveChangelog(env, { id, projectName, version, content });
    if (!changelog) {
      return json({ code: 404, message: 'changelog not found' }, { status: 404 });
    }
    return json({ code: 0, changelog });
  } catch (error) {
    console.error('[analytics] save changelog failed', error?.message || String(error));
    return json({ code: 500, message: 'changelog save failed' }, { status: 500 });
  }
}

async function handleAdminDeleteChangelog(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!isValidProjectName(projectName) || !id) {
    return json({ code: 400, message: 'invalid projectName or id' }, { status: 400 });
  }

  try {
    if (!await deleteChangelog(env, projectName, id)) {
      return json({ code: 404, message: 'changelog not found' }, { status: 404 });
    }
    return json({ code: 0 });
  } catch (error) {
    console.error('[analytics] delete changelog failed', error?.message || String(error));
    return json({ code: 500, message: 'changelog delete failed' }, { status: 500 });
  }
}
