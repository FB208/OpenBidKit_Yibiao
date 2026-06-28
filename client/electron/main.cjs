const { app, BrowserWindow, nativeTheme, shell, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerIpcHandlers } = require('./ipc/index.cjs');
const { setupAutoUpdate, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall, getLatestVersion, getUpdateDownloadUrl } = require('./services/updateService.cjs');
const { getConfigFilePath, getGeneratedImagesDir, getGpuStartupProbePath, getImportedImagesDir } = require('./utils/paths.cjs');

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const iconPath = path.join(__dirname, '../assets/icon.ico');
const packagedIndexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).toString();
const GPU_HARDWARE_ACCELERATION_TRIAL_ARG = '--yibiao-trial-hardware-acceleration';
const FORCE_DISABLE_GPU_ARGS = ['--disable-gpu', '--disable-hardware-acceleration'];
let appQuitting = false;
let gpuRecoveryRelaunchStarted = false;
let developerTokenStatsWindow = null;
let services = null;
let closeBeforeQuitStarted = false;
let quitAfterClose = false;

function hasProcessArg(name) {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function readStartupConfigFile() {
  try {
    const configFile = getConfigFilePath(app);
    if (!fs.existsSync(configFile)) {
      return {};
    }

    const raw = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(raw);
    return config && typeof config === 'object' ? config : {};
  } catch (error) {
    console.warn('[gpu] 读取图形渲染配置失败，将使用默认 GPU 硬件加速策略', error?.message || String(error));
    return null;
  }
}

function writeStartupConfigFile(config) {
  let tempFile = '';
  try {
    const configFile = getConfigFilePath(app);
    tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tempFile, configFile);
    return true;
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    console.warn('[gpu] 写入图形渲染配置失败', error?.message || String(error));
    return false;
  }
}

function updateStartupConfigFile(mutator) {
  const config = readStartupConfigFile();
  if (!config) {
    return false;
  }
  return writeStartupConfigFile(mutator({ ...config }));
}

function isPendingGpuStartupProbe(value) {
  return Boolean(value && typeof value === 'object' && value.state === 'pending');
}

function readGpuStartupProbeFile() {
  try {
    const probeFile = getGpuStartupProbePath(app);
    if (!fs.existsSync(probeFile)) {
      return null;
    }

    const raw = fs.readFileSync(probeFile, 'utf-8');
    const probe = JSON.parse(raw);
    return probe && typeof probe === 'object' ? probe : null;
  } catch (error) {
    console.warn('[gpu] 读取 GPU 启动探测文件失败', error?.message || String(error));
    return null;
  }
}

