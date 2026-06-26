const { ipcMain } = require('electron');

function registerSystemFontIpc({ systemFontService }) {
  ipcMain.handle('system-fonts:list', () => systemFontService.list());
}

module.exports = {
  registerSystemFontIpc,
};
