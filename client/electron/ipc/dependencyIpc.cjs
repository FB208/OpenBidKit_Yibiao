const { ipcMain } = require('electron');

function registerDependencyIpc({ dependencyService }) {
  ipcMain.handle('dependencies:get-status', (_event, id) => dependencyService.getStatus(id));
  ipcMain.handle('dependencies:install', (_event, id) => dependencyService.install(id));
  ipcMain.handle('dependencies:uninstall', (_event, id) => dependencyService.uninstall(id));
}

module.exports = {
  registerDependencyIpc,
};
