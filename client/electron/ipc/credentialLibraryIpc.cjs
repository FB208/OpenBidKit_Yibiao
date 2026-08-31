const { dialog, ipcMain } = require('electron');

/** 注册资信库数据库和原图文件操作。 */
function registerCredentialLibraryIpc({ credentialLibraryService, configStore }) {
  ipcMain.handle('credential-library:load', () => credentialLibraryService.load());
  ipcMain.handle('credential-library:import-test-data', async () => {
    if (!configStore.load()?.developer_mode) throw new Error('请先开启开发者模式');
    const result = await dialog.showOpenDialog({
      title: '选择资信库测试数据文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return credentialLibraryService.importTestData(result.filePaths[0]);
  });
  ipcMain.handle('credential-library:save-profile', (_event, partial) => credentialLibraryService.saveProfile(partial));
  ipcMain.handle('credential-library:add-profile-images', (_event, fieldKey, filePaths) => credentialLibraryService.addProfileImages(fieldKey, filePaths));
  ipcMain.handle('credential-library:delete-image', (_event, imageId) => credentialLibraryService.deleteImage(imageId));
  ipcMain.handle('credential-library:save-certificate', (_event, payload) => credentialLibraryService.saveCertificate(payload));
  ipcMain.handle('credential-library:delete-certificate', (_event, recordId) => credentialLibraryService.deleteCertificate(recordId));
  ipcMain.handle('credential-library:save-employee', (_event, payload) => credentialLibraryService.saveEmployee(payload));
  ipcMain.handle('credential-library:delete-employee', (_event, recordId) => credentialLibraryService.deleteEmployee(recordId));
  ipcMain.handle('credential-library:save-project', (_event, payload) => credentialLibraryService.saveProject(payload));
  ipcMain.handle('credential-library:delete-project', (_event, recordId) => credentialLibraryService.deleteProject(recordId));
  ipcMain.handle('credential-library:save-other-material', (_event, payload) => credentialLibraryService.saveOtherMaterial(payload));
  ipcMain.handle('credential-library:delete-other-material', (_event, recordId) => credentialLibraryService.deleteOtherMaterial(recordId));
}

module.exports = {
  registerCredentialLibraryIpc,
};
