const { ipcMain } = require('electron');

function registerFileIpc({ fileService }) {
  ipcMain.handle('file:import-document', () => fileService.importDocument());
  ipcMain.handle('file:select-duplicate-check-files', (_event, options) => fileService.selectDuplicateCheckFiles(options));
}

module.exports = {
  registerFileIpc,
};