function writeGpuStartupProbeFile(probe) {
  let tempFile = '';
  try {
    const probeFile = getGpuStartupProbePath(app);
    tempFile = `${probeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(probe, null, 2), 'utf-8');
    fs.renameSync(tempFile, probeFile);
    return true;
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    console.warn('[gpu] 写入 GPU 启动探测文件失败', error?.message || String(error));
    return false;
  }
}

function removeGpuStartupProbeFile() {
  try {
    fs.rmSync(getGpuStartupProbePath(app), { force: true });
    return true;
  } catch (error) {
    console.warn('[gpu] 删除 GPU 启动探测文件失败', error?.message || String(error));
    return false;
  }
}

function readStartupGpuPreference() {
  const previousProbePending = isPendingGpuStartupProbe(readGpuStartupProbeFile());
  const config = readStartupConfigFile();
  if (!config) {
    return { enabled: true, configured: true, previousProbePending };
  }

  const configured = typeof config.gpu_hardware_acceleration_configured === 'boolean'
    ? config.gpu_hardware_acceleration_configured
    : true;

  return {
    enabled: configured === false
      ? true
      : typeof config.gpu_hardware_acceleration_enabled === 'boolean'
      ? config.gpu_hardware_acceleration_enabled
      : true,
    configured: configured === false ? true : configured,
    previousProbePending,
  };
}

function markGpuStartupProbePending() {
  writeGpuStartupProbeFile({
    state: 'pending',
    started_at: new Date().toISOString(),
  });
}

function clearGpuStartupProbe() {
  removeGpuStartupProbeFile();
}

function disableGpuHardwareAccelerationForNextLaunch(reason) {
  const saved = updateStartupConfigFile((config) => ({
    ...config,
    gpu_hardware_acceleration_enabled: false,
    gpu_hardware_acceleration_configured: true,
    gpu_hardware_acceleration_disabled_reason: reason,
    gpu_hardware_acceleration_disabled_at: new Date().toISOString(),
  }));
  if (saved) {
    clearGpuStartupProbe();
  }
}

function configureGpuHardwareAcceleration() {
  const preference = readStartupGpuPreference();
  const trial = hasProcessArg(GPU_HARDWARE_ACCELERATION_TRIAL_ARG);
  const forcedDisabled = FORCE_DISABLE_GPU_ARGS.some((arg) => hasProcessArg(arg));
  const autoDisabledByPreviousFailure = !forcedDisabled && !trial && preference.enabled && preference.previousProbePending;

  if (autoDisabledByPreviousFailure) {
    disableGpuHardwareAccelerationForNextLaunch('previous-startup-probe');
  }

  const hardwareAccelerationEnabled = !forcedDisabled && !autoDisabledByPreviousFailure && (trial || preference.enabled);

  if (!hardwareAccelerationEnabled) {
    app.disableHardwareAcceleration();
  } else {
    markGpuStartupProbePending();
  }

  return {
    autoDisabledByPreviousFailure,
    configured: preference.configured,
    forcedDisabled,
    hardwareAccelerationEnabled,
    probeStarted: hardwareAccelerationEnabled,
    trial,
  };
}

function scheduleGpuStartupProbeClear(mainWindow) {
  if (!gpuStartupState.probeStarted) {
    return;
  }

  const clearWhenStable = () => {
    setTimeout(() => {
      if (!appQuitting && !gpuRecoveryRelaunchStarted) {
        clearGpuStartupProbe();
      }
    }, 3000);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', clearWhenStable);
  } else {
    clearWhenStable();
  }
}

function withoutGpuControlArgs(args) {
  const excludedArgs = new Set([GPU_HARDWARE_ACCELERATION_TRIAL_ARG, ...FORCE_DISABLE_GPU_ARGS]);
  return args.filter((arg) => !excludedArgs.has(String(arg).split('=')[0]));
}

async function closeServicesBeforeExit() {
  try {
    await services?.closeServices?.();
  } catch (error) {
    console.warn('[electron] 关闭后台服务失败', error?.message || String(error));
  }
}

async function relaunchWithGpuDisabled() {
  if (gpuRecoveryRelaunchStarted) {
    return;
  }

  gpuRecoveryRelaunchStarted = true;
  appQuitting = true;
  await closeServicesBeforeExit();
  app.relaunch({ args: withoutGpuControlArgs(process.argv.slice(1)).concat('--disable-gpu') });
  app.exit(0);
}

const gpuStartupState = configureGpuHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{
  scheme: 'yibiao-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function registerAssetProtocol() {
  protocol.handle('yibiao-asset', (request) => {
    try {
      const url = new URL(request.url);
      const assetRoots = {
        'generated-images': getGeneratedImagesDir(app),
        'imported-images': getImportedImagesDir(app),
      };
      const rootDir = assetRoots[url.hostname];
      if (!rootDir) {
        return new Response('Not found', { status: 404 });
      }

      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!relativePath) {
        return new Response('Not found', { status: 404 });
      }

      const baseDir = path.resolve(rootDir);
      const filePath = path.resolve(baseDir, relativePath);
      if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Invalid asset url', { status: 400 });
    }
  });
}

function normalizeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;

  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAllowedAppNavigation(value) {
  try {
    const url = new URL(value);
    if (rendererUrl) {
      return url.origin === new URL(rendererUrl).origin;
    }

    const indexUrl = new URL(packagedIndexUrl);
    return url.protocol === 'file:' && url.pathname === indexUrl.pathname;
  } catch {
    return false;
  }
}

async function openExternalUrl(value) {
  const externalUrl = normalizeExternalUrl(value);
  if (!externalUrl) return;
  try {
    await shell.openExternal(externalUrl);
  } catch (error) {
    const preview = externalUrl.length > 300 ? `${externalUrl.slice(0, 300)}...` : externalUrl;
    console.warn('[electron] 打开外部链接失败', { url: preview, message: error.message || String(error) });
  }
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#f8fafd',
    title: '易标投标工具箱',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return;
    }

    event.preventDefault();
    void openExternalUrl(url);
  });

  return mainWindow;
}

function appendWindowQuery(url, windowName) {
  return `${url}${url.includes('?') ? '&' : '?'}window=${encodeURIComponent(windowName)}`;
}

function closeDeveloperTokenStatsWindow() {
  const window = developerTokenStatsWindow;
  developerTokenStatsWindow = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
}

function openDeveloperTokenStatsWindow() {
  if (developerTokenStatsWindow && !developerTokenStatsWindow.isDestroyed()) {
    if (developerTokenStatsWindow.isMinimized()) {
      developerTokenStatsWindow.restore();
    }
    developerTokenStatsWindow.show();
    developerTokenStatsWindow.focus();
    return { success: true };
  }

  const tokenStatsWindow = new BrowserWindow({
    width: 360,
    height: 330,
    minWidth: 320,
    minHeight: 300,
    maxWidth: 420,
    maxHeight: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Token 统计',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  developerTokenStatsWindow = tokenStatsWindow;
  tokenStatsWindow.setMenuBarVisibility(false);
  tokenStatsWindow.on('closed', () => {
    if (developerTokenStatsWindow === tokenStatsWindow) {
      developerTokenStatsWindow = null;
    }
  });

  const baseUrl = rendererUrl || packagedIndexUrl;
  tokenStatsWindow.loadURL(appendWindowQuery(baseUrl, 'token-stats'));
  return { success: true };
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';
  registerAssetProtocol();
  const mainWindow = createMainWindow();
  scheduleGpuStartupProbeClear(mainWindow);
  services = registerIpcHandlers({
    app,
    mainWindow,
    checkAndDownloadUpdate,
    triggerUpdateDownload,
    quitAndInstall,
    getLatestVersion,
    getUpdateDownloadUrl,
    gpuStartupState,
    gpuTrialArg: GPU_HARDWARE_ACCELERATION_TRIAL_ARG,
    forceDisableGpuArgs: FORCE_DISABLE_GPU_ARGS,
    openDeveloperTokenStatsWindow,
    closeDeveloperTokenStatsWindow,
  });
  setupAutoUpdate({ app, mainWindow });
  mainWindow.on('closed', () => {
    closeDeveloperTokenStatsWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('child-process-gone', (_event, details) => {
  if (details?.type !== 'GPU') return;
  if (appQuitting) return;
  console.warn('[gpu] GPU 子进程异常退出', {
    reason: details.reason,
    exitCode: details.exitCode,
    hardwareAccelerationEnabled: gpuStartupState.hardwareAccelerationEnabled,
    trial: gpuStartupState.trial,
    forcedDisabled: gpuStartupState.forcedDisabled,
  });
  if (gpuStartupState.hardwareAccelerationEnabled && !gpuStartupState.forcedDisabled && details.reason !== 'clean-exit') {
    disableGpuHardwareAccelerationForNextLaunch('gpu-process-gone');
    void relaunchWithGpuDisabled();
  }
});

app.on('before-quit', (event) => {
  if (quitAfterClose) {
    return;
  }
  event.preventDefault();
  if (closeBeforeQuitStarted) {
    return;
  }
  closeBeforeQuitStarted = true;
  appQuitting = true;
  void Promise.resolve()
    .then(async () => {
      await closeServicesBeforeExit();
      if (gpuStartupState.probeStarted && !gpuRecoveryRelaunchStarted) {
        clearGpuStartupProbe();
      }
    })
    .catch((error) => {
      console.warn('[electron] before-quit 清理失败', error?.message || String(error));
    })
    .finally(() => {
      quitAfterClose = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
