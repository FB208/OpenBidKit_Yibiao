const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const pluginService = require('../services/pluginService.cjs');
const { openPluginConfigWindow } = require('../services/pluginConfigWindow.cjs');

/**
 * 注册插件相关 IPC
 */
function registerPluginIpc(ipcMain, app, services) {
  // 初始化插件服务
  pluginService.initialize(app, services).catch((error) => {
    console.error('[plugin-ipc] 插件服务初始化失败:', error);
  });

  // 获取可用插件列表
  ipcMain.handle('plugins:getAvailablePlugins', async () => {
    try {
      const marketPlugins = await pluginService.fetchAvailablePlugins();
      const installedPlugins = pluginService.getInstalledPlugins();
      const installedMap = new Map(installedPlugins.map(p => [p.id, p]));

      // 先处理市场插件，标记已安装状态
      const result = marketPlugins.map(plugin => ({
        ...plugin,
        installed: installedMap.has(plugin.id),
        installedVersion: installedMap.get(plugin.id)?.version,
        enabled: installedMap.get(plugin.id)?.enabled || false,
        hasConfig: installedMap.get(plugin.id)?.hasConfig || false,
        hasUpdate: installedMap.has(plugin.id) && installedMap.get(plugin.id).version !== plugin.version,
      }));

      // 合并本地已安装但市场不存在的插件
      for (const installed of installedPlugins) {
        if (!marketPlugins.find(p => p.id === installed.id)) {
          // 从本地 manifest 构造插件信息
          result.push({
            id: installed.id,
            name: installed.name,
            description: installed.manifest?.description || '',
            version: installed.version,
            author: installed.manifest?.author,
            repository: installed.manifest?.repository || '',
            releaseUrl: installed.manifest?.releaseUrl || '',
            tags: [],
            iconUrl: installed.manifest?.repository 
              ? `https://raw.githubusercontent.com/${installed.manifest.repository.match(/github\.com\/([^/]+\/[^/]+)/)?.[1]}/main/assets/icon.png`
              : '',
            downloadCount: 0,
            installed: true,
            installedVersion: installed.version,
            enabled: installed.enabled,
            hasConfig: installed.hasConfig,
            hasUpdate: false,
          });
        }
      }

      return result;
    } catch (error) {
      console.error('[plugin-ipc] 获取可用插件失败:', error);
      // 网络异常时至少返回本地已安装的插件
      try {
        const installedPlugins = pluginService.getInstalledPlugins();
        return installedPlugins.map(installed => ({
          id: installed.id,
          name: installed.name,
          description: installed.manifest?.description || '',
          version: installed.version,
          author: installed.manifest?.author,
          repository: installed.manifest?.repository || '',
          releaseUrl: installed.manifest?.releaseUrl || '',
          tags: [],
          iconUrl: '',
          downloadCount: 0,
          installed: true,
          installedVersion: installed.version,
          enabled: installed.enabled,
          hasConfig: installed.hasConfig,
          hasUpdate: false,
        }));
      } catch (fallbackError) {
        console.error('[plugin-ipc] 获取已安装插件失败:', fallbackError);
        return [];
      }
    }
  });

  // 从本地 ZIP 安装或覆盖升级插件
  ipcMain.handle('plugins:installOffline', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择插件安装包',
      properties: ['openFile'],
      filters: [{ name: '插件安装包', extensions: ['zip'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const installed = await pluginService.installOfflinePlugin(result.filePaths[0]);
    return { canceled: false, ...installed };
  });

  // 安装插件
  ipcMain.handle('plugins:install', async (event, pluginId) => {
    return await pluginService.installPlugin(pluginId);
  });

  // 卸载插件
  ipcMain.handle('plugins:uninstall', async (event, pluginId) => {
    return await pluginService.uninstallPlugin(pluginId);
  });

  // 启用插件
  ipcMain.handle('plugins:enable', async (event, pluginId) => {
    return await pluginService.enablePlugin(pluginId);
  });

  // 禁用插件
  ipcMain.handle('plugins:disable', async (event, pluginId) => {
    return await pluginService.disablePlugin(pluginId);
  });

  // 更新插件
  ipcMain.handle('plugins:update', async (event, pluginId) => {
    return await pluginService.updatePlugin(pluginId);
  });

  // 打开配置窗口
  ipcMain.handle('plugins:openConfig', async (event, pluginId) => {
    return openPluginConfigWindow(app, pluginId, pluginService);
  });

  // 刷新插件市场
  ipcMain.handle('plugins:refreshMarket', async () => {
    return await pluginService.refreshMarket();
  });

  // 插件配置读取（供配置窗口使用）
  ipcMain.handle('plugin-config:get', async (event, pluginId, key) => {
    try {
      const configPath = path.join(app.getPath('userData'), 'plugin-configs', `${pluginId}.json`);
      
      if (!fs.existsSync(configPath)) {
        return undefined;
      }
      
      const data = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(data);
      return config[key];
    } catch (error) {
      console.error('[plugin-ipc] 读取插件配置失败:', error);
      return undefined;
    }
  });

  // 插件配置写入（供配置窗口使用）
  ipcMain.handle('plugin-config:set', async (event, pluginId, key, value) => {
    try {
      const configPath = path.join(app.getPath('userData'), 'plugin-configs', `${pluginId}.json`);
      
      let config = {};
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(data);
      }
      
      config[key] = value;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      return true;
    } catch (error) {
      console.error('[plugin-ipc] 写入插件配置失败:', error);
      return false;
    }
  });
}

module.exports = {
  registerPluginIpc,
};
