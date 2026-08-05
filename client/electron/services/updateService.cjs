const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const GITHUB_RELEASE_API = 'https://api.github.com/repos/FB208/OpenBidKit_Yibiao/releases/latest';
const GITHUB_RELEASE_DOWNLOAD_URL = 'https://github.com/FB208/OpenBidKit_Yibiao/releases/latest';
const GITHUB_PROVIDER_OPTIONS = {
  provider: 'github',
  owner: 'FB208',
  repo: 'OpenBidKit_Yibiao',
  releaseType: 'release',
};
const CLOUDFLARE_RELEASE_BASE_URL = 'https://openbidkit-oss.agnet.top/release';
const CLOUDFLARE_LATEST_JSON_URL = `${CLOUDFLARE_RELEASE_BASE_URL}/latest.json`;
const ATOMGIT_REPOSITORY_URL = 'https://atomgit.com/FB208/OpenBidKit_Yibiao';
const ATOMGIT_RELEASE_API_BASE_URL = 'https://api.atomgit.com/api/v5/repos/FB208/OpenBidKit_Yibiao/releases';
const ATOMGIT_LATEST_RELEASE_API = `${ATOMGIT_RELEASE_API_BASE_URL}/latest`;

let autoUpdaterInstance = null;
let downloadedUpdateVersion = '';
let downloadedUpdateChannel = '';
let downloadedUpdateFilePath = '';
let activeUpdateCheckPromise = null;

// 将版本号拆分为核心版本和 SemVer 预发布标识。
function parseVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '').split('+')[0];
  const separatorIndex = normalized.indexOf('-');
  const core = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1 ? [] : normalized.slice(separatorIndex + 1).split('.');
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease,
  };
}

// 按 SemVer 规则比较单个预发布标识。
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

// 比较两个版本号，正式版高于相同核心版本的测试版。
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const na = pa.core[i] || 0;
    const nb = pb.core[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i += 1) {
    const partA = pa.prerelease[i];
    const partB = pb.prerelease[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const result = comparePrereleaseIdentifier(partA, partB);
    if (result !== 0) return result;
  }
  return 0;
}

function normalizeUpdateChannel(value) {
  if (value === 'cloudflare' || value === 'atomgit') {
    return value;
  }
  return 'atomgit';
}

function getUpdateChannel(configStore) {
  if (!configStore) {
    return 'atomgit';
  }
  const config = configStore.load();
  return normalizeUpdateChannel(config.update_channel);
}

function requestJson(url, label, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'yibiao-client', ...headers } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(new URL(response.headers.location, url).toString(), label, headers).then(resolve, reject);
        return;
      }

      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${label}请求失败：${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`解析${label}响应失败`));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('请求超时'));
    });
  });
}

async function fetchGithubLatestRelease() {
  const release = await requestJson(GITHUB_RELEASE_API, 'GitHub API ');
  const files = Array.isArray(release.assets)
    ? release.assets.map((asset) => ({
      name: asset.name || '',
      url: asset.browser_download_url || '',
      size: Number(asset.size || 0),
      digest: asset.digest || '',
    }))
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'github',
    version: release.tag_name?.replace(/^v/, '') || '',
    name: release.name || '',
    body: release.body || '',
    published_at: release.published_at || '',
    html_url: release.html_url || GITHUB_RELEASE_DOWNLOAD_URL,
    download_url: downloadFile?.url || GITHUB_RELEASE_DOWNLOAD_URL,
    files,
  };
}

function getMacUpdateArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function pickMacDmgFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  const arch = getMacUpdateArch();
  return validFiles.find((file) => new RegExp(`-mac-${arch}\\.dmg$`, 'i').test(file.name))
    || validFiles.find((file) => /-mac-(?:x64|arm64)\.dmg$/i.test(file.name))
    || validFiles.find((file) => /\.dmg$/i.test(file.name));
}

function pickPlatformDownloadFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.zip$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    const arch = getMacUpdateArch();
    return pickMacDmgFile(validFiles)
      || validFiles.find((file) => new RegExp(`-mac-${arch}\\.zip$`, 'i').test(file.name))
      || validFiles.find((file) => /-mac-(?:x64|arm64)\.zip$/i.test(file.name));
  }
  return null;
}

