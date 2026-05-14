const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, shell } = require('electron');

function registerConfigIpc({ configStore, aiService }) {
  ipcMain.handle('config:load', () => configStore.load());
  ipcMain.handle('config:save', (_event, config) => configStore.save(config));
  ipcMain.handle('config:list-models', (_event, config) => aiService.listModels(config));
  ipcMain.handle('config:open-config-folder', async () => {
    const configFolder = path.dirname(configStore.getConfigFilePath());
    fs.mkdirSync(configFolder, { recursive: true });
    const errorMessage = await shell.openPath(configFolder);

    if (errorMessage) {
      throw new Error(`打开配置文件夹失败：${errorMessage}`);
    }

    return { success: true, path: configFolder };
  });
}

module.exports = {
  registerConfigIpc,
};
