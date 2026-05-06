const { ipcMain } = require('electron');

function registerAiIpc({ aiService }) {
  ipcMain.handle('ai:chat', (_event, request) => aiService.chat(request));
  ipcMain.handle('ai:request-json', (_event, request) => aiService.requestJson(request));
  ipcMain.handle('ai:test-image-model', (_event, config) => aiService.testImageModel(config));
  ipcMain.on('ai:stream-chat', async (event, requestId, request) => {
    const channel = `ai:stream-chat:event:${requestId}`;

    try {
      await aiService.streamChat(request, (payload) => event.sender.send(channel, payload));
    } catch (error) {
      event.sender.send(channel, {
        type: 'error',
        message: error instanceof Error ? error.message : 'AI 流式请求失败',
      });
    }
  });
}

module.exports = {
  registerAiIpc,
};
