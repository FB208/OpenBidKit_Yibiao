const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const configWindows = new Map();

/**
 * 打开插件配置窗口
 */
function openPluginConfigWindow(app, pluginId, pluginService) {
  // 如果窗口已存在，激活它
  if (configWindows.has(pluginId)) {
    const existingWindow = configWindows.get(pluginId);
    if (!existingWindow.isDestroyed()) {
      existingWindow.focus();
      return;
    }
  }

  try {
    const pluginDir = path.join(app.getPath('userData'), 'plugins', pluginId);
    const manifest = pluginService.readManifest(pluginDir);

    if (!manifest || !manifest.hasConfig) {
      throw new Error('插件没有配置界面');
    }

    const configUI = manifest.configUI || './config-ui/index.html';
    const configPath = path.join(pluginDir, configUI);

    if (!fs.existsSync(configPath)) {
      throw new Error('配置界面文件不存在');
    }

    // 创建配置窗口
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      title: `${manifest.name} - 配置`,
      webPreferences: {
        preload: path.join(__dirname, '../preload-plugin-config.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--plugin-id=${pluginId}`],
      },
    });

    win.loadFile(configPath);

    // 窗口关闭时清理
    win.on('closed', () => {
      configWindows.delete(pluginId);
    });

    configWindows.set(pluginId, win);
  } catch (error) {
    console.error('[plugin-config-window] 打开配置窗口失败:', error);
    throw error;
  }
}

module.exports = {
  openPluginConfigWindow,
};
