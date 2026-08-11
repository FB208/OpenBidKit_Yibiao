const { ipcMain } = require('electron');
const { exportPdf } = require('../services/businessBidPdfService.cjs');

function registerBusinessBidIpc({ businessBidStore }) {
  ipcMain.handle('business-bid:load-state', () => businessBidStore.loadBusinessBid());
  ipcMain.handle('business-bid:import-tender-document', () => businessBidStore.importTenderDocument());
  ipcMain.handle('business-bid:read-tender-markdown', () => businessBidStore.readTenderMarkdown());
  ipcMain.handle('business-bid:associate-technical-plan', () => businessBidStore.associateTechnicalPlan());
  ipcMain.handle('business-bid:disassociate-technical-plan', () => businessBidStore.disassociateTechnicalPlan());
  ipcMain.handle('business-bid:has-technical-plan', () => businessBidStore.hasTechnicalPlan());
  ipcMain.handle('business-bid:update-step', (_event, step) => businessBidStore.updateStep(step));
  ipcMain.handle('business-bid:save-outline-config', (_event, payload) => businessBidStore.saveOutlineConfig(payload));
  ipcMain.handle('business-bid:save-outline', (_event, outlineData) => businessBidStore.saveOutline(outlineData));
  ipcMain.handle('business-bid:save-global-facts', (_event, globalFacts) => businessBidStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('business-bid:save-clause-items', (_event, clauseItems) => businessBidStore.saveClauseItems(clauseItems));
  ipcMain.handle('business-bid:save-content-generation-options', (_event, options) => businessBidStore.saveContentGenerationOptions(options));
  ipcMain.handle('business-bid:save-chapter-content', (_event, payload) => businessBidStore.saveChapterContent(payload));
  ipcMain.handle('business-bid:clear', () => businessBidStore.clearBusinessBid());
  ipcMain.handle('business-bid:export-pdf', (_event, clauseItems) => exportPdf(clauseItems));
}

module.exports = {
  registerBusinessBidIpc,
};
