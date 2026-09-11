const { BrowserWindow, ipcMain } = require('electron');

// 转发官方账户操作，并向窗口推送不含令牌的展示状态。
function registerOfficialAccountIpc({ officialAccountService }) {
  ipcMain.handle('official-account:redeem-code', (_event, input) => officialAccountService.redeemCode(input));
  ipcMain.handle('official-account:create-invoice-application', (_event, input) => officialAccountService.createInvoiceApplication(input));
  ipcMain.handle('official-account:get-state', () => officialAccountService.getState());
  ipcMain.handle('official-account:send-email-code', (_event, input) => officialAccountService.sendEmailCode(input));
  ipcMain.handle('official-account:login', (_event, input) => officialAccountService.loginWithEmail(input));
  ipcMain.handle('official-account:bind-email', (_event, input) => officialAccountService.bindEmail(input));
  ipcMain.handle('official-account:get-recharge-options', () => officialAccountService.getRechargeOptions());
  ipcMain.handle('official-account:create-recharge-order', (_event, input) => officialAccountService.createRechargeOrder(input));
  ipcMain.handle('official-account:get-recharge-orders', () => officialAccountService.getRechargeOrders());
  ipcMain.handle('official-account:get-recharge-order', (_event, id) => officialAccountService.getRechargeOrder(id));
  ipcMain.handle('official-account:close-recharge-order', (_event, id) => officialAccountService.closeRechargeOrder(id));
  officialAccountService.onRechargeOrderChanged((order) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.webContents.isDestroyed()) window.webContents.send('official-account:order', order);
    });
  });
  officialAccountService.onChanged((state) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.webContents.isDestroyed()) window.webContents.send('official-account:state', state);
    });
  });
}

// 在工作区数据库就绪后注册本地开票信息读写。
function registerOfficialInvoiceIpc({ officialInvoiceStore }) {
  ipcMain.handle('official-account:get-invoice-info', () => officialInvoiceStore.get());
  ipcMain.handle('official-account:save-invoice-info', (_event, input) => officialInvoiceStore.save(input));
}

module.exports = { registerOfficialAccountIpc, registerOfficialInvoiceIpc };
