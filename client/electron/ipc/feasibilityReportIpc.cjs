const { ipcMain } = require('electron');

function registerFeasibilityReportIpc({ feasibilityReportStore }) {
  ipcMain.handle('feasibility-report:load-state', () => feasibilityReportStore.loadFeasibilityReport());
  ipcMain.handle('feasibility-report:import-source-documents', () => feasibilityReportStore.importSourceDocuments());
  ipcMain.handle('feasibility-report:read-source-markdown', (_event, sourceId) => feasibilityReportStore.readSourceMarkdown(sourceId));
  ipcMain.handle('feasibility-report:read-combined-source-markdown', () => feasibilityReportStore.readCombinedSourceMarkdown());
  ipcMain.handle('feasibility-report:update-step', (_event, step) => feasibilityReportStore.updateStep(step));
  ipcMain.handle('feasibility-report:save-project-info', (_event, projectInfo) => feasibilityReportStore.saveProjectInfo(projectInfo));
  ipcMain.handle('feasibility-report:save-analysis', (_event, markdown) => feasibilityReportStore.saveAnalysis(markdown));
  ipcMain.handle('feasibility-report:save-outline-config', (_event, payload) => feasibilityReportStore.saveOutlineConfig(payload));
  ipcMain.handle('feasibility-report:save-outline', (_event, outlineData) => feasibilityReportStore.saveOutline(outlineData));
  ipcMain.handle('feasibility-report:save-key-parameters', (_event, markdown) => feasibilityReportStore.saveKeyParameters(markdown));
  ipcMain.handle('feasibility-report:save-chapter-content', (_event, payload) => feasibilityReportStore.saveChapterContent(payload));
  ipcMain.handle('feasibility-report:clear', () => feasibilityReportStore.clearFeasibilityReport());
  ipcMain.handle('feasibility-report:run-validation-check', () => {
    const { runFeasibilityValidationCheck } = require('../services/feasibilityReportTasks.cjs');
    return runFeasibilityValidationCheck(feasibilityReportStore.loadFeasibilityReport());
  });
  ipcMain.handle('feasibility-report:run-consistency-check', () => {
    const { runFeasibilityConsistencyCheck } = require('../services/feasibilityReportTasks.cjs');
    return runFeasibilityConsistencyCheck(feasibilityReportStore.loadFeasibilityReport());
  });
  ipcMain.handle('feasibility-report:save-financial-data', (_event, financialData) => feasibilityReportStore.updateFeasibilityReport({ financialData }));
  ipcMain.handle('feasibility-report:calculate-financials', (_event, payload = {}) => {
    const { calculateFinancials } = require('../services/financialCalculator.cjs');
    const state = feasibilityReportStore.loadFeasibilityReport();
    return calculateFinancials(payload.investment || state.financialData?.investment, payload.operating || state.financialData?.operating, state.projectInfo);
  });
  ipcMain.handle('feasibility-report:sync-financials-to-content', () => {
    const { syncFinancialsToOutlineAndContent } = require('../services/feasibilityReportTasks.cjs');
    return syncFinancialsToOutlineAndContent(feasibilityReportStore);
  });
}

module.exports = {
  registerFeasibilityReportIpc,
};
