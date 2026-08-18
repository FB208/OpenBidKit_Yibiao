const { ipcMain } = require('electron');

function registerKnowledgeBaseIpc({ knowledgeBaseService }) {
  ipcMain.handle('knowledge-base:list', (_event, type) => knowledgeBaseService.list(type));
  ipcMain.handle('knowledge-base:create-folder', (_event, name, type, parentId) => knowledgeBaseService.createFolder(name, type, parentId));
  ipcMain.handle('knowledge-base:rename-folder', (_event, folderId, name) => knowledgeBaseService.renameFolder(folderId, name));
  ipcMain.handle('knowledge-base:reorder-folder', (_event, draggedFolderId, targetFolderId, position, parentId) => knowledgeBaseService.reorderFolder(draggedFolderId, targetFolderId, position, parentId));
  ipcMain.handle('knowledge-base:delete-folder', (_event, folderId) => knowledgeBaseService.deleteFolder(folderId));
  ipcMain.handle('knowledge-base:move-folder', (_event, folderId, targetParentId) => knowledgeBaseService.moveFolder(folderId, targetParentId));
  ipcMain.handle('knowledge-base:delete-document', (_event, documentId) => knowledgeBaseService.deleteDocument(documentId));
  ipcMain.handle('knowledge-base:move-document', (_event, documentId, targetFolderId, targetDocumentId, position) => knowledgeBaseService.moveDocument(documentId, targetFolderId, targetDocumentId, position));
  ipcMain.handle('knowledge-base:upload-documents', (event, folderId) => knowledgeBaseService.uploadDocuments(folderId, event.sender));
  ipcMain.handle('knowledge-base:retry-document', (event, documentId) => knowledgeBaseService.retryDocument(documentId, event.sender));
  // batchSize 已忽略，服务端按模型上下文自动分段匹配
  ipcMain.handle('knowledge-base:start-matching', (event, documentId, batchSize) => knowledgeBaseService.startMatching(documentId, batchSize, event.sender));
  ipcMain.handle('knowledge-base:read-markdown', (_event, documentId) => knowledgeBaseService.readMarkdown(documentId));
  ipcMain.handle('knowledge-base:read-items', (_event, documentId) => knowledgeBaseService.readItems(documentId));
  ipcMain.handle('knowledge-base:list-items', (_event, documentId) => knowledgeBaseService.listItems(documentId));
  ipcMain.handle('knowledge-base:read-analysis', (_event, documentId) => knowledgeBaseService.readAnalysis(documentId));
  ipcMain.handle('knowledge-base:create-item', (_event, documentId, payload) => knowledgeBaseService.createItem(documentId, payload));
  ipcMain.handle('knowledge-base:update-item', (_event, documentId, itemId, partial) => knowledgeBaseService.updateItem(documentId, itemId, partial));
  ipcMain.handle('knowledge-base:delete-item', (_event, documentId, itemId) => knowledgeBaseService.deleteItem(documentId, itemId));
  ipcMain.handle('knowledge-base:list-snippets', (_event, folderId) => knowledgeBaseService.listSnippets(folderId));
  ipcMain.handle('knowledge-base:create-snippet', (_event, folderId, payload) => knowledgeBaseService.createSnippet(folderId, payload));
  ipcMain.handle('knowledge-base:update-snippet', (_event, snippetId, partial) => knowledgeBaseService.updateSnippet(snippetId, partial));
  ipcMain.handle('knowledge-base:delete-snippet', (_event, snippetId) => knowledgeBaseService.deleteSnippet(snippetId));
  ipcMain.handle('knowledge-base:list-images', (_event, folderId) => knowledgeBaseService.listImages(folderId));
  ipcMain.handle('knowledge-base:create-image', (_event, folderId, payload) => knowledgeBaseService.createImage(folderId, payload));
  ipcMain.handle('knowledge-base:update-image', (_event, imageId, partial) => knowledgeBaseService.updateImage(imageId, partial));
  ipcMain.handle('knowledge-base:delete-image', (_event, imageId) => knowledgeBaseService.deleteImage(imageId));
  ipcMain.handle('knowledge-base:get-image-file', (_event, imageId) => knowledgeBaseService.getImageFileDataUrl(imageId));
  ipcMain.handle('knowledge-base:create-image-from-clipboard', (_event, folderId, payload) => knowledgeBaseService.createImageFromClipboard(folderId, payload));
}

module.exports = { registerKnowledgeBaseIpc };
