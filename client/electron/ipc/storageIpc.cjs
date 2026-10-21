const { ipcMain } = require('electron');

function registerStorageIpc({ storageSpaceService }) {
  ipcMain.handle('storage:get-usage', () => storageSpaceService.getUsage());
  ipcMain.handle('storage:clean', (_event, groupId) => storageSpaceService.clean(groupId));
}

module.exports = {
  registerStorageIpc,
};
