const { ipcMain } = require('electron');

function registerDualLayerPdfIpc({ dualLayerPdfService }) {
  ipcMain.handle('dual-layer-pdf:get-state', () => dualLayerPdfService.getState());
  ipcMain.handle('dual-layer-pdf:get-environment', () => dualLayerPdfService.getEnvironment());
  ipcMain.handle('dual-layer-pdf:select-files', () => dualLayerPdfService.selectFiles());
  ipcMain.handle('dual-layer-pdf:add-files', (_event, filePaths) => dualLayerPdfService.addFiles(filePaths));
  ipcMain.handle('dual-layer-pdf:remove-item', (_event, itemId) => dualLayerPdfService.removeItem(itemId));
  ipcMain.handle('dual-layer-pdf:retry-item', (_event, itemId) => dualLayerPdfService.retryItem(itemId));
  ipcMain.handle('dual-layer-pdf:select-output-dir', () => dualLayerPdfService.selectOutputDir());
  ipcMain.handle('dual-layer-pdf:reset-output-dir', () => dualLayerPdfService.resetOutputDir());
  ipcMain.handle('dual-layer-pdf:set-outputs', (_event, outputs) => dualLayerPdfService.setOutputs(outputs));
  ipcMain.handle('dual-layer-pdf:start', () => dualLayerPdfService.start());
  ipcMain.handle('dual-layer-pdf:cancel', () => dualLayerPdfService.cancel());
  ipcMain.handle('dual-layer-pdf:clear', () => dualLayerPdfService.clear());
  ipcMain.handle('dual-layer-pdf:show-in-folder', (_event, filePath) => dualLayerPdfService.showInFolder(filePath));
  // 隐藏工作窗口专用：逐页提交图片和文字。
  ipcMain.handle('dual-layer-pdf-worker:page', (event, payload) => dualLayerPdfService.handleWorkerPage(event.sender, payload));
}

module.exports = {
  registerDualLayerPdfIpc,
};
