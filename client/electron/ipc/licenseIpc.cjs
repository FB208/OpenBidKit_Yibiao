const { ipcMain } = require('electron');

function registerLicenseIpc({ licenseService }) {
  ipcMain.handle('license:get-status', () => licenseService.getStatus());
  ipcMain.handle('license:refresh', () => licenseService.refresh());
  ipcMain.handle('license:import-offline-file', () => licenseService.importOfflineFile());
  ipcMain.handle('license:activate-offline-code', (_event, code) => licenseService.activateOfflineCode(code));
}

module.exports = {
  registerLicenseIpc,
};
