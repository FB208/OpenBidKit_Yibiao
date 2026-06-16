import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const GITEE_API_BASE_URL = 'https://gitee.com/api/v5';
const DEFAULT_R2_RELEASE_PREFIX = 'release';
const GITEE_TARGET_COMMITISH = 'main';
const TAG_SYNC_TIMEOUT_SECONDS = 600;
const TAG_SYNC_POLL_INTERVAL_SECONDS = 10;

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

function normalizePrefix(value) {
  return String(value || DEFAULT_R2_RELEASE_PREFIX)
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function normalizePublicBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function createPublicUrl(publicBaseUrl, key) {
  const encodedKey = String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${publicBaseUrl}/${encodedKey}`;
}

function joinKey(prefix, fileName) {
  return prefix ? `${prefix}/${fileName}` : fileName;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readGithubRelease(releaseJsonPath, tagName) {
  const raw = await fs.readFile(releaseJsonPath, 'utf-8');
  const release = JSON.parse(raw);
  if (!release.tagName && !release.tag_name) {
    release.tagName = tagName;
  }
  return release;
}

async function listDownloadFiles(assetsDir) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(assetsDir, entry.name))
    .filter((filePath) => /\.(?:exe|msi|dmg|zip)$/i.test(path.basename(filePath)))
    .sort((a, b) => compareAssetNames(path.basename(a), path.basename(b)));

  if (files.length === 0) {
    throw new Error(`No downloadable release assets found in ${assetsDir}.`);
  }
  return files;
}

function getAssetRank(fileName) {
  if (/-win-x64\.exe$/i.test(fileName)) return 10;
  if (/-win-x64\.msi$/i.test(fileName)) return 20;
  if (/-win-x64\.zip$/i.test(fileName)) return 30;
  if (/-mac-x64\.dmg$/i.test(fileName)) return 40;
  if (/-mac-arm64\.dmg$/i.test(fileName)) return 50;
  if (/-mac-x64\.zip$/i.test(fileName)) return 60;
  if (/-mac-arm64\.zip$/i.test(fileName)) return 70;
  return 100;
}

function compareAssetNames(a, b) {
  const rankA = getAssetRank(a);
  const rankB = getAssetRank(b);
  if (rankA !== rankB) return rankA - rankB;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getAssetPlatform(fileName) {
  if (/-win-/i.test(fileName)) return 'Windows';
  if (/-mac-x64/i.test(fileName)) return 'macOS Intel';
  if (/-mac-arm64/i.test(fileName)) return 'macOS Apple Silicon';
  if (/-mac-/i.test(fileName)) return 'macOS';
  return '通用';
}

function getAssetKind(fileName) {
  if (/\.exe$/i.test(fileName)) return 'EXE 安装包';
  if (/\.msi$/i.test(fileName)) return 'MSI 安装包';
  if (/\.dmg$/i.test(fileName)) return 'DMG 安装包';
  if (/-mac-(?:x64|arm64)\.zip$/i.test(fileName)) return '自动更新包';
  if (/-package\.zip$/i.test(fileName)) return 'ZIP 安装包';
  if (/\.zip$/i.test(fileName)) return 'ZIP 压缩包';
  return '安装包';
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function buildDownloadAssets({ assetFiles, publicBaseUrl, prefix }) {
  const assets = [];
  for (const filePath of assetFiles) {
    const fileName = path.basename(filePath);
    const key = joinKey(prefix, fileName);
    const stat = await fs.stat(filePath);
    assets.push({
      name: fileName,
      platform: getAssetPlatform(fileName),
      kind: getAssetKind(fileName),
      size: stat.size,
      url: createPublicUrl(publicBaseUrl, key),
      sha256: await sha256File(filePath),
    });
  }
  return assets;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function buildReleaseBody({ githubRelease, assets }) {
  const lines = [
    '## 下载地址',
    '',
    '安装包和自动更新包托管在 Cloudflare R2，Gitee Release 不直接上传文件。',
    '',
    '| 平台 | 类型 | 文件 | 大小 | 下载 |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const asset of assets) {
    lines.push(`| ${asset.platform} | ${asset.kind} | ${asset.name} | ${formatSize(asset.size)} | [下载](${asset.url}) |`);
  }

  lines.push('', '## SHA256', '', '| 文件 | SHA256 |', '| --- | --- |');
  for (const asset of assets) {
    lines.push(`| ${asset.name} | \`${asset.sha256}\` |`);
  }

  const githubBody = String(githubRelease.body || '').trim();
  if (githubBody) {
    lines.push('', '## 更新内容', '', githubBody);
  }

  const githubUrl = String(githubRelease.url || githubRelease.html_url || '').trim();
  if (githubUrl) {
    lines.push('', `GitHub Release：${githubUrl}`);
  }

  return `${lines.join('\n')}\n`;
}

