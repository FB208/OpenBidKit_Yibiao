const { ipcMain, shell } = require('electron');
const https = require('node:https');
const { registerAiIpc } = require('./aiIpc.cjs');
const { registerConfigIpc } = require('./configIpc.cjs');
const { registerExportIpc } = require('./exportIpc.cjs');
const { registerFileIpc } = require('./fileIpc.cjs');
const { registerKnowledgeBaseIpc } = require('./knowledgeBaseIpc.cjs');
const { registerTaskIpc } = require('./taskIpc.cjs');
const { registerTechnicalPlanIpc } = require('./technicalPlanIpc.cjs');
const { registerWorkspaceIpc } = require('./workspaceIpc.cjs');
const { createAiService } = require('../services/aiService.cjs');
const { createConfigStore } = require('../services/configStore.cjs');
const { createDuplicateCheckService } = require('../services/duplicateCheckService.cjs');
const { createExportService } = require('../services/exportService.cjs');
const { createFileService } = require('../services/fileService.cjs');
const { createKnowledgeBaseService } = require('../services/knowledgeBaseService.cjs');
const { createSqliteDatabase } = require('../services/sqliteDatabase.cjs');
const { createTaskService } = require('../services/taskService.cjs');
const { createTechnicalPlanStore } = require('../services/technicalPlanStore.cjs');
const { createWorkspaceStore } = require('../services/workspaceStore.cjs');

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

function registerUnavailableTechnicalPlanIpc(error) {
  const message = `技术方案数据库初始化失败：${error?.message || String(error)}`;
  const throwUnavailable = () => {
    throw new Error(message);
  };

  console.error('[ipc] 技术方案数据库初始化失败', error);
  [
    'technical-plan:load-state',
    'technical-plan:import-tender-document',
    'technical-plan:read-tender-markdown',
    'technical-plan:update-step',
    'technical-plan:save-outline-config',
    'technical-plan:save-outline',
    'technical-plan:save-content-generation-options',
    'technical-plan:save-chapter-content',
    'technical-plan:clear',
    'tasks:start-bid-analysis',
    'tasks:start-outline-generation',
    'tasks:start-content-generation',
    'tasks:pause-content-generation',
    'tasks:start-rejection-items-extraction',
    'tasks:start-rejection-check',
    'tasks:start-duplicate-analysis',
    'tasks:get-active',
  ].forEach((channel) => ipcMain.handle(channel, throwUnavailable));
  ipcMain.on('tasks:subscribe', () => {});
}

function registerIpcHandlers({ app, mainWindow, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall }) {
  const configStore = createConfigStore(app);
  const aiService = createAiService({ app, configStore });
  const fileService = createFileService({ app, configStore });
  const exportService = createExportService();
  const knowledgeBaseService = createKnowledgeBaseService({ app, aiService, configStore });
  const workspaceStore = createWorkspaceStore(app);
  const duplicateCheckService = createDuplicateCheckService({ app, configStore, workspaceStore });

  registerConfigIpc({ configStore, aiService });
  registerAiIpc({ aiService });
  registerFileIpc({ fileService });
  registerKnowledgeBaseIpc({ knowledgeBaseService });
  registerExportIpc({ exportService });
  registerWorkspaceIpc({ workspaceStore });

  try {
    const sqliteDatabase = createSqliteDatabase(app);
    const technicalPlanStore = createTechnicalPlanStore({ app, db: sqliteDatabase.db, fileService });
    const taskService = createTaskService({ aiService, workspaceStore, technicalPlanStore, knowledgeBaseService, duplicateCheckService });
    registerTechnicalPlanIpc({ technicalPlanStore });
    registerTaskIpc({ taskService });
  } catch (error) {
    registerUnavailableTechnicalPlanIpc(error);
  }

  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('app:open-external', async (_event, url) => {
    const externalUrl = normalizeExternalUrl(url);
    if (!externalUrl) {
      return { success: false, message: '不支持的外部链接' };
    }
    try {
      await shell.openExternal(externalUrl);
      return { success: true };
    } catch (error) {
      const preview = externalUrl.length > 300 ? `${externalUrl.slice(0, 300)}...` : externalUrl;
      console.warn('[app] 打开外部链接失败', { url: preview, message: error.message || String(error) });
      return { success: false, message: '外部链接打开失败' };
    }
  });

  ipcMain.handle('app:get-latest-version', () => {
    return new Promise((resolve, reject) => {
      const url = 'https://api.github.com/repos/FB208/OpenBidKit_Yibiao/releases/latest';
      const request = https.get(url, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const release = JSON.parse(data);
            resolve({
              version: release.tag_name?.replace(/^v/, '') || '',
              name: release.name || '',
              body: release.body || '',
              published_at: release.published_at || '',
              html_url: release.html_url || '',
            });
          } catch (error) {
            reject(new Error('解析 GitHub API 响应失败'));
          }
        });
      });
      request.on('error', (error) => reject(error));
      request.setTimeout(10000, () => {
        request.destroy();
        reject(new Error('请求超时'));
      });
    });
  });
  ipcMain.handle('app:quit-and-install', () => {
    quitAndInstall();
  });

  ipcMain.handle('app:check-update', (event) => {
    const webContents = event.sender;
    return checkAndDownloadUpdate({
      app,
      mainWindow,
      onProgress: (percent) => {
        webContents.send('app:update-progress', { percent });
      },
      onDownloaded: (version) => {
        webContents.send('app:update-downloaded', { version });
      },
      onError: (message) => {
        webContents.send('app:update-error', { message });
      },
    });
  });

  ipcMain.handle('app:start-update', (event) => {
    const webContents = event.sender;
    return triggerUpdateDownload({
      app,
      mainWindow,
      onProgress: (percent) => {
        webContents.send('app:update-progress', { percent });
      },
      onDownloaded: (version) => {
        webContents.send('app:update-downloaded', { version });
      },
      onError: (message) => {
        webContents.send('app:update-error', { message });
      },
    });
  });
}

module.exports = {
  registerIpcHandlers,
};
