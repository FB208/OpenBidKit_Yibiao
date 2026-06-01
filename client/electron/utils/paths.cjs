const path = require('node:path');

function getUserDataPath(app) {
  return app.getPath('userData');
}

function getConfigFilePath(app) {
  return path.join(getUserDataPath(app), 'user_config.json');
}

function getWorkspaceDir(app) {
  return path.join(getUserDataPath(app), 'workspace');
}

function getWorkspaceDatabasePath(app) {
  return path.join(getWorkspaceDir(app), 'yibiao.sqlite');
}

function getTechnicalPlanDir(app) {
  return path.join(getWorkspaceDir(app), 'technical-plan');
}

function getTechnicalPlanTenderMarkdownPath(app) {
  return path.join(getTechnicalPlanDir(app), 'tender.md');
}

function getDuplicateCheckFilePath(app) {
  return path.join(getWorkspaceDir(app), 'duplicate_check.json');
}

function getRejectionCheckFilePath(app) {
  return path.join(getWorkspaceDir(app), 'rejection_check.json');
}

function getDuplicateCheckDir(app) {
  return path.join(getWorkspaceDir(app), 'duplicate-check');
}

function getGeneratedImagesDir(app) {
  return path.join(getWorkspaceDir(app), 'generated-images');
}

function getImportedImagesDir(app) {
  return path.join(getWorkspaceDir(app), 'imported-images');
}

function getKnowledgeBaseDir(app) {
  return path.join(getWorkspaceDir(app), 'knowledge-base');
}

function getAiLogsDir(app) {
  return path.join(getUserDataPath(app), 'logs', 'ai');
}

module.exports = {
  getAiLogsDir,
  getDuplicateCheckDir,
  getConfigFilePath,
  getDuplicateCheckFilePath,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getRejectionCheckFilePath,
  getTechnicalPlanDir,
  getTechnicalPlanTenderMarkdownPath,
  getWorkspaceDir,
  getWorkspaceDatabasePath,
  getUserDataPath,
};
