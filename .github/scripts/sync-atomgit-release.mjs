import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';
const ASSET_CONCURRENCY = 3;
const UPLOAD_MAX_ATTEMPTS = 3;
const RETRYABLE_UPLOAD_STATUSES = new Set([502, 503, 504]);
const ATOMGIT_PROXY_IP = '159.138.147.37';
const ATOMGIT_PROXY_HOSTS = ['api.atomgit.com', 'file.atomgit.com', 'file.gitcode.com'];

/** 在当前构建 Runner 配置文章提供的 AtomGit 入口，支持 Windows/macOS/Linux。 */
async function configureHosts() {
  const entries = `\n${ATOMGIT_PROXY_HOSTS.map((host) => `${ATOMGIT_PROXY_IP} ${host}`).join('\n')}\n`;
  if (process.platform === 'win32') {
    await fs.appendFile(path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts'), entries, 'utf-8');
  } else {
    execFileSync('sudo', ['tee', '-a', '/etc/hosts'], {
      input: entries,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  }
  await Promise.all(ATOMGIT_PROXY_HOSTS.map(async (host) => {
    const { address } = await lookup(host, { family: 4 });
    if (address !== ATOMGIT_PROXY_IP) {
      throw new Error(`AtomGit hosts entry did not take effect: ${host} -> ${address}`);
    }
    console.log(`AtomGit hosts: ${host} -> ${address}`);
  }));
}

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

/** 仅推送本次 tag，避免准备 Release 时依赖另一个工作流的执行时序。 */
function pushAtomGitTag({ owner, repo, token, tagName }) {
  execFileSync('git', [
    'push',
    `https://atomgit.com/${encodePathSegment(owner)}/${encodePathSegment(repo)}.git`,
    `refs/tags/${tagName}:refs/tags/${tagName}`,
  ], {
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://atomgit.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner}:${token}`, 'utf8').toString('base64')}`,
      GIT_TERMINAL_PROMPT: '0',
    },
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

/** 创建或更新 AtomGit Release 元数据。 */
async function publishAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus, existingRelease }) {
  if (existingRelease) {
    await updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
    return;
  }
  await createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
}

/** 读取真实上传附件名称，排除平台自动生成的源码压缩包。 */
function getExistingAssetNames(release) {
  return new Set((release?.assets || [])
    .filter((asset) => asset.type !== 'source')
    .map((asset) => asset.name));
}

/** 每十秒报告一次传输进度，完成时记录总耗时和平均速度。 */
function createTransferProgress(action, asset) {
  const startedAt = performance.now();
  let lastReportedAt = startedAt;
  let transferredBytes = 0;

  function report(completed) {
    const now = performance.now();
    const seconds = Math.max((now - startedAt) / 1000, 0.001);
    const megabytes = transferredBytes / 1024 / 1024;
    const totalMegabytes = asset.size / 1024 / 1024;
    console.log(
      `[${action}] ${asset.name}: ${megabytes.toFixed(2)}/${totalMegabytes.toFixed(2)} MiB, `
      + `${seconds.toFixed(1)}s, ${(megabytes / seconds).toFixed(2)} MiB/s${completed ? ' (completed)' : ''}`,
    );
    lastReportedAt = now;
  }

  return {
    addBytes(bytes) {
      transferredBytes += bytes;
      if (performance.now() - lastReportedAt >= 10_000) {
        report(false);
      }
    },
    finish() {
      report(true);
    },
  };
}

/** 分块传递文件并记录进度，不将整个安装包加载到内存。 */
async function* trackTransfer(source, progress) {
  for await (const chunk of source) {
    progress.addBytes(chunk.byteLength);
    yield chunk;
  }
}

/** 保留上传错误正文中的诊断信息，隐藏地址与临时凭据。 */
function summarizeUploadError(text, uploadTarget, token) {
  let summary = text.replace(/https?:\/\/[^\s<>"']+/gi, '[url omitted]');
  const secrets = [token, ...Object.values(uploadTarget.headers || {}),
    ...new URL(uploadTarget.url).searchParams.values()];
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      summary = summary.replaceAll(secret, '[redacted]');
    }
  }
  return summary.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** 获取本次上传地址并重新打开文件流，携带接口返回的请求头执行 PUT。 */
async function uploadAtomGitAssetOnce({ owner, repo, token, tagName, asset, filePath, attempt }) {
  const uploadTarget = await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}/upload_url`,
    query: { file_name: asset.name },
  });
  if (!uploadTarget?.url) {
    throw new Error(`AtomGit did not return an upload URL for ${asset.name}.`);
  }
  // 只记录域名；完整上传地址和返回的请求头可能包含临时凭据。
  console.log(`Uploading AtomGit asset: ${asset.name} -> ${new URL(uploadTarget.url).hostname} (attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS})`);
  const headers = new Headers(uploadTarget.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', asset.contentType || 'application/octet-stream');
  }
  headers.set('Content-Length', String(asset.size));
  const progress = createTransferProgress('upload', asset);
  const body = Readable.from(trackTransfer(createReadStream(filePath), progress));
  try {
    const response = await fetch(uploadTarget.url, {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
    });
    if (!response.ok) {
      const detail = summarizeUploadError(await response.text(), uploadTarget, token);
      const server = response.headers.get('server');
      const requestId = response.headers.get('x-obs-request-id') || response.headers.get('x-request-id');
      const diagnostics = [server && `server=${server}`, requestId && `request-id=${requestId}`, detail]
        .filter(Boolean).join('; ');
      throw Object.assign(new Error(
        `AtomGit upload failed for ${asset.name}: HTTP ${response.status}${diagnostics ? `; ${diagnostics}` : ''}`,
      ), { status: response.status });
    }
    await response.body?.cancel();
    progress.finish();
  } finally {
    body.destroy();
  }
}

/** 仅重试上传服务的临时网关错误；重试前确认远端是否已收到附件。 */
async function uploadAtomGitAsset({ asset, filePath, ...atomGit }) {
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await uploadAtomGitAssetOnce({ ...atomGit, asset, filePath, attempt });
      return;
    } catch (error) {
      if (!RETRYABLE_UPLOAD_STATUSES.has(error.status) || attempt === UPLOAD_MAX_ATTEMPTS) {
        throw error;
      }
      const delayMs = attempt * 3_000;
      console.warn(`${error.message}; checking before retry ${attempt + 1}/${UPLOAD_MAX_ATTEMPTS} in ${delayMs / 1000}s`);
      await delay(delayMs);
      const release = await getAtomGitReleaseByTag(atomGit);
      if (getExistingAssetNames(release).has(asset.name)) {
        console.log(`AtomGit asset confirmed after upload error: ${asset.name}`);
        return;
      }
    }
  }
}

/** 从构建目录并发上传附件；失败后停止领取新附件并等待在途任务结束。 */
async function syncAssets({ filePaths, existingNames, ...atomGit }) {
  let nextIndex = 0;
  let failure = null;
  let uploaded = 0;
  let skipped = 0;

  /** 领取下一个本地产物，已有同名附件直接跳过。 */
  async function worker() {
    while (!failure && nextIndex < filePaths.length) {
      const filePath = filePaths[nextIndex++];
      const name = path.basename(filePath);
      try {
        if (existingNames.has(name)) {
          console.log(`Skipping existing AtomGit asset: ${name}`);
          skipped += 1;
          continue;
        }
        const { size } = await fs.stat(filePath);
        const asset = { name, size };
        await uploadAtomGitAsset({ ...atomGit, asset, filePath });
        uploaded += 1;
      } catch (error) {
        failure ||= error;
        console.error(`Asset sync failed: ${name}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, filePaths.length) }, () => worker()));
  if (failure) {
    throw failure;
  }
  console.log(`AtomGit assets uploaded=${uploaded}, skipped=${skipped}, concurrency=${ASSET_CONCURRENCY}`);
}