// 选择下载后可直接启动的系统安装程序。
function pickPlatformInstallerFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    return pickMacDmgFile(validFiles);
  }
  return null;
}

async function fetchCloudflareLatestRelease() {
  const release = await requestJson(CLOUDFLARE_LATEST_JSON_URL, 'Cloudflare 更新源 ');
  const files = Array.isArray(release.files)
    ? release.files.map((file) => ({
      name: file.name || '',
      url: file.url || '',
      size: Number(file.size || 0),
      contentType: file.contentType || '',
    }))
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'cloudflare',
    version: String(release.version || release.tagName || '').replace(/^v/i, ''),
    name: release.name || release.tagName || '',
    body: release.body || '',
    published_at: release.generatedAt || '',
    html_url: CLOUDFLARE_RELEASE_BASE_URL,
    download_url: downloadFile?.url || CLOUDFLARE_RELEASE_BASE_URL,
    files,
  };
}

// 创建无需客户端令牌的 AtomGit Release 附件下载地址。
function createAtomGitAssetDownloadUrl(tagName, fileName) {
  return `${ATOMGIT_RELEASE_API_BASE_URL}/${encodeURIComponent(tagName)}/attach_files/${encodeURIComponent(fileName)}/download`;
}

// 获取 AtomGit 最新 Release 及可下载附件。
async function fetchAtomGitLatestRelease() {
  const release = await requestJson(ATOMGIT_LATEST_RELEASE_API, 'AtomGit API ');
  const tagName = String(release.tag_name || '');
  const files = Array.isArray(release.assets)
    ? release.assets.map((asset) => {
      const name = String(asset.name || '');
      return {
        name,
        url: tagName && name
          ? createAtomGitAssetDownloadUrl(tagName, name)
          : String(asset.browser_download_url || ''),
        size: Number(asset.size || 0),
      };
    })
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'atomgit',
    version: tagName.replace(/^v/i, ''),
    name: release.name || tagName,
    body: release.body || '',
    published_at: release.created_at || '',
    html_url: ATOMGIT_REPOSITORY_URL,
    download_url: downloadFile?.url || ATOMGIT_REPOSITORY_URL,
    files,
  };
}

function fetchLatestRelease(channel) {
  if (channel === 'cloudflare') return fetchCloudflareLatestRelease();
  if (channel === 'atomgit') return fetchAtomGitLatestRelease();
  return fetchGithubLatestRelease();
}

async function getLatestVersion(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  return fetchLatestRelease(channel);
}

async function getUpdateDownloadUrl(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  if (channel === 'cloudflare') {
    try {
      const release = await fetchCloudflareLatestRelease();
      return release.download_url || CLOUDFLARE_RELEASE_BASE_URL;
    } catch (error) {
      console.warn('[update] Cloudflare 下载地址获取失败，回退到 GitHub Release', error);
      return GITHUB_RELEASE_DOWNLOAD_URL;
    }
  }
  if (channel === 'atomgit') {
    try {
      const release = await fetchAtomGitLatestRelease();
      return release.download_url || ATOMGIT_REPOSITORY_URL;
    } catch (error) {
      console.warn('[update] AtomGit 下载地址获取失败', error);
      return ATOMGIT_REPOSITORY_URL;
    }
  }
  return GITHUB_RELEASE_DOWNLOAD_URL;
}

