const { ipcMain } = require('electron');

function registerFileIpc({ fileService }) {
  ipcMain.handle('file:select-duplicate-check-files', (_event, options) => fileService.selectDuplicateCheckFiles(options));
  ipcMain.handle('file:select-blind-check-file', (_event, options) => fileService.selectBlindCheckFile(options));
  ipcMain.handle('file:select-blind-check-tender-file', () => fileService.selectBlindCheckTenderFile());
}

module.exports = {
  registerFileIpc,
};
