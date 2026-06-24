const { ipcMain } = require('electron');

function registerAgentIpc({ agentService }) {
  ipcMain.handle('agent:run', async (_event, payload) => agentService.runTask(payload));
  ipcMain.handle('agent:self-check', async () => agentService.selfCheck());
  ipcMain.handle('agent:export-self-check-report', async (_event, payload) => agentService.exportSelfCheckReport(payload));
}

module.exports = {
  registerAgentIpc,
};
