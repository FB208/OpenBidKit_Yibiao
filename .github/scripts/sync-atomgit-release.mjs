import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';
const UPLOAD_CHUNK_SIZE = 1024 * 1024;
const UPLOAD_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

/** 根据附件扩展名返回上传内容类型。 */
function contentTypeFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'application/x-yaml';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

/** 按大小写不敏感规则设置上传请求头。 */
function setRequestHeader(headers, name, value) {
  const existingName = Object.keys(headers)
    .find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  headers[existingName || name] = String(value);
}

/** 检查 AtomGit 返回的上传请求头是否包含指定字段。 */
function hasRequestHeader(headers, name) {
  return Object.keys(headers)
    .some((headerName) => headerName.toLowerCase() === name.toLowerCase());
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

/** 创建或更新 AtomGit Release，并返回更新前的数据。 */
async function publishAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const existingRelease = await getAtomGitReleaseByTag({ owner, repo, token, tagName });
  if (existingRelease) {
    await updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
    return existingRelease;
  }
  await createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
  return null;
}

/** 删除本次同步将替换的同名旧附件。 */
async function deleteReplacedAssets({ owner, repo, token, tagName, existingRelease, assetFiles }) {
  const targetNames = new Set(assetFiles.map((filePath) => path.basename(filePath)));
  const replacedAssets = (existingRelease?.assets || [])
    .filter((asset) => targetNames.has(String(asset?.name || '')));

  for (const asset of replacedAssets) {
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

/** 使用预签名地址流式上传单个附件。 */
function uploadFile({ uploadUrl, suppliedHeaders, filePath, fileSize }) {
  const target = new URL(uploadUrl);
  if (target.protocol !== 'https:') {
    throw new Error(`Unsupported AtomGit upload protocol: ${target.protocol}`);
  }

  const fileName = path.basename(filePath);
  const headers = {};
  for (const [name, value] of Object.entries(suppliedHeaders || {})) {
    headers[name] = Array.isArray(value) ? value.join(',') : String(value);
  }
  if (!hasRequestHeader(headers, 'Content-Type')) {
    setRequestHeader(headers, 'Content-Type', contentTypeFromFileName(fileName));
  }
  setRequestHeader(headers, 'Content-Length', fileSize);

  return new Promise((resolve, reject) => {
    let settled = false;
    let uploadedBytes = 0;
    let nextProgress = 10;
    const source = createReadStream(filePath, { highWaterMark: UPLOAD_CHUNK_SIZE });
    const request = httpsRequest(target, { method: 'PUT', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('error', fail);
      response.on('end', () => {
        finish({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    /** 完成上传请求。 */
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    /** 终止上传并返回错误。 */
    function fail(error) {
      if (settled) return;
      settled = true;
      source.destroy();
      reject(error);
    }

    request.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`AtomGit upload timed out: ${fileName}`));
    });
    request.on('error', fail);
    source.on('error', (error) => request.destroy(error));
    source.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const percent = fileSize > 0 ? Math.floor(uploadedBytes * 100 / fileSize) : 100;
      if (percent >= nextProgress) {
        console.log(`AtomGit upload progress: ${fileName} ${Math.min(percent, 100)}%.`);
        nextProgress += 10;
      }
    });
    source.pipe(request);
  });
}

/** 获取预签名地址并上传一个 AtomGit Release 附件。 */
async function uploadAsset({ owner, repo, token, tagName, filePath }) {
  const fileName = path.basename(filePath);
  const { size: fileSize } = await fs.stat(filePath);
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

  console.log(`Uploading AtomGit attachment: ${fileName}`);
  const response = await uploadFile({
    uploadUrl: upload.url,
    suppliedHeaders: upload.headers,
    filePath,
    fileSize,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `AtomGit attachment upload failed: ${response.status} ${response.text || response.statusText}`,
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
