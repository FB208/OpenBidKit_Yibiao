const { app, BrowserWindow, nativeTheme, shell, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerIpcHandlers } = require('./ipc/index.cjs');
const { setupAutoUpdate, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall } = require('./services/updateService.cjs');
const { getGeneratedImagesDir, getImportedImagesDir } = require('./utils/paths.cjs');

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const iconPath = path.join(__dirname, '../assets/icon.ico');

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
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';
  registerAssetProtocol();
  const mainWindow = createMainWindow();
  registerIpcHandlers({ app, mainWindow, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall });
  setupAutoUpdate({ app, mainWindow });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
