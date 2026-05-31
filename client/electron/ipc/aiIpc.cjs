const { ipcMain } = require('electron');

function registerAiIpc({ aiService }) {
  ipcMain.handle('ai:chat', (_event, request) => aiService.chat(request));
  ipcMain.handle('ai:request-json', (_event, request) => aiService.requestJson(request));
  ipcMain.handle('ai:test-image-model', (_event, config) => aiService.testImageModel(config));
}

module.exports = {
  registerAiIpc,
};
