const { contextBridge, ipcRenderer } = require('electron');

// 从启动参数中获取 pluginId
const pluginId = process.argv.find(arg => arg.startsWith('--plugin-id='))?.split('=')[1];

if (!pluginId) {
  console.error('[preload-plugin-config] 缺少 pluginId 参数');
}

// 暴露插件配置 API
contextBridge.exposeInMainWorld('pluginConfig', {
  get: (key) => ipcRenderer.invoke('plugin-config:get', pluginId, key),
  set: (key, value) => ipcRenderer.invoke('plugin-config:set', pluginId, key, value),
});
