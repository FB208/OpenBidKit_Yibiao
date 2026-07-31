import fs from 'node:fs/promises';
import path from 'node:path';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';
const TAG_SYNC_TIMEOUT_SECONDS = 600;
const TAG_SYNC_POLL_INTERVAL_SECONDS = 10;

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

/** 等待指定时长。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** 获取需要同步的全部 GitHub Release 附件。 */
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
  url.searchParams.set('access_token', token);
  for (const [name, value] of Object.entries(query || {})) {
    url.searchParams.set(name, String(value));
  }

  const headers = {
    Accept: 'application/json',
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
      ? data?.message || data?.error || data?.msg
      : data;
    throw new Error(
      `AtomGit API ${method} ${apiPath} failed: ${response.status} ${message || response.statusText}`,
    );
  }
  return data;
}

/** 检查 AtomGit 镜像中是否已有目标 tag。 */
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

/** 等待仓库镜像完成目标 tag 同步。 */
async function waitForAtomGitTag({ owner, repo, token, tagName }) {
  const deadline = Date.now() + TAG_SYNC_TIMEOUT_SECONDS * 1000;
  while (Date.now() <= deadline) {
    if (await hasAtomGitTag({ owner, repo, token, tagName })) {
      console.log(`AtomGit tag is ready: ${tagName}`);
      return;
    }
    console.log(`Waiting for AtomGit tag: ${tagName}`);
    await sleep(TAG_SYNC_POLL_INTERVAL_SECONDS * 1000);
  }
  throw new Error(`AtomGit tag ${tagName} was not found after ${TAG_SYNC_TIMEOUT_SECONDS} seconds.`);
}

/** 根据 tag 查询已有 AtomGit Release。 */
async function getAtomGitReleaseByTag({ owner, repo, token, tagName }) {
  return atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
    allow404: true,
  });
}

/** 创建新的 AtomGit Release。 */
async function createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const release = await atomGitRequest({
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
  return release;
}

/** 更新已有 AtomGit Release。 */
async function updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const release = await atomGitRequest({
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
  return release;
}

/** 创建或更新 Release，并保留更新前的附件清单。 */
async function publishAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const existingRelease = await getAtomGitReleaseByTag({ owner, repo, token, tagName });
  if (existingRelease) {
    await updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
    return existingRelease;
  }
  await createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
  return null;
}

/** 删除需要被本次同步覆盖的同名旧附件。 */
async function deleteReplacedAssets({ owner, repo, token, tagName, existingRelease, assetFiles }) {
  const targetNames = new Set(assetFiles.map((filePath) => path.basename(filePath)));
  const replacedAssets = (existingRelease?.assets || [])
    .filter((asset) => targetNames.has(String(asset?.name || '')));

  for (const asset of replacedAssets) {
    if (asset.id === undefined || asset.id === null) {
      throw new Error(`AtomGit attachment ${asset.name} does not contain an id.`);
    }
    await atomGitRequest({
      owner,
      repo,
      token,
      apiPath: `/releases/${encodePathSegment(tagName)}/attach_files/${encodePathSegment(asset.id)}`,
      method: 'DELETE',
    });
    console.log(`Deleted existing AtomGit attachment: ${asset.name}`);
  }
}

/** 使用 AtomGit 返回的预签名地址上传单个附件。 */
async function uploadAsset({ owner, repo, token, tagName, filePath }) {
  const fileName = path.basename(filePath);
  const upload = await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}/upload_url`,
    query: { file_name: fileName },
  });

  if (!upload?.url) {
    throw new Error(`AtomGit did not return an upload URL for ${fileName}.`);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(upload.headers || {})) {
    headers.set(name, Array.isArray(value) ? value.join(',') : String(value));
  }

  const content = await fs.readFile(filePath);
  const response = await fetch(upload.url, {
    method: 'PUT',
    headers,
    body: content,
  });
  const responseText = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `AtomGit attachment upload failed for ${fileName}: ${response.status} ${responseText || response.statusText}`,
    );
  }
  console.log(`Uploaded AtomGit attachment: ${fileName}`);
}

/** 执行完整的 AtomGit Release 同步。 */
async function main() {
  const token = requireEnv('ATOMGIT_ACCESS_TOKEN');
  const owner = requireEnv('ATOMGIT_OWNER');
  const repo = requireEnv('ATOMGIT_REPO');
  const tagName = requireEnv('TAG_NAME');
  const assetsDir = requireEnv('RELEASE_ASSETS_DIR');
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');

  const githubRelease = await readGithubRelease(releaseJsonPath, tagName);
  const assetFiles = await listAssetFiles(assetsDir);
  const releaseName = String(githubRelease.name || githubRelease.tagName || tagName);
  const releaseBody = String(githubRelease.body || '');
  const releaseStatus = githubRelease.isPrerelease ? 'pre' : 'latest';

  await waitForAtomGitTag({ owner, repo, token, tagName });
  const existingRelease = await publishAtomGitRelease({
    owner,
    repo,
    token,
    tagName,
    name: releaseName,
    body: releaseBody,
    releaseStatus,
  });
  await deleteReplacedAssets({ owner, repo, token, tagName, existingRelease, assetFiles });

  console.log(`Uploading ${assetFiles.length} AtomGit Release attachments.`);
  for (const filePath of assetFiles) {
    await uploadAsset({ owner, repo, token, tagName, filePath });
  }

  console.log(`AtomGit Release published: ${owner}/${repo}@${tagName}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
