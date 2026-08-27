const { ipcMain } = require('electron');

/** 注册打赏服务的 Renderer 调用通道。 */
function registerDonationIpc({ donationService }) {
  ipcMain.handle('donation:get-config', () => donationService.getConfig());
  ipcMain.handle('donation:create-tip', (_event, request) => donationService.createTip(request));
  ipcMain.handle('donation:get-order-status', (_event, merchantOrderNo) => donationService.getOrderStatus(merchantOrderNo));
  ipcMain.handle('donation:finalize-order-status', (_event, merchantOrderNo) => donationService.finalizeOrderStatus(merchantOrderNo));
}

module.exports = {
  registerDonationIpc,
};
