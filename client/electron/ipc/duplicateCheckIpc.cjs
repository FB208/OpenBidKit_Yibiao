const { ipcMain } = require('electron');

function registerDuplicateCheckIpc({ duplicateCheckStore }) {
  ipcMain.handle('duplicate-check:load-state', () => duplicateCheckStore.loadDuplicateCheck());
  ipcMain.handle('duplicate-check:save-files', (_event, payload) => duplicateCheckStore.saveFiles(payload));
  ipcMain.handle('duplicate-check:save-ui-state', (_event, payload) => duplicateCheckStore.saveUiState(payload));
  ipcMain.handle('duplicate-check:update-state', (_event, partial) => duplicateCheckStore.updateDuplicateCheck(partial));
  ipcMain.handle('duplicate-check:clear', () => duplicateCheckStore.clearDuplicateCheck());
}

module.exports = {
  registerDuplicateCheckIpc,
};
