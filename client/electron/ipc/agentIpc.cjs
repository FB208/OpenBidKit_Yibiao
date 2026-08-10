const { ipcMain } = require('electron');

function registerAgentIpc({ agentService }) {
  const subscribers = new Set();

  const subscribe = (webContents) => {
    if (!webContents || webContents.isDestroyed() || subscribers.has(webContents)) return;
    subscribers.add(webContents);
    webContents.once('destroyed', () => subscribers.delete(webContents));
  };

  const broadcast = (channel, payload) => {
    subscribers.forEach((webContents) => {
      if (webContents.isDestroyed()) {
        subscribers.delete(webContents);
      } else {
        webContents.send(channel, payload);
      }
    });
  };

  ipcMain.handle('agent:run', async (event, payload) => {
    subscribe(event.sender);
    return agentService.runTask(payload);
  });
  ipcMain.handle('agent:self-check', async () => agentService.selfCheck());
  ipcMain.handle('agent:export-self-check-report', async (_event, payload) => agentService.exportSelfCheckReport(payload));
  ipcMain.handle('agent:get-status', async (event) => {
    subscribe(event.sender);
    return agentService.getStatus();
  });
  ipcMain.handle('agent:restart', async (_event, reason) => agentService.restart(reason || 'manual'));
  ipcMain.handle('agent:get-pending-question', async (event) => {
    subscribe(event.sender);
    return agentService.getPendingQuestion();
  });
  ipcMain.handle('agent:answer-question', async (_event, payload) => agentService.answerQuestion(payload));
  ipcMain.handle('agent:suppress-question-auto-answer', async (_event, payload) => agentService.suppressQuestionAutoAnswer(payload));
  ipcMain.on('agent:subscribe', (event) => subscribe(event.sender));

  agentService.onStatus?.((status) => {
    broadcast('agent:status', status);
  });

  agentService.onQuestion?.((question) => {
    broadcast('agent:question-state', question);
  });

}

module.exports = {
  registerAgentIpc,
};
