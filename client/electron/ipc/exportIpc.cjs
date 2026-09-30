const { ipcMain, shell } = require('electron');

function registerExportIpc({ exportService, donationService }) {
  // 确认正文结构问题后继续导出属于同一次点击：不重复计数，导出提醒留到真正导出结束后显示。
  const deferredPrompts = new Map();
  ipcMain.handle('export:word', async (event, payload = {}) => {
    const requestId = payload.requestId || payload.request_id;
    const donationPrompt = payload.confirmStructureIssues === true
      ? deferredPrompts.get(requestId) ?? null
      : donationService.recordWordExport({ deferPrompt: true });
    deferredPrompts.delete(requestId);
    const sendProgress = (progress) => {
      event.sender.send('export:word-progress', { requestId, ...progress });
    };

    let result;
    try {
      result = await exportService.exportWord(payload, sendProgress);
      return result;
    } catch (error) {
      sendProgress({
        phase: 'error',
        progress: 100,
        message: error.message || '导出 Word 失败',
      });
      throw error;
    } finally {
      if (result?.needsConfirmation) deferredPrompts.set(requestId, donationPrompt);
      else donationService.showPrompt(donationPrompt);
    }
  });

  // 用户取消结构确认即结束本次导出：清理待处理请求，与保存对话框取消一致照常显示导出提醒。
  ipcMain.handle('export:cancel-word-confirmation', (_event, requestId) => {
    const donationPrompt = deferredPrompts.get(requestId) ?? null;
    deferredPrompts.delete(requestId);
    donationService.showPrompt(donationPrompt);
  });

  ipcMain.handle('export:open-file', async (_event, filePath) => {
    const targetPath = String(filePath || '').trim();
    if (!targetPath) {
      throw new Error('缺少要打开的文件路径');
    }

    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      throw new Error(`打开文件失败：${errorMessage}`);
    }

    return { success: true };
  });
}

module.exports = {
  registerExportIpc,
};
