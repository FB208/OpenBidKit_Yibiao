const { ipcMain } = require('electron');

function registerWorkspaceIpc({ workspaceStore }) {
  ipcMain.handle('workspace:load-technical-plan', () => workspaceStore.loadTechnicalPlan());
  ipcMain.handle('workspace:save-technical-plan', (_event, state) => workspaceStore.saveTechnicalPlan(state));
  ipcMain.handle('workspace:update-technical-plan', (_event, partial) => workspaceStore.updateTechnicalPlan(partial));
  ipcMain.handle('workspace:clear-technical-plan', () => workspaceStore.clearTechnicalPlan());
}

module.exports = {
  registerWorkspaceIpc,
};
