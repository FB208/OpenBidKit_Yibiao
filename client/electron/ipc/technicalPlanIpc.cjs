const { ipcMain } = require('electron');

function registerTechnicalPlanIpc({ technicalPlanStore, taskService }) {
  ipcMain.handle('technical-plan:load-state', () => technicalPlanStore.loadTechnicalPlan());
  ipcMain.handle('technical-plan:import-tender-document', () => technicalPlanStore.importTenderDocument());
  ipcMain.handle('technical-plan:import-original-plan-document', () => technicalPlanStore.importOriginalPlanDocument());
  ipcMain.handle('technical-plan:check-bid-sections', () => technicalPlanStore.checkBidSections());
  ipcMain.handle('technical-plan:select-bid-section', (_event, selectedSection) => technicalPlanStore.selectBidSection(selectedSection));
  ipcMain.handle('technical-plan:read-tender-markdown', () => technicalPlanStore.readTenderMarkdown());
  ipcMain.handle('technical-plan:read-tender-source-markdown', (_event, sourceId) => technicalPlanStore.readTenderSourceMarkdown(sourceId));
  ipcMain.handle('technical-plan:read-original-plan-markdown', () => technicalPlanStore.readOriginalPlanMarkdown());
  ipcMain.handle('technical-plan:update-step', (_event, step) => technicalPlanStore.updateStep(step));
  ipcMain.handle('technical-plan:set-workflow-kind', (_event, workflowKind) => technicalPlanStore.setWorkflowKind(workflowKind));
  ipcMain.handle('technical-plan:switch-workflow-kind', (_event, workflowKind) => technicalPlanStore.switchWorkflowKind(workflowKind));
  ipcMain.handle('technical-plan:save-bid-analysis-config', (_event, payload) => technicalPlanStore.saveBidAnalysisConfig(payload));
  ipcMain.handle('technical-plan:save-outline-config', (_event, payload) => technicalPlanStore.saveOutlineConfig(payload));
  ipcMain.handle('technical-plan:save-outline-selection', (_event, payload) => technicalPlanStore.saveOutlineSelection(payload));
  ipcMain.handle('technical-plan:save-outline', (_event, outlineData) => technicalPlanStore.saveOutline(outlineData));
  ipcMain.handle('technical-plan:save-global-facts', (_event, globalFacts) => technicalPlanStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('technical-plan:save-content-generation-options', (_event, options) => technicalPlanStore.saveContentGenerationOptions(options));
  ipcMain.handle('technical-plan:save-chapter-content', (_event, payload) => technicalPlanStore.saveChapterContent(payload));
  ipcMain.handle('technical-plan:clear', () => taskService.resetTechnicalPlan());
}

module.exports = {
  registerTechnicalPlanIpc,
};
