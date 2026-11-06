const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { net } = require('electron');
const { getNoticeCacheDir } = require('../utils/paths.cjs');

/** 将项目和版本分别映射为固定目录名，不受中文或 URL 字符影响。 */
function cacheSegment(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 仅缓存当前自动公告；占用令牌保护准备中和显示中的媒体。 */
function createNoticeMediaCacheService({ app }) {
  const root = getNoticeCacheDir(app);
  const current = new Map();
  const leases = new Map();
  const downloads = new Map();
  const deletions = new Map();

  /** 获取项目、版本对应的缓存目录与协议地址。 */
  function location(projectName, noticeId) {
    const project = cacheSegment(projectName);
    const version = cacheSegment(noticeId);
    return { project, version, key: `${project}/${version}`, dir: path.join(root, project, version) };
  }

  /** 判断目录是否仍由当前公告、下载或展示持有。 */
  function isInUse(projectName, key) {
    return current.get(projectName)?.key === key
      || downloads.has(key)
      || Array.from(leases.values()).some((lease) => lease.key === key);
  }

  /** 尽力清除历史版本；删除失败不干扰当前下载与展示。 */
  async function cleanup(projectName) {
    const projectDir = path.join(root, cacheSegment(projectName));
    const entries = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = `${cacheSegment(projectName)}/${entry.name}`;
      if (isInUse(projectName, key) || deletions.has(key)) continue;
      const deletion = fsp.rm(path.join(projectDir, entry.name), { recursive: true, force: true })
        .catch(() => undefined)
        .finally(() => deletions.delete(key));
      deletions.set(key, deletion);
    }
  }

  /** 同步服务端版本，取消过期下载；文字公告不等待磁盘清理。 */
  function syncCurrent({ projectName, noticeId }) {
    const target = noticeId ? location(projectName, noticeId) : null;
    current.set(projectName, target);
    for (const [key, download] of downloads) {
      if (download.projectName === projectName && key !== target?.key) download.controller.abort();
    }
    void cleanup(projectName);
  }

  /** 释放某次准备／展示占用；过期目录随后可以删除。 */
  function releaseMedia(leaseId) {
    const lease = leases.get(leaseId);
    if (!lease) return;
    leases.delete(leaseId);
    const download = downloads.get(lease.key);
    if (download && !Array.from(leases.values()).some((item) => item.key === lease.key)) {
      download.controller.abort();
    }
    void cleanup(lease.projectName);
  }

  /** 页面刷新或窗口销毁时，释放该 Renderer 尚未归还的占用。 */
  function releaseOwner(ownerId) {
    for (const [leaseId, lease] of leases) {
      if (lease.ownerId === ownerId) releaseMedia(leaseId);
    }
  }

  /** 完成记录和文件大小同时匹配时才复用，半文件永远不用于显示。 */
  async function readCompleted(target, media) {
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(target.dir, 'complete.json'), 'utf8'));
      const stat = await fsp.stat(path.join(target.dir, 'media'));
      return manifest.url === media.url && manifest.kind === media.kind
        && stat.isFile() && stat.size > 0 && stat.size === manifest.byteLength;
    } catch {
      return false;
    }
  }

  /** 流式下载整份媒体，最后提交完成清单；不占用 Renderer 大块内存。 */
  async function downloadMedia(target, request, signal) {
    const { projectName, noticeId, media } = request;
    await deletions.get(target.key);
    signal.throwIfAborted();
    if (await readCompleted(target, media)) return;
    signal.throwIfAborted();
    await fsp.mkdir(target.dir, { recursive: true });
    const temporary = path.join(target.dir, 'media.part');
    const manifestTemporary = path.join(target.dir, 'complete.json.part');
    try {
      await fsp.rm(path.join(target.dir, 'complete.json'), { force: true });
      const response = await net.fetch(media.url, { signal, cache: 'no-store' });
      if (!response.ok || response.status === 206 || !response.body) {
        throw new Error(`公告媒体下载失败：HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary), { signal });
      const stat = await fsp.stat(temporary);
      if (!stat.size) throw new Error('公告媒体内容为空');
      signal.throwIfAborted();
      if (current.get(projectName)?.key !== target.key) throw new Error('公告版本已更新');
      await fsp.rename(temporary, path.join(target.dir, 'media'));
      const manifest = {
        projectName, noticeId, ...media,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        byteLength: stat.size,
      };
      await fsp.writeFile(manifestTemporary, JSON.stringify(manifest), 'utf8');
      signal.throwIfAborted();
      await fsp.rename(manifestTemporary, path.join(target.dir, 'complete.json'));
    } finally {
      await Promise.all([temporary, manifestTemporary].map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
    }
  }

  /** 准备当前版本并取得占用令牌；同版本并发请求共享下载。 */
  async function prepareMedia(request, ownerId) {
    const target = location(request.projectName, request.noticeId);
    if (current.get(request.projectName)?.key !== target.key) throw new Error('公告版本已更新');
    const leaseId = randomUUID();
    leases.set(leaseId, { key: target.key, projectName: request.projectName, ownerId });
    try {
      let download = downloads.get(target.key);
      // 上一个使用者已取消时，先等临时文件清理完再重新下载。
      if (download?.controller.signal.aborted) {
        await download.promise.catch(() => undefined);
        download = downloads.get(target.key);
      }
      if (!leases.has(leaseId) || current.get(request.projectName)?.key !== target.key) {
        throw new Error('公告媒体准备已取消');
      }
      if (!download) {
        const controller = new AbortController();
        download = { projectName: request.projectName, controller, promise: null };
        download.promise = downloadMedia(target, request, controller.signal).finally(() => {
          downloads.delete(target.key);
          void cleanup(request.projectName);
        });
        downloads.set(target.key, download);
      }
      await download.promise;
      if (!leases.has(leaseId) || current.get(request.projectName)?.key !== target.key) {
        throw new Error('公告媒体准备已取消');
      }
      return { url: `yibiao-asset://notice-cache/${target.key}/media`, leaseId };
    } catch (error) {
      releaseMedia(leaseId);
      throw error;
    }
  }

  /** 退出应用时终止下载，完成临时文件清理。 */
  async function close() {
    for (const download of downloads.values()) download.controller.abort();
    await Promise.allSettled(Array.from(downloads.values(), (item) => item.promise));
    leases.clear();
  }

  return { syncCurrent, prepareMedia, releaseMedia, releaseOwner, close };
}

module.exports = { createNoticeMediaCacheService };
