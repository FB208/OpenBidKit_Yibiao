const { ipcMain } = require('electron');

function registerAgentIpc({ agentService }) {
  ipcMain.handle('agent:run', async (_event, payload) => agentService.runTask(payload));
}

module.exports = {
  registerAgentIpc,
};
