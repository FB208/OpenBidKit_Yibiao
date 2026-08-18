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
  ipcMain.handle('tasks:confirm-outline-selection', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.confirmOutlineSelection(payload);
  });
  ipcMain.handle('tasks:suppress-outline-selection-auto-confirmation', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.suppressOutlineSelectionAutoConfirmation(payload);
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
  ipcMain.handle('tasks:start-feasibility-analysis', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startFeasibilityAnalysis(payload);
  });
  ipcMain.handle('tasks:start-feasibility-outline', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startFeasibilityOutline(payload);
  });
  ipcMain.handle('tasks:start-feasibility-parameters', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startFeasibilityParameters(payload);
  });
  ipcMain.handle('tasks:start-feasibility-content', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startFeasibilityContent(payload);
  });
  ipcMain.handle('tasks:pause-feasibility-content', (event) => {
    taskService.subscribe(event.sender);
    return taskService.pauseFeasibilityContent();
  });
  ipcMain.handle('tasks:start-feasibility-human-writing', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startFeasibilityHumanWriting(payload);
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
