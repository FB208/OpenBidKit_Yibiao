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

function getAiLogsDir(app) {
  return path.join(getUserDataPath(app), 'logs', 'ai');
}

module.exports = {
  getAiLogsDir,
  getConfigFilePath,
  getTechnicalPlanFilePath,
  getWorkspaceDir,
  getUserDataPath,
};
