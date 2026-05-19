const { ipcMain } = require('electron');

function registerWorkspaceIpc({ workspaceStore }) {
  ipcMain.handle('workspace:load-technical-plan', () => workspaceStore.loadTechnicalPlan());
  ipcMain.handle('workspace:save-technical-plan', (_event, state) => workspaceStore.saveTechnicalPlan(state));
  ipcMain.handle('workspace:update-technical-plan', (_event, partial) => workspaceStore.updateTechnicalPlan(partial));
  ipcMain.handle('workspace:clear-technical-plan', () => workspaceStore.clearTechnicalPlan());
  ipcMain.handle('workspace:load-duplicate-check', () => workspaceStore.loadDuplicateCheck());
  ipcMain.handle('workspace:save-duplicate-check', (_event, state) => workspaceStore.saveDuplicateCheck(state));
  ipcMain.handle('workspace:clear-duplicate-check', () => workspaceStore.clearDuplicateCheck());
}

module.exports = {
  registerWorkspaceIpc,
};