async function giteeRequest({ owner, repo, token, apiPath, method = 'GET', form = null, allow404 = false }) {
  const url = new URL(`${GITEE_API_BASE_URL}/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${apiPath}`);
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'yibiao-release-sync',
    },
  };

  if (method === 'GET') {
    url.searchParams.set('access_token', token);
  } else {
    const body = new URLSearchParams({ access_token: token, ...(form || {}) });
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    options.body = body;
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (allow404 && response.status === 404) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof data === 'object' && data?.message ? data.message : text || response.statusText;
    throw new Error(`Gitee API ${method} ${apiPath} failed: ${response.status} ${message}`);
  }
  return data;
}

async function giteeRequestPagedTags({ owner, repo, token, page }) {
  const query = new URLSearchParams({ page: String(page), per_page: '100' });
  return giteeRequest({
    owner,
    repo,
    token,
    apiPath: `/tags?${query.toString()}`,
  });
}

async function hasGiteeTag({ owner, repo, token, tagName }) {
  for (let page = 1; page <= 10; page += 1) {
    const tags = await giteeRequestPagedTags({ owner, repo, token, page });
    if (!Array.isArray(tags) || tags.length === 0) {
      return false;
    }
    if (tags.some((tag) => tag?.name === tagName)) {
      return true;
    }
    if (tags.length < 100) {
      return false;
    }
  }
  return false;
}

async function waitForGiteeTag({ owner, repo, token, tagName }) {
  const deadline = Date.now() + TAG_SYNC_TIMEOUT_SECONDS * 1000;
  while (Date.now() <= deadline) {
    if (await hasGiteeTag({ owner, repo, token, tagName })) {
      console.log(`Gitee tag is ready: ${tagName}`);
      return;
    }
    console.log(`Waiting for Gitee tag: ${tagName}`);
    await sleep(TAG_SYNC_POLL_INTERVAL_SECONDS * 1000);
  }
  throw new Error(`Gitee tag ${tagName} was not found after ${TAG_SYNC_TIMEOUT_SECONDS} seconds.`);
}

async function getGiteeReleaseByTag({ owner, repo, token, tagName }) {
  return giteeRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/tags/${encodePathSegment(tagName)}`,
    allow404: true,
  });
}

async function createGiteeRelease({ owner, repo, token, tagName, name, body, prerelease }) {
  const release = await giteeRequest({
    owner,
    repo,
    token,
    apiPath: '/releases',
    method: 'POST',
    form: {
      tag_name: tagName,
      name,
      body,
      target_commitish: GITEE_TARGET_COMMITISH,
      prerelease: prerelease ? 'true' : 'false',
    },
  });
  console.log(`Created Gitee Release: ${release?.id || tagName}`);
  return release;
}

async function updateGiteeRelease({ owner, repo, token, releaseId, tagName, name, body, prerelease }) {
  const release = await giteeRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(releaseId)}`,
    method: 'PATCH',
    form: {
      tag_name: tagName,
      name,
      body,
      target_commitish: GITEE_TARGET_COMMITISH,
      prerelease: prerelease ? 'true' : 'false',
    },
  });
  console.log(`Updated Gitee Release: ${release?.id || releaseId}`);
  return release;
}

async function publishGiteeRelease({ owner, repo, token, tagName, name, body, prerelease }) {
  const existingRelease = await getGiteeReleaseByTag({ owner, repo, token, tagName });
  if (existingRelease?.id) {
    return updateGiteeRelease({
      owner,
      repo,
      token,
      releaseId: existingRelease.id,
      tagName,
      name,
      body,
      prerelease,
    });
  }
  return createGiteeRelease({ owner, repo, token, tagName, name, body, prerelease });
}

async function main() {
  const token = requireEnv('GITEE_ACCESS_TOKEN');
  const owner = requireEnv('GITEE_OWNER');
  const repo = requireEnv('GITEE_REPO');
  const tagName = requireEnv('TAG_NAME');
  const assetsDir = requireEnv('RELEASE_ASSETS_DIR');
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');
  const publicBaseUrl = normalizePublicBaseUrl(requireEnv('R2_PUBLIC_BASE_URL'));
  const prefix = normalizePrefix(optionalEnv('R2_RELEASE_PREFIX', DEFAULT_R2_RELEASE_PREFIX));

  const githubRelease = await readGithubRelease(releaseJsonPath, tagName);
  const assetFiles = await listDownloadFiles(assetsDir);
  const assets = await buildDownloadAssets({ assetFiles, publicBaseUrl, prefix });
  const releaseName = String(githubRelease.name || githubRelease.tagName || tagName);
  const releaseBody = buildReleaseBody({ githubRelease, assets });
  const prerelease = Boolean(githubRelease.isPrerelease || githubRelease.prerelease);

  await waitForGiteeTag({ owner, repo, token, tagName });
  await publishGiteeRelease({
    owner,
    repo,
    token,
    tagName,
    name: releaseName,
    body: releaseBody,
    prerelease,
  });

  console.log(`Gitee Release published: ${owner}/${repo}@${tagName}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
