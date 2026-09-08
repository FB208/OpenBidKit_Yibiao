const { BrowserWindow, ipcMain, shell } = require('electron');

function requireDeveloperMode(configStore) {
  if (!configStore.load()?.developer_mode) {
    throw new Error('请先开启开发者模式');
  }
}

function broadcastTextTokenStats(stats) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('developer-token-stats:changed', stats);
    }
  });
}

function registerDeveloperIpc({ configStore, aiService, agentService, openDeveloperTokenStatsWindow, openDeveloperAgentMonitorWindow, developerExpansionReplaceTestService, developerLayoutFigureService, openXmlHelperService }) {
  let monitorSenderId = null;
  let unsubscribeMonitor = null;

  function detachMonitor(senderId) {
    if (senderId !== undefined && senderId !== null && senderId !== monitorSenderId) return;
    try { unsubscribeMonitor?.(); } catch {}
    unsubscribeMonitor = null;
    monitorSenderId = null;
  }

  aiService.onTextTokenStatsChanged((stats) => {
    broadcastTextTokenStats(stats);
  });

  ipcMain.handle('developer-token-stats:open-window', () => {
    requireDeveloperMode(configStore);
    return openDeveloperTokenStatsWindow();
  });

  ipcMain.handle('developer-token-stats:get', () => {
    requireDeveloperMode(configStore);
    return aiService.getTextTokenStats();
  });

  ipcMain.handle('developer-token-stats:reset', () => {
    requireDeveloperMode(configStore);
    return aiService.resetTextTokenStats();
  });

  ipcMain.handle('developer-agent-monitor:open-window', () => {
    requireDeveloperMode(configStore);
    return openDeveloperAgentMonitorWindow();
  });

  ipcMain.handle('developer-agent-monitor:attach', (event) => {
    requireDeveloperMode(configStore);
    const sender = event.sender;
    detachMonitor();
    monitorSenderId = sender.id;
    unsubscribeMonitor = agentService.onMonitorEvent((monitorEvent) => {
      if (sender.isDestroyed?.()) {
        detachMonitor(sender.id);
        return;
      }
      sender.send('developer-agent-monitor:event', monitorEvent);
    });
    sender.once('destroyed', () => detachMonitor(sender.id));
    return agentService.getMonitorSnapshot();
  });

  ipcMain.handle('developer-agent-monitor:detach', (event) => {
    detachMonitor(event.sender.id);
    return { success: true };
  });

  ipcMain.handle('developer-agent-monitor:open-workspace', async (_event, workspaceDir) => {
    requireDeveloperMode(configStore);
    const errorMessage = await shell.openPath(workspaceDir);
    if (errorMessage) {
      throw new Error(`打开当前工作空间失败：${errorMessage}`);
    }
    return { success: true, path: workspaceDir };
  });

  ipcMain.handle('developer-expansion-replace-test:run', (_event, payload) => {
    requireDeveloperMode(configStore);
    return developerExpansionReplaceTestService.run(payload);
  });

  // 版面预算测试：按骨架给定的画框比例真实生成一张配图，落到测试专用资源目录。
  ipcMain.handle('developer-layout-figure:render', (_event, payload) => {
    requireDeveloperMode(configStore);
    return developerLayoutFigureService.renderFigure(payload);
  });

  // 每轮生成前清空上一轮的图，并把资源目录名交给渲染侧。
  ipcMain.handle('developer-layout-figure:reset', () => {
    requireDeveloperMode(configStore);
    const { assetRoot } = developerLayoutFigureService.reset();
    return { assetRoot };
  });

  // 用测试资源目录渲染样张，不走模板样张那份会被同步清理的目录。
  ipcMain.handle('developer-layout-figure:render-preview', async (_event, html, exportFormat) => {
    requireDeveloperMode(configStore);
    // 渲染前先把占位图补齐：没开真实生图、纯文字章节、或某张图失败退回占位图时，
    // HTML 引用的是模板那几张 webp，测试资源目录里必须真有这些文件。
    const assetRoot = developerLayoutFigureService.ensurePlaceholderAssets();
    const result = await openXmlHelperService.renderRestrictedHtmlDocx(html, exportFormat, { assetRoot });
    return { key: result.key, bytes: result.bytes, roles: result.roles };
  });
}

module.exports = {
  registerDeveloperIpc,
};