function configureAutoUpdater(channel) {
  if (!autoUpdaterInstance) {
    return;
  }
  if (channel === 'cloudflare') {
    autoUpdaterInstance.setFeedURL({ provider: 'generic', url: CLOUDFLARE_RELEASE_BASE_URL });
    return;
  }
  autoUpdaterInstance.setFeedURL(GITHUB_PROVIDER_OPTIONS);
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function setProgressBar(mainWindow, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setProgressBar(progress);
}

function getDisabledResult() {
  return { enabled: false, updateAvailable: false };
}

function sanitizeDownloadFileName(fileName, fallback) {
  const normalized = String(fileName || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();
  const baseName = path.basename(normalized);
  return baseName && baseName !== '.' && baseName !== '..' ? baseName : fallback;
}

function getManualUpdateDownloadPath(app, release, file) {
  const platformSuffix = process.platform === 'win32' ? 'win-x64.exe' : `mac-${getMacUpdateArch()}.dmg`;
  const fallbackName = `Yibiao-${release.version || 'update'}-${platformSuffix}`;
  const fileName = sanitizeDownloadFileName(file?.name, fallbackName);
  return path.join(app.getPath('userData'), 'updates', fileName);
}

function isDownloadedFileReady(filePath, expectedSize = 0) {
  if (!filePath) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && (!expectedSize || stat.size === expectedSize);
  } catch {
    return false;
  }
}

function requestModuleForUrl(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new Error(`不支持的下载地址协议：${url.protocol}`);
}

function downloadFile(url, destinationPath, options = {}, redirectCount = 0) {
  const { expectedSize = 0, onProgress } = options;
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('更新包下载地址无效'));
      return;
    }

    let settled = false;
    let tempPath = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
      }
      reject(error);
    };

    let request;
    try {
      request = requestModuleForUrl(parsedUrl).get(parsedUrl, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= 5) {
            fail(new Error('更新包下载重定向次数过多'));
            return;
          }
          downloadFile(new URL(response.headers.location, parsedUrl).toString(), destinationPath, options, redirectCount + 1)
            .then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`更新包下载失败：${response.statusCode}`));
          return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
        const output = fs.createWriteStream(tempPath);
        const total = Number(response.headers['content-length'] || expectedSize || 0);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            onProgress?.(Math.max(0, Math.min(100, (downloaded / total) * 100)));
          }
        });
        response.on('error', fail);
        output.on('error', fail);
        output.on('finish', () => {
          output.close(() => {
            try {
              fs.rmSync(destinationPath, { force: true });
              fs.renameSync(tempPath, destinationPath);
              tempPath = '';
              if (expectedSize && fs.statSync(destinationPath).size !== expectedSize) {
                throw new Error('更新包下载不完整，请重新检查更新');
              }
              onProgress?.(100);
              settled = true;
              resolve(destinationPath);
            } catch (error) {
              if (!tempPath) {
                try { fs.rmSync(destinationPath, { force: true }); } catch {}
              }
              fail(error);
            }
          });
        });

        response.pipe(output);
      });
    } catch (error) {
      fail(error);
      return;
    }

    request.on('error', fail);
    request.setTimeout(60000, () => {
      request.destroy(new Error('下载更新包超时'));
    });
  });
}

// 下载可由系统直接启动的 Windows 或 macOS 更新安装包。
async function runManualInstallerUpdateCheck(options, release, channel) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const installerFile = pickPlatformInstallerFile(release.files);
  if (!installerFile) {
    const platformLabel = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : '当前系统';
    const message = `未找到适用于 ${platformLabel} 的更新安装包`;
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }

  const destinationPath = getManualUpdateDownloadPath(app, release, installerFile);
  const expectedSize = Number(installerFile.size || 0);

  try {
    if (isDownloadedFileReady(destinationPath, expectedSize)) {
      downloadedUpdateVersion = release.version;
      downloadedUpdateChannel = channel;
      downloadedUpdateFilePath = destinationPath;
      onDownloaded?.(release.version);
      return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
    }

    setProgressBar(mainWindow, 0);
    await downloadFile(installerFile.url, destinationPath, {
      expectedSize,
      onProgress: (percent) => {
        setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
        onProgress?.(percent);
      },
    });

    downloadedUpdateVersion = release.version;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = destinationPath;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(release.version);
    return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    setProgressBar(mainWindow, -1);
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }
}

