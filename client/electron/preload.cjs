const { contextBridge, ipcRenderer } = require('electron');

let streamRequestId = 0;

const bridge = {
  appName: '易标投标工具箱',
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getLatestVersion: () => ipcRenderer.invoke('app:get-latest-version'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  startUpdate: () => ipcRenderer.invoke('app:start-update'),
  quitAndInstall: () => ipcRenderer.invoke('app:quit-and-install'),
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-progress', listener);
    return () => ipcRenderer.removeListener('app:update-progress', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-downloaded', listener);
    return () => ipcRenderer.removeListener('app:update-downloaded', listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-error', listener);
    return () => ipcRenderer.removeListener('app:update-error', listener);
  },
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    listModels: (config) => ipcRenderer.invoke('config:list-models', config),
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
    importRejectionCheckDocument: (role) => ipcRenderer.invoke('file:import-rejection-check-document', role),
    selectDuplicateCheckFiles: (options) => ipcRenderer.invoke('file:select-duplicate-check-files', options),
  },
  knowledgeBase: {
    list: () => ipcRenderer.invoke('knowledge-base:list'),
    createFolder: (name) => ipcRenderer.invoke('knowledge-base:create-folder', name),
    renameFolder: (folderId, name) => ipcRenderer.invoke('knowledge-base:rename-folder', folderId, name),
    deleteFolder: (folderId) => ipcRenderer.invoke('knowledge-base:delete-folder', folderId),
    deleteDocument: (documentId) => ipcRenderer.invoke('knowledge-base:delete-document', documentId),
    uploadDocuments: (folderId) => ipcRenderer.invoke('knowledge-base:upload-documents', folderId),
    startMatching: (documentId, batchSize) => ipcRenderer.invoke('knowledge-base:start-matching', documentId, batchSize),
    readMarkdown: (documentId) => ipcRenderer.invoke('knowledge-base:read-markdown', documentId),
    readItems: (documentId) => ipcRenderer.invoke('knowledge-base:read-items', documentId),
    readAnalysis: (documentId) => ipcRenderer.invoke('knowledge-base:read-analysis', documentId),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('knowledge-base:event', listener);
      return () => ipcRenderer.removeListener('knowledge-base:event', listener);
    },
  },
  duplicateCheck: {
    startMetadataAnalysis: (payload) => ipcRenderer.invoke('duplicate-check:start-metadata-analysis', payload),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('duplicate-check:event', listener);
      return () => ipcRenderer.removeListener('duplicate-check:event', listener);
    },
  },
  workspace: {
    loadTechnicalPlan: () => ipcRenderer.invoke('workspace:load-technical-plan'),
    saveTechnicalPlan: (state) => ipcRenderer.invoke('workspace:save-technical-plan', state),
    updateTechnicalPlan: (partial) => ipcRenderer.invoke('workspace:update-technical-plan', partial),
    clearTechnicalPlan: () => ipcRenderer.invoke('workspace:clear-technical-plan'),
    loadDuplicateCheck: () => ipcRenderer.invoke('workspace:load-duplicate-check'),
    saveDuplicateCheck: (state) => ipcRenderer.invoke('workspace:save-duplicate-check', state),
    clearDuplicateCheck: () => ipcRenderer.invoke('workspace:clear-duplicate-check'),
    loadRejectionCheck: () => ipcRenderer.invoke('workspace:load-rejection-check'),
    saveRejectionCheck: (state) => ipcRenderer.invoke('workspace:save-rejection-check', state),
    clearRejectionCheck: () => ipcRenderer.invoke('workspace:clear-rejection-check'),
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
    onWordExportProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('export:word-progress', listener);
      return () => ipcRenderer.removeListener('export:word-progress', listener);
    },
  },
};

contextBridge.exposeInMainWorld('yibiao', bridge);

contextBridge.exposeInMainWorld('yibiaoClient', {
  appName: bridge.appName,
  platform: bridge.platform,
});
