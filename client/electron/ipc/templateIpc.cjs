const { ipcMain } = require('electron');

function registerTemplateIpc({ templateStore, openXmlHelperService }) {
  ipcMain.handle('templates:list', () => templateStore.listTemplates());
  ipcMain.handle('templates:get', (_event, templateId) => templateStore.getTemplate(templateId));
  ipcMain.handle('templates:create', (_event, config) => templateStore.createTemplate(config));
  ipcMain.handle('templates:update', (_event, templateId, config) => templateStore.updateTemplate(templateId, config));
  ipcMain.handle('templates:delete', (_event, templateId) => templateStore.deleteTemplate(templateId));
  ipcMain.handle('templates:render-preview', (_event, html, config) => openXmlHelperService.renderRestrictedHtmlDocx(html, config));
}

module.exports = {
  registerTemplateIpc,
};
