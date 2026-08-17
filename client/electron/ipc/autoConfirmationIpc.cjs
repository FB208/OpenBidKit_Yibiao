const { ipcMain } = require('electron');

// 注册全局自动确认配置及状态同步通道。
function registerAutoConfirmationIpc({ autoConfirmationService }) {
  const subscribers = new Set();

  const subscribe = (webContents) => {
    if (!webContents || webContents.isDestroyed() || subscribers.has(webContents)) return;
    subscribers.add(webContents);
    webContents.once('destroyed', () => subscribers.delete(webContents));
  };

  ipcMain.handle('auto-confirmation:get-state', async (event) => {
    subscribe(event.sender);
    return autoConfirmationService.getState();
  });
  ipcMain.handle('auto-confirmation:set-enabled', async (_event, enabled) => autoConfirmationService.setEnabled(enabled));
  ipcMain.on('auto-confirmation:subscribe', (event) => subscribe(event.sender));

  autoConfirmationService.onChanged((state) => {
    subscribers.forEach((webContents) => {
      if (webContents.isDestroyed()) {
        subscribers.delete(webContents);
      } else {
        webContents.send('auto-confirmation:state', state);
      }
    });
  });
}

module.exports = {
  registerAutoConfirmationIpc,
};
