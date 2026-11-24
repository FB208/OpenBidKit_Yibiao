const { ipcMain } = require('electron');

// 注册 AI 请求和模型测试的 IPC 转发。
function registerAiIpc({ aiService }) {
  ipcMain.handle('ai:chat', (_event, request) => aiService.chat(request));
  ipcMain.handle('ai:request-json', (_event, request) => aiService.requestJson(request));
  ipcMain.handle('ai:test-image-model', (_event, config) => aiService.testImageModel(config));
  ipcMain.handle('ai:test-jev', (_event, input) => aiService.testJev(input));
}

module.exports = {
  registerAiIpc,
};
