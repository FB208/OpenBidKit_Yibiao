const { ipcMain, shell } = require('electron');

// 每次导出操作记录一次计数；转入正文修复也结束本次导出并显示原有提醒。
function registerExportIpc({ exportService, donationService }) {
  ipcMain.handle('export:word', async (event, payload = {}) => {
    const requestId = payload.requestId || payload.request_id;
    const donationPrompt = donationService.recordWordExport({ deferPrompt: true });
    const sendProgress = (progress) => {
      event.sender.send('export:word-progress', { requestId, ...progress });
    };

    try {
      return await exportService.exportWord(payload, sendProgress);
    } catch (error) {
      sendProgress({
        phase: 'error',
        progress: 100,
        message: error.message || '导出 Word 失败',
      });
      throw error;
    } finally {
      donationService.showPrompt(donationPrompt);
    }
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
