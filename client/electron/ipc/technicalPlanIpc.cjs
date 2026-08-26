const { ipcMain, shell } = require('electron');

function registerTechnicalPlanIpc({ technicalPlanStore, taskService }) {
  ipcMain.handle('technical-plan:load-state', () => technicalPlanStore.loadTechnicalPlan());
  ipcMain.handle('technical-plan:load-generation-config', () => technicalPlanStore.loadGenerationConfig());
  ipcMain.handle('technical-plan:save-generation-config', (_event, partial) => technicalPlanStore.saveGenerationConfig(partial));
  ipcMain.handle('technical-plan:import-tender-document', (_event, filePaths) => taskService.importTenderDocument(filePaths));
  ipcMain.handle('technical-plan:remove-tender-document', (_event, sourceId) => taskService.removeTenderDocument(sourceId));
  ipcMain.handle('technical-plan:import-original-plan-document', (_event, filePaths) => taskService.importOriginalPlanDocument(filePaths));
  ipcMain.handle('technical-plan:remove-original-plan-document', () => taskService.removeOriginalPlanDocument());
  ipcMain.handle('technical-plan:check-bid-sections', () => technicalPlanStore.checkBidSections());
  ipcMain.handle('technical-plan:select-bid-section', (_event, selectedSection) => technicalPlanStore.selectBidSection(selectedSection));
  ipcMain.handle('technical-plan:read-tender-markdown', () => technicalPlanStore.readTenderMarkdown());
  ipcMain.handle('technical-plan:read-tender-source-markdown', (_event, sourceId) => technicalPlanStore.readTenderSourceMarkdown(sourceId));
  ipcMain.handle('technical-plan:update-step', (_event, step) => technicalPlanStore.updateStep(step));
  ipcMain.handle('technical-plan:save-bid-analysis-config', (_event, payload) => technicalPlanStore.saveBidAnalysisConfig(payload));
  ipcMain.handle('technical-plan:save-outline-selection', (_event, payload) => technicalPlanStore.saveOutlineSelection(payload));
  ipcMain.handle('technical-plan:save-outline', (_event, outlineData) => technicalPlanStore.saveOutline(outlineData));
  ipcMain.handle('technical-plan:save-global-facts-config', (_event, payload) => technicalPlanStore.saveGlobalFactsConfig(payload));
  ipcMain.handle('technical-plan:save-global-facts', (_event, globalFacts) => technicalPlanStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('technical-plan:save-content-generation-options', (_event, options) => technicalPlanStore.saveContentGenerationOptions(options));
  ipcMain.handle('technical-plan:save-chapter-content', (_event, payload) => technicalPlanStore.saveChapterContent(payload));
  ipcMain.handle('technical-plan:reset-content-generation', () => taskService.resetContentGeneration());
  ipcMain.handle('technical-plan:clear', () => taskService.resetTechnicalPlan());
  ipcMain.handle('technical-plan:open-bid-template', async () => {
    const filePath = technicalPlanStore.getBidTemplatePath?.();
    if (!filePath || !technicalPlanStore.hasBidTemplate?.()) {
      return { success: false, message: '还没有投标模版，请先确认一级目录' };
    }
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) {
      return { success: false, message: errorMessage };
    }
    return { success: true };
  });
}

module.exports = {
  registerTechnicalPlanIpc,
};
