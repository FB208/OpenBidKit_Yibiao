import fs from 'node:fs/promises';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';

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

/** 本地脚本在传输前后分别调用准备和完成阶段。 */
async function main() {
  const mode = process.argv[2];
  if (mode !== '--prepare' && mode !== '--finalize') {
    throw new Error('Expected --prepare or --finalize.');
  }
  const atomGit = {
    token: requireEnv('ATOMGIT_ACCESS_TOKEN'),
    owner: requireEnv('ATOMGIT_OWNER'),
    repo: requireEnv('ATOMGIT_REPO'),
    tagName: requireEnv('TAG_NAME'),
  };
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
