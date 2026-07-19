const { ipcMain } = require('electron');

function registerAgentIpc({ agentService, mainWindow }) {
  ipcMain.handle('agent:list-runtimes', async () => agentService.listRuntimes());
  ipcMain.handle('agent:run', async (_event, payload, runtimeId) => agentService.runTask(payload, runtimeId));
  ipcMain.handle('agent:self-check', async (_event, runtimeId) => agentService.selfCheck(runtimeId));
  ipcMain.handle('agent:export-self-check-report', async (_event, payload) => agentService.exportSelfCheckReport(payload));
  ipcMain.handle('agent:get-status', async (_event, runtimeId) => agentService.getStatus(runtimeId));
  ipcMain.handle('agent:restart', async (_event, reason, runtimeId) => agentService.restart(reason || 'manual', runtimeId));

  agentService.onStatus?.((status) => {
    if (!mainWindow?.isDestroyed?.() && !mainWindow?.webContents?.isDestroyed?.()) {
      mainWindow.webContents.send('agent:status', status);
    }
  });
}

module.exports = {
  registerAgentIpc,
};
