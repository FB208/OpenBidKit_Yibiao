const { ipcMain } = require('electron');

function registerKnowledgeBaseIpc({ knowledgeBaseService }) {
  ipcMain.handle('knowledge-base:get-migration-status', () => knowledgeBaseService.getMigrationStatus());
  ipcMain.handle('knowledge-base:migrate-legacy', () => knowledgeBaseService.migrateLegacy());
  ipcMain.handle('knowledge-base:list', () => knowledgeBaseService.list());
  ipcMain.handle('knowledge-base:create-folder', (_event, name) => knowledgeBaseService.createFolder(name));
  ipcMain.handle('knowledge-base:rename-folder', (_event, folderId, name) => knowledgeBaseService.renameFolder(folderId, name));
  ipcMain.handle('knowledge-base:reorder-folder', (_event, draggedFolderId, targetFolderId, position) => knowledgeBaseService.reorderFolder(draggedFolderId, targetFolderId, position));
  ipcMain.handle('knowledge-base:delete-folder', (_event, folderId) => knowledgeBaseService.deleteFolder(folderId));
  ipcMain.handle('knowledge-base:delete-document', (_event, documentId) => knowledgeBaseService.deleteDocument(documentId));
  ipcMain.handle('knowledge-base:move-document', (_event, documentId, targetFolderId, targetDocumentId, position) => knowledgeBaseService.moveDocument(documentId, targetFolderId, targetDocumentId, position));
  ipcMain.handle('knowledge-base:upload-documents', (event, folderId) => knowledgeBaseService.uploadDocuments(folderId, event.sender));
  ipcMain.handle('knowledge-base:retry-document', (event, documentId) => knowledgeBaseService.retryDocument(documentId, event.sender));
  ipcMain.handle('knowledge-base:start-matching', (event, documentId, batchSize) => knowledgeBaseService.startMatching(documentId, batchSize, event.sender));
  ipcMain.handle('knowledge-base:read-markdown', (_event, documentId) => knowledgeBaseService.readMarkdown(documentId));
  ipcMain.handle('knowledge-base:read-items', (_event, documentId) => knowledgeBaseService.readItems(documentId));
  ipcMain.handle('knowledge-base:read-analysis', (_event, documentId) => knowledgeBaseService.readAnalysis(documentId));
}

module.exports = { registerKnowledgeBaseIpc };
