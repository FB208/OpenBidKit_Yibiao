import fs from 'node:fs/promises';
import path from 'node:path';

const GITEE_API_BASE = 'https://gitee.com/api/v5';
const DEFAULT_TAG_WAIT_SECONDS = 600;
const TAG_WAIT_INTERVAL_SECONDS = 15;

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mimeTypeFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'application/x-yaml';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (lower.endsWith('.msi')) return 'application/octet-stream';
  if (lower.endsWith('.blockmap')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

function createGiteeUrl(owner, repo, endpoint, token, params = {}) {
  const url = new URL(`${GITEE_API_BASE}/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${endpoint}`);
  url.searchParams.set('access_token', token);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestGiteeJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await parseResponseBody(response);
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`Gitee API failed: ${response.status} ${response.statusText}. ${detail || ''}`.trim());
  }
  return body;
}

async function pagedGiteeList(owner, repo, token, endpoint) {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const pageItems = await requestGiteeJson(createGiteeUrl(owner, repo, endpoint, token, { page, per_page: 100 }));
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    items.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return items;
}

async function findGiteeTag(owner, repo, token, tagName) {
  const tags = await pagedGiteeList(owner, repo, token, '/tags');
  return tags.find((tag) => tag?.name === tagName || tag?.tag_name === tagName) || null;
}

async function waitForGiteeTag(owner, repo, token, tagName, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt = 1;

  while (Date.now() <= deadline) {
    const tag = await findGiteeTag(owner, repo, token, tagName);
    if (tag) {
      console.log(`Gitee tag is ready: ${tagName}`);
      return tag;
    }

    console.log(`Waiting for Gitee tag ${tagName}, attempt ${attempt}.`);
    attempt += 1;
    await sleep(TAG_WAIT_INTERVAL_SECONDS * 1000);
  }

  throw new Error(`Gitee tag ${tagName} was not found after ${waitSeconds} seconds. Check the pull mirror status on Gitee.`);
}

async function getGiteeReleaseByTag(owner, repo, token, tagName) {
  const releases = await pagedGiteeList(owner, repo, token, '/releases');
  return releases.find((release) => release?.tag_name === tagName || release?.tagName === tagName) || null;
}

function buildReleaseBody(githubRelease, githubRepository, tagName) {
  const body = String(githubRelease.body || '').trim();
  const sourceUrl = githubRelease.url || (githubRepository ? `https://github.com/${githubRepository}/releases/tag/${tagName}` : '');
  const header = sourceUrl
    ? `同步自 GitHub Release：${sourceUrl}`
    : '同步自 GitHub Release。';
  return body ? `${header}\n\n---\n\n${body}` : header;
}

async function createGiteeRelease(owner, repo, token, githubRelease, githubRepository, tagName) {
  const payload = {
    tag_name: tagName,
    target_commitish: tagName,
    name: githubRelease.name || tagName,
    body: buildReleaseBody(githubRelease, githubRepository, tagName),
    prerelease: Boolean(githubRelease.isPrerelease),
  };

  const release = await requestGiteeJson(createGiteeUrl(owner, repo, '/releases', token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log(`Created Gitee release: ${tagName}`);
  return release;
}

async function updateGiteeRelease(owner, repo, token, releaseId, githubRelease, githubRepository, tagName) {
  const payload = {
    tag_name: tagName,
    target_commitish: tagName,
    name: githubRelease.name || tagName,
    body: buildReleaseBody(githubRelease, githubRepository, tagName),
    prerelease: Boolean(githubRelease.isPrerelease),
  };

  const release = await requestGiteeJson(createGiteeUrl(owner, repo, `/releases/${releaseId}`, token), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log(`Updated Gitee release: ${tagName}`);
  return release;
}

async function getGiteeAttachFiles(owner, repo, token, releaseId) {
  return pagedGiteeList(owner, repo, token, `/releases/${releaseId}/attach_files`);
}

async function deleteGiteeAttachFile(owner, repo, token, releaseId, attachFile) {
  if (!attachFile?.id) return;
  const name = attachFile.name || attachFile.filename || attachFile.id;
  await requestGiteeJson(createGiteeUrl(owner, repo, `/releases/${releaseId}/attach_files/${attachFile.id}`, token), {
    method: 'DELETE',
  });
  console.log(`Deleted old Gitee release asset: ${name}`);
}

async function uploadGiteeAttachFile(owner, repo, token, releaseId, filePath) {
  const fileName = path.basename(filePath);
  const buffer = await fs.readFile(filePath);
  const blob = new Blob([buffer], { type: mimeTypeFromFileName(fileName) });
  const formData = new FormData();
  formData.append('file', blob, fileName);

  await requestGiteeJson(createGiteeUrl(owner, repo, `/releases/${releaseId}/attach_files`, token), {
    method: 'POST',
    body: formData,
  });
  console.log(`Uploaded Gitee release asset: ${fileName}`);
}

async function listAssetFiles(assetsDir) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(assetsDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (files.length === 0) {
    throw new Error(`No release assets found in ${assetsDir}.`);
  }
  return files;
}

async function loadGithubRelease(releaseJsonPath, tagName) {
  const raw = await fs.readFile(releaseJsonPath, 'utf-8');
  const release = JSON.parse(raw);
  if (!release.tagName && !release.tag_name) {
    release.tagName = tagName;
  }
  return release;
}

async function main() {
  const token = requireEnv('GITEE_TOKEN');
  const owner = requireEnv('GITEE_OWNER');
  const repo = requireEnv('GITEE_REPO');
  const tagName = requireEnv('TAG_NAME');
  const assetsDir = requireEnv('RELEASE_ASSETS_DIR');
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');
  const githubRepository = optionalEnv('GITHUB_REPOSITORY');
  const tagWaitSeconds = normalizeSeconds(optionalEnv('GITEE_TAG_WAIT_SECONDS'), DEFAULT_TAG_WAIT_SECONDS);

  const githubRelease = await loadGithubRelease(releaseJsonPath, tagName);
  const assetFiles = await listAssetFiles(assetsDir);
  console.log(`Found ${assetFiles.length} GitHub release assets to sync.`);

  await waitForGiteeTag(owner, repo, token, tagName, tagWaitSeconds);

  let giteeRelease = await getGiteeReleaseByTag(owner, repo, token, tagName);
  if (!giteeRelease) {
    giteeRelease = await createGiteeRelease(owner, repo, token, githubRelease, githubRepository, tagName);
  } else {
    giteeRelease = await updateGiteeRelease(owner, repo, token, giteeRelease.id, githubRelease, githubRepository, tagName);
  }

  const releaseId = giteeRelease?.id;
  if (!releaseId) {
    throw new Error('Gitee release ID is missing.');
  }

  const oldAttachFiles = await getGiteeAttachFiles(owner, repo, token, releaseId);
  for (const attachFile of oldAttachFiles) {
    await deleteGiteeAttachFile(owner, repo, token, releaseId, attachFile);
  }

  for (const filePath of assetFiles) {
    await uploadGiteeAttachFile(owner, repo, token, releaseId, filePath);
  }

  console.log(`Gitee release synced: ${tagName}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
