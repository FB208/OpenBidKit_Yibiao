const { ipcMain } = require('electron');

function registerRejectionCheckIpc({ rejectionCheckStore, taskService }) {
  ipcMain.handle('rejection-check:load-state', () => rejectionCheckStore.loadRejectionCheck());
  ipcMain.handle('rejection-check:import-document', (_event, role, filePaths) => taskService.importRejectionCheckDocument(role, filePaths));
  ipcMain.handle('rejection-check:import-tender-from-technical-plan', () => taskService.importRejectionCheckTenderFromTechnicalPlan());
  ipcMain.handle('rejection-check:remove-document', (_event, role, documentId) => taskService.removeRejectionCheckDocument(role, documentId));
  ipcMain.handle('rejection-check:save-ui-state', (_event, payload) => rejectionCheckStore.saveUiState(payload));
  ipcMain.handle('rejection-check:update-state', (_event, partial) => rejectionCheckStore.updateRejectionCheckWithoutReload(partial));
  ipcMain.handle('rejection-check:clear', () => taskService.resetRejectionCheck());
}

module.exports = {
  registerRejectionCheckIpc,
};
