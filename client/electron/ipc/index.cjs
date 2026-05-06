const { registerAiIpc } = require('./aiIpc.cjs');
const { registerConfigIpc } = require('./configIpc.cjs');
const { registerExportIpc } = require('./exportIpc.cjs');
const { registerFileIpc } = require('./fileIpc.cjs');
const { registerTaskIpc } = require('./taskIpc.cjs');
const { registerWorkspaceIpc } = require('./workspaceIpc.cjs');
const { createAiService } = require('../services/aiService.cjs');
const { createConfigStore } = require('../services/configStore.cjs');
const { createExportService } = require('../services/exportService.cjs');
const { createFileService } = require('../services/fileService.cjs');
const { createTaskService } = require('../services/taskService.cjs');
const { createWorkspaceStore } = require('../services/workspaceStore.cjs');

function registerIpcHandlers(app) {
  const configStore = createConfigStore(app);
  const aiService = createAiService({ app, configStore });
  const fileService = createFileService({ configStore });
  const exportService = createExportService();
  const workspaceStore = createWorkspaceStore(app);
  const taskService = createTaskService({ aiService, workspaceStore });

  registerConfigIpc({ configStore, aiService });
  registerAiIpc({ aiService });
  registerFileIpc({ fileService });
  registerExportIpc({ exportService });
  registerWorkspaceIpc({ workspaceStore });
  registerTaskIpc({ taskService });
}

module.exports = {
  registerIpcHandlers,
};
