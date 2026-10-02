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

/** 读取 GitHub Release 元数据。 */
async function readGithubRelease(releaseJsonPath, tagName) {
  const raw = await fs.readFile(releaseJsonPath, 'utf-8');
  const release = JSON.parse(raw);
  if (!release.tagName && !release.tag_name) {
    release.tagName = tagName;
  }
  return release;
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

/** 创建或更新 AtomGit Release 元数据。 */
async function publishAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const existingRelease = await getAtomGitReleaseByTag({ owner, repo, token, tagName });
  if (existingRelease) {
    await updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
    return;
  }
  await createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
}

/** 同步 AtomGit Release 元数据，不处理附件。 */
async function main() {
  const token = requireEnv('ATOMGIT_ACCESS_TOKEN');
  const owner = requireEnv('ATOMGIT_OWNER');
  const repo = requireEnv('ATOMGIT_REPO');
  const tagName = requireEnv('TAG_NAME');
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');

  const githubRelease = await readGithubRelease(releaseJsonPath, tagName);
  const releaseName = String(githubRelease.name || githubRelease.tagName || tagName);
  const releaseBody = String(githubRelease.body || '');
  const releaseStatus = githubRelease.isPrerelease ? 'pre' : 'latest';

  if (!await hasAtomGitTag({ owner, repo, token, tagName })) {
    throw new Error(`AtomGit tag ${tagName} was not found.`);
  }
  console.log(`AtomGit tag is ready: ${tagName}`);
  await publishAtomGitRelease({
    owner,
    repo,
    token,
    tagName,
    name: releaseName,
    body: releaseBody,
    releaseStatus,
  });

  console.log(`AtomGit Release metadata published: ${owner}/${repo}@${tagName}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
