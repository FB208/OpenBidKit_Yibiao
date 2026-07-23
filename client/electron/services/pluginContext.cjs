const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

/**
 * 为插件创建固定的运行上下文
 * @param {object} app - Electron app 实例
 * @param {string} pluginId - 插件 ID
 * @param {object} services - 主程序服务
 * @returns {object} 插件上下文
 */
function createPluginContext(app, pluginId, services) {
  const pluginConfigPath = path.join(app.getPath('userData'), 'plugin-configs', `${pluginId}.json`);

  // 插件专用配置存储
  const store = {
    get(key) {
      try {
        if (!fs.existsSync(pluginConfigPath)) {
          return undefined;
        }
        const data = fs.readFileSync(pluginConfigPath, 'utf-8');
        const config = JSON.parse(data);
        return config[key];
      } catch (error) {
        console.error(`[plugin-context] Failed to read config for plugin ${pluginId}:`, error);
        return undefined;
      }
    },

    set(key, value) {
      try {
        let config = {};
        if (fs.existsSync(pluginConfigPath)) {
          const data = fs.readFileSync(pluginConfigPath, 'utf-8');
          config = JSON.parse(data);
        }
        config[key] = value;
        fs.mkdirSync(path.dirname(pluginConfigPath), { recursive: true });
        fs.writeFileSync(pluginConfigPath, JSON.stringify(config, null, 2), 'utf-8');
        return true;
      } catch (error) {
        console.error(`[plugin-context] Failed to write config for plugin ${pluginId}:`, error);
        return false;
      }
    },
  };

  // 插件日志
  const logger = {
    info(...args) {
      console.log(`[plugin:${pluginId}]`, ...args);
    },
    warn(...args) {
      console.warn(`[plugin:${pluginId}]`, ...args);
    },
    error(...args) {
      console.error(`[plugin:${pluginId}]`, ...args);
    },
  };

  // 插件运行在可信的 Electron Main 环境中，固定提供全部上下文 API。
  const context = {
    app,
    ipcMain: require('electron').ipcMain,
    store,
    logger,
    getActiveTasks() {
      if (services.taskService) {
        return services.taskService.getActiveTasks();
      }
      return [];
    },
    getTechnicalPlanState() {
      if (services.technicalPlanStore) {
        return services.technicalPlanStore.loadTechnicalPlan();
      }
      return null;
    },
    getDuplicateCheckState() {
      if (services.duplicateCheckStore) {
        return services.duplicateCheckStore.loadDuplicateCheck();
      }
      return null;
    },
    getRejectionCheckState() {
      if (services.rejectionCheckStore) {
        return services.rejectionCheckStore.loadRejectionCheck();
      }
      return null;
    },
    onTaskEvent(callback) {
      if (!services.taskService) {
        return () => {};
      }

      const listener = (event) => {
        try {
          callback(event);
        } catch (error) {
          logger.error('Task event callback error:', error);
        }
      };

      return services.taskService.subscribeCallback(listener);
    },
    createWindow(options = {}) {
      const defaultOptions = {
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      };

      const win = new BrowserWindow({
        ...defaultOptions,
        ...options,
      });

      return win;
    },
  };

  return context;
}

module.exports = {
  createPluginContext,
};
