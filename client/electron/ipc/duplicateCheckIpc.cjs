const { ipcMain } = require('electron');

function registerDuplicateCheckIpc({ duplicateCheckService }) {
  ipcMain.handle('duplicate-check:start-metadata-analysis', (event, payload) => duplicateCheckService.startMetadataAnalysis(payload, event.sender));
}

module.exports = { registerDuplicateCheckIpc };
