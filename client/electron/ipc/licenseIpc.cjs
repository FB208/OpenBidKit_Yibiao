const { ipcMain } = require('electron');

function registerLicenseIpc({ licenseService }) {
  ipcMain.handle('license:get-status', () => licenseService.getStatus());
  ipcMain.handle('license:refresh', () => licenseService.refresh());
}

module.exports = {
  registerLicenseIpc,
};
