const { ipcMain } = require('electron');

function registerTaskIpc({ taskService }) {
  ipcMain.handle('tasks:start-bid-section-extraction', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startBidSectionExtraction(payload);
  });
  ipcMain.handle('tasks:start-bid-analysis', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startBidAnalysis(payload);
  });
  ipcMain.handle('tasks:start-outline-generation', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startOutlineGeneration(payload);
  });
  ipcMain.handle('tasks:start-global-facts-generation', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startGlobalFactsGeneration(payload);
  });
  ipcMain.handle('tasks:start-content-generation', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startContentGeneration(payload);
  });
  ipcMain.handle('tasks:pause-content-generation', (event) => {
    taskService.subscribe(event.sender);
    return taskService.pauseContentGeneration();
  });
  ipcMain.handle('tasks:start-rejection-items-extraction', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startRejectionItemsExtraction(payload);
  });
  ipcMain.handle('tasks:start-rejection-check', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startRejectionCheck(payload);
  });
  ipcMain.handle('tasks:start-duplicate-analysis', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startDuplicateAnalysis(payload);
  });
  ipcMain.handle('tasks:get-active', (event) => {
    taskService.subscribe(event.sender);
    return taskService.getActiveTasks();
  });
  ipcMain.on('tasks:subscribe', (event) => {
    taskService.subscribe(event.sender);
  });
}

module.exports = { registerTaskIpc };
