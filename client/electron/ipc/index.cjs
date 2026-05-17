const { ipcMain } = require('electron');
const https = require('node:https');
const { registerAiIpc } = require('./aiIpc.cjs');
const { registerConfigIpc } = require('./configIpc.cjs');
const { registerExportIpc } = require('./exportIpc.cjs');
const { registerFileIpc } = require('./fileIpc.cjs');
const { registerKnowledgeBaseIpc } = require('./knowledgeBaseIpc.cjs');
const { registerTaskIpc } = require('./taskIpc.cjs');
const { registerWorkspaceIpc } = require('./workspaceIpc.cjs');
const { createAiService } = require('../services/aiService.cjs');
const { createConfigStore } = require('../services/configStore.cjs');
const { createExportService } = require('../services/exportService.cjs');
const { createFileService } = require('../services/fileService.cjs');
const { createKnowledgeBaseService } = require('../services/knowledgeBaseService.cjs');
const { createTaskService } = require('../services/taskService.cjs');
const { createWorkspaceStore } = require('../services/workspaceStore.cjs');

function registerIpcHandlers({ app, mainWindow, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall }) {
  const configStore = createConfigStore(app);
  const aiService = createAiService({ app, configStore });
  const fileService = createFileService({ app, configStore });
  const exportService = createExportService();
  const knowledgeBaseService = createKnowledgeBaseService({ app, aiService, configStore });
  const workspaceStore = createWorkspaceStore(app);
  const taskService = createTaskService({ aiService, workspaceStore, knowledgeBaseService });

  registerConfigIpc({ configStore, aiService });
  registerAiIpc({ aiService });
  registerFileIpc({ fileService });
  registerKnowledgeBaseIpc({ knowledgeBaseService });
  registerExportIpc({ exportService });
  registerWorkspaceIpc({ workspaceStore });
  registerTaskIpc({ taskService });

  ipcMain.handle('app:get-version', () => app.getVersion());

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
