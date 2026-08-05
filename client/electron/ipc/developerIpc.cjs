const { BrowserWindow, ipcMain } = require('electron');

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

function registerDeveloperIpc({ configStore, aiService, agentService, openDeveloperTokenStatsWindow, openDeveloperAgentMonitorWindow, developerExpansionReplaceTestService }) {
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

  ipcMain.handle('developer-expansion-replace-test:run', (_event, payload) => {
    requireDeveloperMode(configStore);
    return developerExpansionReplaceTestService.run(payload);
  });
}

module.exports = {
  registerDeveloperIpc,
};