/** 所有平台完成后核对完整附件，再发布最终版本状态及工作流摘要。 */
async function finalizeRelease({ githubRelease, ...atomGit }) {
  const manifest = JSON.parse(await fs.readFile(requireEnv('RELEASE_ASSET_MANIFEST'), 'utf-8'));
  const release = await getAtomGitReleaseByTag(atomGit);
  const existingNames = getExistingAssetNames(release);
  const missing = manifest.files.filter((asset) => !existingNames.has(asset.name));
  if (missing.length > 0) {
    throw new Error(`AtomGit Release is missing assets: ${missing.map((asset) => asset.name).join(', ')}`);
  }
  await publishAtomGitRelease({
    ...atomGit,
    existingRelease: release,
    name: githubRelease.name || atomGit.tagName,
    body: githubRelease.body || '',
    releaseStatus: githubRelease.isPrerelease ? 'pre' : 'latest',
  });
  const releaseUrl = `https://atomgit.com/${encodePathSegment(atomGit.owner)}/${encodePathSegment(atomGit.repo)}/releases/${encodePathSegment(atomGit.tagName)}`;
  const summary = `AtomGit Release synchronized: ${atomGit.tagName}; assets=${manifest.files.length}`;
  console.log(summary);
  console.log(`AtomGit Release: ${releaseUrl}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n[AtomGit Release](${releaseUrl})\n`, 'utf-8');
  }
}

/** 分别执行 Runner 配置、Release 准备、本地产物上传和最终发布。 */
async function main() {
  const mode = process.argv[2];
  if (mode === '--configure-hosts') {
    await configureHosts();
    return;
  }
  const token = requireEnv('ATOMGIT_ACCESS_TOKEN');
  const owner = requireEnv('ATOMGIT_OWNER');
  const repo = requireEnv('ATOMGIT_REPO');
  const tagName = requireEnv('TAG_NAME');
  const atomGit = { owner, repo, token, tagName };
  if (mode === '--upload') {
    const filePaths = process.argv.slice(3);
    if (filePaths.length === 0) {
      throw new Error('No local AtomGit release assets supplied.');
    }
    const release = await getAtomGitReleaseByTag(atomGit);
    if (!release) {
      throw new Error(`AtomGit Release ${tagName} has not been prepared.`);
    }
    await syncAssets({ ...atomGit, filePaths, existingNames: getExistingAssetNames(release) });
    return;
  }
  if (mode !== '--prepare' && mode !== '--finalize') {
    throw new Error('Expected --configure-hosts, --prepare, --upload <files...> or --finalize.');
  }

  const githubRelease = await readGithubRelease(requireEnv('GITHUB_RELEASE_JSON'), tagName);
  if (githubRelease.tagName !== tagName || githubRelease.isDraft) {
    throw new Error(`GitHub Release must be published and match tag ${tagName}.`);
  }
  if (mode === '--finalize') {
    await finalizeRelease({ ...atomGit, githubRelease });
    return;
  }
  pushAtomGitTag(atomGit);
  const existingRelease = await getAtomGitReleaseByTag(atomGit);
  // 新版本先准备为预发布状态，全部附件就绪后才标记为正式版；重跑不降级已有版本。
  await publishAtomGitRelease({
    ...atomGit,
    name: githubRelease.name || tagName,
    body: githubRelease.body || '',
    releaseStatus: existingRelease ? existingRelease.release_status : 'pre',
    existingRelease,
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
