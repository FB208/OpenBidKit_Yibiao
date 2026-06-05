const { ipcMain } = require('electron');

function registerTechnicalPlanIpc({ technicalPlanStore }) {
  ipcMain.handle('technical-plan:load-state', () => technicalPlanStore.loadTechnicalPlan());
  ipcMain.handle('technical-plan:import-tender-document', () => technicalPlanStore.importTenderDocument());
  ipcMain.handle('technical-plan:select-bid-section', (_event, pendingMarkdownPath, sectionId) => technicalPlanStore.selectBidSection(pendingMarkdownPath, sectionId));
  ipcMain.handle('technical-plan:cancel-bid-section-selection', (_event, pendingMarkdownPath) => technicalPlanStore.cancelBidSectionSelection(pendingMarkdownPath));
  ipcMain.handle('technical-plan:read-tender-markdown', () => technicalPlanStore.readTenderMarkdown());
  ipcMain.handle('technical-plan:update-step', (_event, step) => technicalPlanStore.updateStep(step));
  ipcMain.handle('technical-plan:save-outline-config', (_event, payload) => technicalPlanStore.saveOutlineConfig(payload));
  ipcMain.handle('technical-plan:save-outline', (_event, outlineData) => technicalPlanStore.saveOutline(outlineData));
  ipcMain.handle('technical-plan:save-global-facts', (_event, globalFacts) => technicalPlanStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('technical-plan:save-content-generation-options', (_event, options) => technicalPlanStore.saveContentGenerationOptions(options));
  ipcMain.handle('technical-plan:save-chapter-content', (_event, payload) => technicalPlanStore.saveChapterContent(payload));
  ipcMain.handle('technical-plan:clear', () => technicalPlanStore.clearTechnicalPlan());
}

module.exports = {
  registerTechnicalPlanIpc,
};
