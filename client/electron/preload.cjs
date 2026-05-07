const { contextBridge, ipcRenderer } = require('electron');

let streamRequestId = 0;

const bridge = {
  appName: '易标投标工具箱',
  platform: process.platform,
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    listModels: () => ipcRenderer.invoke('config:list-models'),
    openConfigFolder: () => ipcRenderer.invoke('config:open-config-folder'),
  },
  ai: {
    chat: (request) => ipcRenderer.invoke('ai:chat', request),
    requestJson: (request) => ipcRenderer.invoke('ai:request-json', request),
    testImageModel: (config) => ipcRenderer.invoke('ai:test-image-model', config),
    streamChat: (request, onEvent) => {
      const requestId = ++streamRequestId;
      const channel = `ai:stream-chat:event:${requestId}`;
      const listener = (_event, payload) => onEvent(payload);
      ipcRenderer.on(channel, listener);
      ipcRenderer.send('ai:stream-chat', requestId, request);

      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },
  file: {
    importDocument: () => ipcRenderer.invoke('file:import-document'),
  },
  workspace: {
    loadTechnicalPlan: () => ipcRenderer.invoke('workspace:load-technical-plan'),
    saveTechnicalPlan: (state) => ipcRenderer.invoke('workspace:save-technical-plan', state),
    updateTechnicalPlan: (partial) => ipcRenderer.invoke('workspace:update-technical-plan', partial),
    clearTechnicalPlan: () => ipcRenderer.invoke('workspace:clear-technical-plan'),
  },
  tasks: {
    startBidAnalysis: (payload) => ipcRenderer.invoke('tasks:start-bid-analysis', payload),
    startOutlineGeneration: (payload) => ipcRenderer.invoke('tasks:start-outline-generation', payload),
    startContentGeneration: (payload) => ipcRenderer.invoke('tasks:start-content-generation', payload),
    getActiveTasks: () => ipcRenderer.invoke('tasks:get-active'),
    onTaskEvent: (callback) => {
      ipcRenderer.send('tasks:subscribe');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('tasks:event', listener);
      return () => ipcRenderer.removeListener('tasks:event', listener);
    },
  },
  export: {
    exportWord: (payload) => ipcRenderer.invoke('export:word', payload),
  },
};

contextBridge.exposeInMainWorld('yibiao', bridge);

contextBridge.exposeInMainWorld('yibiaoClient', {
  appName: bridge.appName,
  platform: bridge.platform,
});
