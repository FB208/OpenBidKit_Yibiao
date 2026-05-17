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

function getTechnicalPlanFilePath(app) {
  return path.join(getWorkspaceDir(app), 'technical_plan.json');
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
  getConfigFilePath,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getTechnicalPlanFilePath,
  getWorkspaceDir,
  getUserDataPath,
};
