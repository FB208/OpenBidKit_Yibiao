import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';
const ASSET_CONTENT_TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
};

/** 读取必填环境变量。 */
function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

/** 编码 AtomGit API 路径参数。 */
function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

/** 按本次 tag 读取 GitHub Release 和附件，供两个本地入口共用。 */
async function fetchGithubRelease(tagName) {
  const repoPath = requireEnv('GITHUB_REPOSITORY').split('/').map(encodePathSegment).join('/');
  const response = await fetch(`https://api.github.com/repos/${repoPath}/releases/tags/${encodePathSegment(tagName)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${requireEnv('GITHUB_TOKEN')}`,
      'User-Agent': 'yibiao-release-sync',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Release ${tagName} request failed: HTTP ${response.status}`);
  }
  const release = await response.json();
  if (release.tag_name !== tagName || release.draft || !release.assets?.length) {
    throw new Error(`GitHub Release ${tagName} must be published and contain assets.`);
  }
  return {
    tagName,
    name: release.name || tagName,
    body: release.body || '',
    isPrerelease: release.prerelease,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
  };
}

/** 调用 AtomGit Release API 并统一处理响应。 */
async function atomGitRequest({
  owner,
  repo,
  token,
  apiPath,
  method = 'GET',
  query = null,
  body = null,
  allow404 = false,
}) {
  const url = new URL(
    `${ATOMGIT_API_BASE_URL}/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${apiPath}`,
  );
  for (const [name, value] of Object.entries(query || {})) {
    url.searchParams.set(name, String(value));
  }

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'yibiao-release-sync',
  };
  const options = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    options.body = JSON.stringify(body);
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
    const message = typeof data === 'object'
      ? data?.message || data?.error || data?.msg || JSON.stringify(data)
      : data;
    throw new Error(
      `AtomGit API ${method} ${apiPath} failed: ${response.status} ${message || response.statusText}`,
    );
  }
  return data;
}

/** 根据标签查询已有 AtomGit Release。 */
async function getAtomGitReleaseByTag({ owner, repo, token, tagName }) {
  return atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
    allow404: true,
  });
}

/** 检查 AtomGit 是否已同步指定标签。 */
async function hasAtomGitTag({ owner, repo, token, tagName }) {
  for (let page = 1; page <= 10; page += 1) {
    const tags = await atomGitRequest({
      owner,
      repo,
      token,
      apiPath: '/tags',
      query: { page, per_page: 100 },
    });
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

/** 创建新的 AtomGit Release。 */
async function createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: '/releases',
    method: 'POST',
    body: {
      tag_name: tagName,
      name,
      body,
      release_status: releaseStatus,
    },
  });
  console.log(`Created AtomGit Release: ${tagName}`);
}

/** 更新已有 AtomGit Release。 */
async function updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
    method: 'PATCH',
    body: {
      name,
      body,
      release_status: releaseStatus,
    },
  });
  console.log(`Updated AtomGit Release: ${tagName}`);
}

/** 读取已上传的附件名，排除 AtomGit 自动生成的源码压缩包。 */
function getExistingAssetNames(release) {
  return new Set((release?.assets || [])
    .filter((asset) => asset.type !== 'source')
    .map((asset) => asset.name));
}

/** 准备 Release 和本次待传清单；重跑只补齐同一 tag 的缺失附件。 */
async function prepareRelease(atomGit, releaseJsonPath) {
  const [githubRelease, tagExists, existingRelease] = await Promise.all([
    fetchGithubRelease(atomGit.tagName),
    hasAtomGitTag(atomGit),
    getAtomGitReleaseByTag(atomGit),
  ]);
  if (!tagExists) {
    throw new Error(`AtomGit tag ${atomGit.tagName} was not found. Complete code mirror sync first.`);
  }
  if (!existingRelease) {
    // 新版本在附件齐全前保持预发布；已有版本准备阶段不改变状态。
    await createAtomGitRelease({
      ...atomGit,
      name: githubRelease.name,
      body: githubRelease.body,
      releaseStatus: 'pre',
    });
  }
  const existingNames = getExistingAssetNames(existingRelease);
  const pendingAssets = githubRelease.assets.filter((asset) => !existingNames.has(asset.name));
  await fs.writeFile(releaseJsonPath, JSON.stringify({ ...githubRelease, pendingAssets }, null, 2), 'utf-8');
  console.log(`AtomGit Release prepared: ${atomGit.tagName}; pending=${pendingAssets.length}, skipped=${githubRelease.assets.length - pendingAssets.length}`);
}

/** 流式 PUT 本地文件；fetch 的请求体会随文件大小占用内存，大安装包改用 https 写入。 */
function putFile(url, headers, filePath) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'PUT', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.setTimeout(5 * 60 * 1000, () => request.destroy(new Error('Upload connection idle for 5 minutes.')));
    request.on('error', reject);
    pipeline(createReadStream(filePath), request).catch(reject);
  });
}

/**
 * 按 AtomGit 返回的地址和请求头上传单个附件。
 * 上传域名 file.gitcode.com 会被部分网络按 SNI 重置小握手包；Node 24 默认握手包较大，可正常连通。
 */
async function uploadAsset(atomGit, filePath) {
  const fileName = path.basename(filePath);
  console.log(`Getting AtomGit upload URL: ${fileName}`);
  const target = await atomGitRequest({
    ...atomGit,
    apiPath: `/releases/${encodePathSegment(atomGit.tagName)}/upload_url`,
    query: { file_name: fileName },
  });
  if (!target?.url) {
    throw new Error(`AtomGit did not return an upload URL for ${fileName}.`);
  }
  const {
    'Content-Type': contentType = ASSET_CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream',
    ...uploadHeaders
  } = target.headers || {};
  const { size } = await fs.stat(filePath);
  console.log(`Uploading to AtomGit: ${fileName}`);
  const response = await putFile(target.url, {
    ...uploadHeaders,
    'Content-Type': contentType,
    'Content-Length': size,
  }, filePath);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`AtomGit upload ${fileName} failed: HTTP ${response.status} ${response.body}`);
  }
}

/** 确认完整附件已经到账后，同步发布状态与 Actions 摘要。 */
async function finalizeRelease(atomGit, releaseJsonPath) {
  const githubRelease = JSON.parse(await fs.readFile(releaseJsonPath, 'utf-8'));
  if (githubRelease.tagName !== atomGit.tagName) {
    throw new Error(`Release manifest does not match tag ${atomGit.tagName}.`);
  }
  const release = await getAtomGitReleaseByTag(atomGit);
  const existingNames = getExistingAssetNames(release);
  const missing = githubRelease.assets.filter((asset) => !existingNames.has(asset.name));
  if (missing.length > 0) {
    throw new Error(`AtomGit Release is missing assets: ${missing.map((asset) => asset.name).join(', ')}`);
  }
  await updateAtomGitRelease({
    ...atomGit,
    name: githubRelease.name,
    body: githubRelease.body,
    releaseStatus: githubRelease.isPrerelease ? 'pre' : 'latest',
  });
  const releaseUrl = `https://atomgit.com/${encodePathSegment(atomGit.owner)}/${encodePathSegment(atomGit.repo)}/releases/${encodePathSegment(atomGit.tagName)}`;
  const summary = `AtomGit Release published: ${atomGit.tagName}; assets=${githubRelease.assets.length}`;
  console.log(summary);
  console.log(`AtomGit Release: ${releaseUrl}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n[AtomGit Release](${releaseUrl})\n`, 'utf-8');
  }
}

/** 本地脚本依次调用准备、逐个附件上传和完成阶段。 */
async function main() {
  const mode = process.argv[2];
  if (mode !== '--prepare' && mode !== '--upload' && mode !== '--finalize') {
    throw new Error('Expected --prepare, --upload <file> or --finalize.');
  }
  const atomGit = {
    token: requireEnv('ATOMGIT_ACCESS_TOKEN'),
    owner: requireEnv('ATOMGIT_OWNER'),
    repo: requireEnv('ATOMGIT_REPO'),
    tagName: requireEnv('TAG_NAME'),
  };
  if (mode === '--upload') {
    await uploadAsset(atomGit, process.argv[3]);
    return;
  }
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');
  if (mode === '--prepare') {
    await prepareRelease(atomGit, releaseJsonPath);
  } else {
    await finalizeRelease(atomGit, releaseJsonPath);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
