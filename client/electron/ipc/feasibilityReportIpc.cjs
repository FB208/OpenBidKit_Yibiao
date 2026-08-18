const { ipcMain } = require('electron');

function registerFeasibilityReportIpc({ feasibilityReportStore, taskService }) {
  ipcMain.handle('feasibility-report:load-state', () => feasibilityReportStore.loadFeasibilityReport());
  ipcMain.handle('feasibility-report:import-source-documents', (_event, filePaths) => taskService.importFeasibilitySourceDocuments(filePaths));
  ipcMain.handle('feasibility-report:remove-source-document', (_event, sourceId) => taskService.removeFeasibilitySourceDocument(sourceId));
  ipcMain.handle('feasibility-report:read-source-markdown', (_event, sourceId) => feasibilityReportStore.readSourceMarkdown(sourceId));
  ipcMain.handle('feasibility-report:read-combined-source-markdown', () => feasibilityReportStore.readCombinedSourceMarkdown());
  ipcMain.handle('feasibility-report:update-step', (_event, step) => feasibilityReportStore.updateStep(step));
  ipcMain.handle('feasibility-report:save-project-info', (_event, projectInfo) => taskService.saveFeasibilityProjectInfo(projectInfo));
  ipcMain.handle('feasibility-report:save-analysis', (_event, markdown) => taskService.saveFeasibilityAnalysis(markdown));
  ipcMain.handle('feasibility-report:save-outline-config', (_event, payload) => feasibilityReportStore.saveOutlineConfig(payload));
  ipcMain.handle('feasibility-report:save-outline', (_event, payload) => taskService.saveFeasibilityOutline(payload));
  ipcMain.handle('feasibility-report:save-key-parameters', (_event, markdown) => taskService.saveFeasibilityKeyParameters(markdown));
  ipcMain.handle('feasibility-report:save-chapter-content', (_event, payload) => feasibilityReportStore.saveChapterContent(payload));
  ipcMain.handle('feasibility-report:clear', () => taskService.resetFeasibilityReport());
}

module.exports = {
  registerFeasibilityReportIpc,
};