async function runUpdateCheck(options = {}) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const channel = getUpdateChannel(options.configStore);
  const release = await fetchLatestRelease(channel);
  if (!release.version || compareVersions(release.version, app.getVersion()) <= 0) {
    return { enabled: true, updateAvailable: false, channel };
  }
  if (process.platform === 'darwin' || channel === 'atomgit') {
    return runManualInstallerUpdateCheck(options, release, channel);
  }
  configureAutoUpdater(channel);
  downloadedUpdateFilePath = '';
  if (!autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }

  let downloadedVersion = release.version;
  let downloadedNotified = false;
  let errorNotified = false;
  const notifyError = (message) => {
    if (errorNotified) {
      return;
    }
    errorNotified = true;
    onError?.(message);
  };

  const handleProgress = (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
    onProgress?.(percent);
  };

  const handleDownloaded = (info) => {
    downloadedVersion = info?.version || release.version;
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    downloadedNotified = true;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(downloadedVersion);
  };

  const handleError = (error) => {
    setProgressBar(mainWindow, -1);
    notifyError(formatErrorMessage(error));
  };

  autoUpdaterInstance.on('download-progress', handleProgress);
  autoUpdaterInstance.on('update-downloaded', handleDownloaded);
  autoUpdaterInstance.on('error', handleError);

  try {
    const result = await autoUpdaterInstance.checkForUpdates();
    if (!result) {
      throw new Error('未找到可下载的更新包');
    }

    await autoUpdaterInstance.downloadUpdate();
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
    if (!downloadedNotified) {
      onDownloaded?.(downloadedVersion);
    }
    return { enabled: true, updateAvailable: true, version: downloadedVersion, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    notifyError(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  } finally {
    autoUpdaterInstance.removeListener('download-progress', handleProgress);
    autoUpdaterInstance.removeListener('update-downloaded', handleDownloaded);
    autoUpdaterInstance.removeListener('error', handleError);
    setProgressBar(mainWindow, -1);
  }
}

async function checkAndDownloadUpdate(options = {}) {
  const { app } = options;
  const channel = getUpdateChannel(options.configStore);
  if (!app?.isPackaged) {
    return getDisabledResult();
  }
  if (process.platform !== 'darwin' && !autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }
  if (downloadedUpdateVersion && downloadedUpdateChannel === channel) {
    if (!downloadedUpdateFilePath || isDownloadedFileReady(downloadedUpdateFilePath)) {
      return { enabled: true, updateAvailable: true, version: downloadedUpdateVersion, downloaded: true, channel };
    }
    downloadedUpdateVersion = '';
    downloadedUpdateChannel = '';
    downloadedUpdateFilePath = '';
  }
  if (activeUpdateCheckPromise) {
    return activeUpdateCheckPromise;
  }

  activeUpdateCheckPromise = runUpdateCheck(options)
    .catch((error) => {
      const message = formatErrorMessage(error);
      options.onError?.(message);
      return { enabled: true, updateAvailable: false, failed: true, message, channel };
    })
    .finally(() => {
      activeUpdateCheckPromise = null;
    });
  return activeUpdateCheckPromise;
}

function triggerUpdateDownload(options) {
  return checkAndDownloadUpdate(options);
}

async function quitAndInstall(options = {}) {
  if (downloadedUpdateFilePath) {
    if (!isDownloadedFileReady(downloadedUpdateFilePath)) {
      return { success: false, message: '更新安装包尚未下载完成，请先检查更新' };
    }

    const { shell } = require('electron');
    const openError = await shell.openPath(downloadedUpdateFilePath);
    if (openError) {
      return { success: false, message: `打开更新安装包失败：${openError}` };
    }

    const { app } = options;
    setTimeout(() => {
      if (app?.quit) {
        app.quit();
      }
    }, 500);
    return { success: true };
  }

  if (autoUpdaterInstance && downloadedUpdateVersion) {
    autoUpdaterInstance.quitAndInstall(false, true);
    return { success: true };
  }

  return { success: false, message: '更新包尚未下载完成，请先检查更新' };
}

function setupAutoUpdate({ app, mainWindow }) {
  if (!app.isPackaged) {
    return;
  }
  if (process.platform === 'darwin') {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  configureAutoUpdater('github');

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info?.version || downloadedUpdateVersion;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
  });

  autoUpdater.on('error', (error) => {
    setProgressBar(mainWindow, -1);
    console.warn('自动更新检查失败', error);
  });
}

module.exports = {
  setupAutoUpdate,
  checkAndDownloadUpdate,
  triggerUpdateDownload,
  quitAndInstall,
  getLatestVersion,
  getUpdateDownloadUrl,
};
