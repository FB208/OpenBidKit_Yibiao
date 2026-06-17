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

function registerDeveloperIpc({ configStore, aiService, openDeveloperTokenStatsWindow }) {
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
}

module.exports = {
  registerDeveloperIpc,
};
