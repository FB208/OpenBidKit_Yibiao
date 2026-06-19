const path = require('node:path');

function getUserDataPath(app) {
  return app.getPath('userData');
}

function getConfigFilePath(app) {
  return path.join(getUserDataPath(app), 'user_config.json');
}

function getGpuStartupProbePath(app) {
  return path.join(getUserDataPath(app), 'gpu_startup_probe.json');
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

function getTechnicalPlanOriginalPlanMarkdownPath(app) {
  return path.join(getTechnicalPlanDir(app), 'original-plan.md');
}

function getDuplicateCheckDir(app) {
  return path.join(getWorkspaceDir(app), 'duplicate-check');
}

function getDuplicateCheckContentDir(app) {
  return path.join(getDuplicateCheckDir(app), 'contents');
}

function getRejectionCheckDir(app) {
  return path.join(getWorkspaceDir(app), 'rejection-check');
}

function getRejectionCheckDocumentMarkdownPath(app, role, documentId) {
  if (role === 'bid') {
    const safeDocumentId = String(documentId || 'bid').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(getRejectionCheckDir(app), 'bids', `${safeDocumentId}.md`);
  }
  return path.join(getRejectionCheckDir(app), 'tender.md');
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

function getDeveloperLogsDir(app, moduleName) {
  return path.join(getUserDataPath(app), 'logs', String(moduleName || 'app'));
}

function getTechnicalPlanLogsDir(app) {
  return getDeveloperLogsDir(app, 'technical-plan');
}

function getAgentRuntimeDir(app) {
  return path.join(getUserDataPath(app), 'agent-runtime');
}

function getAgentCacheDir(app) {
  return path.join(getUserDataPath(app), 'agent-cache');
}

function getPlatformArchKey() {
  return `${process.platform}-${process.arch}`;
}

function getBundledOpencodeBinaryPath(app) {
  if (process.env.YIBIAO_OPENCODE_BIN) {
    return process.env.YIBIAO_OPENCODE_BIN;
  }

  const binaryName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const platformArch = getPlatformArchKey();

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'opencode', platformArch, binaryName);
  }

  return path.join(__dirname, '..', '..', 'vendor', 'opencode', platformArch, binaryName);
}

module.exports = {
  getAgentCacheDir,
  getAgentRuntimeDir,
  getAiLogsDir,
  getBundledOpencodeBinaryPath,
  getDeveloperLogsDir,
  getDuplicateCheckContentDir,
  getDuplicateCheckDir,
  getConfigFilePath,
  getGpuStartupProbePath,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getRejectionCheckDir,
  getRejectionCheckDocumentMarkdownPath,
  getTechnicalPlanDir,
  getTechnicalPlanLogsDir,
  getTechnicalPlanOriginalPlanMarkdownPath,
  getTechnicalPlanTenderMarkdownPath,
  getWorkspaceDir,
  getWorkspaceDatabasePath,
  getUserDataPath,
};
