const { ipcMain } = require('electron');

function registerTechnicalPlanIpc({ technicalPlanStore }) {
  ipcMain.handle('technical-plan:load-state', () => technicalPlanStore.loadTechnicalPlan());
  ipcMain.handle('technical-plan:import-tender-document', () => technicalPlanStore.importTenderDocument());
  ipcMain.handle('technical-plan:read-tender-markdown', () => technicalPlanStore.readTenderMarkdown());
  ipcMain.handle('technical-plan:update-step', (_event, step) => technicalPlanStore.updateStep(step));
  ipcMain.handle('technical-plan:save-outline-config', (_event, payload) => technicalPlanStore.saveOutlineConfig(payload));
  ipcMain.handle('technical-plan:save-outline', (_event, outlineData) => technicalPlanStore.saveOutline(outlineData));
  ipcMain.handle('technical-plan:save-global-facts', (_event, globalFacts) => technicalPlanStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('technical-plan:save-content-generation-options', (_event, options) => technicalPlanStore.saveContentGenerationOptions(options));
  ipcMain.handle('technical-plan:save-chapter-content', (_event, payload) => technicalPlanStore.saveChapterContent(payload));
  ipcMain.handle('technical-plan:clear', () => technicalPlanStore.clearTechnicalPlan());

  // 附件
  ipcMain.handle('technical-plan:import-attachment', () => technicalPlanStore.importAttachment());
  ipcMain.handle('technical-plan:list-attachments', (_event, bidSectionId) => technicalPlanStore.listAttachments(bidSectionId));
  ipcMain.handle('technical-plan:read-attachment-markdown', (_event, attachmentId) => technicalPlanStore.readAttachmentMarkdown(attachmentId));
  ipcMain.handle('technical-plan:delete-attachment', (_event, attachmentId) => technicalPlanStore.deleteAttachment(attachmentId));
  ipcMain.handle('technical-plan:set-attachment-type', (_event, attachmentId, attachmentType) =>
    technicalPlanStore.setAttachmentType(attachmentId, attachmentType));
  ipcMain.handle('technical-plan:set-attachment-bid-section', (_event, attachmentId, bidSectionId) =>
    technicalPlanStore.setAttachmentBidSection(attachmentId, bidSectionId));
  ipcMain.handle('technical-plan:save-procurement-items', (_event, attachmentId, items) =>
    technicalPlanStore.saveProcurementItems(attachmentId, items));
  ipcMain.handle('technical-plan:list-procurement-items', (_event, bidSectionId) =>
    technicalPlanStore.listProcurementItems(bidSectionId));

  // 标段
  ipcMain.handle('technical-plan:extract-bid-sections', (_event, sections) => technicalPlanStore.extractBidSections(sections));
  ipcMain.handle('technical-plan:list-bid-sections', () => technicalPlanStore.listBidSections());
  ipcMain.handle('technical-plan:has-multiple-sections', () => technicalPlanStore.hasMultipleSections());
  ipcMain.handle('technical-plan:select-bid-sections', (_event, sectionIds) => technicalPlanStore.selectBidSections(sectionIds));
  ipcMain.handle('technical-plan:switch-bid-section', (_event, sectionId) => technicalPlanStore.switchToBidSection(sectionId));
  ipcMain.handle('technical-plan:get-selected-bid-sections', () => technicalPlanStore.getSelectedBidSections());
  ipcMain.handle('technical-plan:get-current-bid-section-id', () => technicalPlanStore.getCurrentBidSectionId());
}

module.exports = {
  registerTechnicalPlanIpc,
};
