const https = require('node:https');

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

let autoUpdaterInstance = null;
let downloadedUpdateVersion = '';
let downloadedUpdateChannel = '';
let activeUpdateCheckPromise = null;

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function normalizeUpdateChannel(value) {
  return value === 'cloudflare' ? 'cloudflare' : 'github';
}

function getUpdateChannel(configStore) {
  if (!configStore) {
    return 'github';
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
  return {
    channel: 'github',
    version: release.tag_name?.replace(/^v/, '') || '',
    name: release.name || '',
    body: release.body || '',
    published_at: release.published_at || '',
    html_url: release.html_url || GITHUB_RELEASE_DOWNLOAD_URL,
    download_url: GITHUB_RELEASE_DOWNLOAD_URL,
  };
}

function pickCloudflareDownloadFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.zip$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return validFiles.find((file) => new RegExp(`-mac-${arch}-package\\.zip$`, 'i').test(file.name))
      || validFiles.find((file) => /-mac-(?:x64|arm64)-package\.zip$/i.test(file.name));
  }
  return null;
}

async function fetchCloudflareLatestRelease() {
  const release = await requestJson(CLOUDFLARE_LATEST_JSON_URL, 'Cloudflare 更新源 ');
  const downloadFile = pickCloudflareDownloadFile(release.files);
  return {
    channel: 'cloudflare',
    version: String(release.version || release.tagName || '').replace(/^v/i, ''),
    name: release.name || release.tagName || '',
    body: release.body || '',
    published_at: release.generatedAt || '',
    html_url: CLOUDFLARE_RELEASE_BASE_URL,
    download_url: downloadFile?.url || CLOUDFLARE_RELEASE_BASE_URL,
  };
}

function fetchLatestRelease(channel) {
  return channel === 'cloudflare' ? fetchCloudflareLatestRelease() : fetchGithubLatestRelease();
}

async function getLatestVersion(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  return fetchLatestRelease(channel);
}

async function getUpdateDownloadUrl(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  if (channel !== 'cloudflare') {
    return GITHUB_RELEASE_DOWNLOAD_URL;
  }

  try {
    const release = await fetchCloudflareLatestRelease();
    return release.download_url || CLOUDFLARE_RELEASE_BASE_URL;
  } catch (error) {
    console.warn('[update] Cloudflare 下载地址获取失败，回退到 GitHub Release', error);
    return GITHUB_RELEASE_DOWNLOAD_URL;
  }
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

async function runUpdateCheck(options = {}) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const channel = getUpdateChannel(options.configStore);
  configureAutoUpdater(channel);
  const release = await fetchLatestRelease(channel);
  if (!release.version || compareVersions(release.version, app.getVersion()) <= 0) {
    return { enabled: true, updateAvailable: false, channel };
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
  if (!autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }
  if (downloadedUpdateVersion && downloadedUpdateChannel === channel) {
    return { enabled: true, updateAvailable: true, version: downloadedUpdateVersion, downloaded: true, channel };
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

function quitAndInstall() {
  if (autoUpdaterInstance && downloadedUpdateVersion) {
    autoUpdaterInstance.quitAndInstall(false, true);
  }
}

function setupAutoUpdate({ app, mainWindow }) {
  if (!app.isPackaged) {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  configureAutoUpdater('github');

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info?.version || downloadedUpdateVersion;
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
