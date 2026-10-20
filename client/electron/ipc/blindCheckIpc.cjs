const { ipcMain } = require('electron');

function registerBlindCheckIpc({ blindCheckStore, taskService, checkResultExportService }) {
  ipcMain.handle('blind-check:load-state', () => blindCheckStore.loadBlindCheck());
  ipcMain.handle('blind-check:import-file', (_event, filePath) => taskService.importBlindCheckFile(filePath));
  ipcMain.handle('blind-check:remove-file', () => taskService.removeBlindCheckFile());
  ipcMain.handle('blind-check:save-ui-state', (_event, payload) => blindCheckStore.saveUiState(payload));
  ipcMain.handle('blind-check:list-presets', () => blindCheckStore.listPresets());
  ipcMain.handle('blind-check:create-preset', (_event, payload) => blindCheckStore.createPreset(payload));
  ipcMain.handle('blind-check:update-preset', (_event, presetId, patch) => blindCheckStore.updatePreset(presetId, patch));
  ipcMain.handle('blind-check:delete-preset', (_event, presetId) => blindCheckStore.deletePreset(presetId));
  ipcMain.handle('blind-check:select-preset', (_event, presetId) => blindCheckStore.selectPreset(presetId));
  ipcMain.handle('blind-check:set-use-credential-words', (_event, enabled) => blindCheckStore.setUseCredentialWords(enabled));
  ipcMain.handle('blind-check:get-credential-words', () => blindCheckStore.getCredentialWords());
  ipcMain.handle('blind-check:get-input-signature', () => blindCheckStore.getInputSignature());
  ipcMain.handle('blind-check:save-fix-rules', (_event, rules) => blindCheckStore.saveFixRules(rules));
  ipcMain.handle('blind-check:save-fixed-document', () => checkResultExportService.saveBlindCheckFixedDocument());
  ipcMain.handle('blind-check:get-tender-sources', () => blindCheckStore.getTenderSources());
  ipcMain.handle('blind-check:clear', () => taskService.resetBlindCheck());
}

module.exports = {
  registerBlindCheckIpc,
};
