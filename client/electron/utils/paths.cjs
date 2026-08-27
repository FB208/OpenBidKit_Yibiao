const path = require('node:path');

function getUserDataPath(app) {
  return app.getPath('userData');
}

function getConfigFilePath(app) {
  return path.join(getUserDataPath(app), 'user_config.json');
}

function getLicenseFilePath(app) {
  return path.join(getUserDataPath(app), 'license.json');
}

function getDonationStateFilePath(app) {
  return path.join(getUserDataPath(app), 'donation_state.json');
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

function getFeasibilityReportDir(app) {
  return path.join(getWorkspaceDir(app), 'feasibility-report');
}

function getFeasibilityReportSourcesDir(app) {
  return path.join(getFeasibilityReportDir(app), 'sources');
}

function getTechnicalPlanTenderMarkdownPath(app) {
  return path.join(getTechnicalPlanDir(app), 'tender.md');
}

/** 招标 Word 原件目录。 */
function getTechnicalPlanTenderOriginalsDir(app) {
  return path.join(getTechnicalPlanDir(app), 'tender-originals');
}

/** 一级目录确认后生成的最终投标模版。 */
function getTechnicalPlanBidTemplatePath(app) {
  return path.join(getTechnicalPlanDir(app), 'bid-template.docx');
}

/** 模版抽章后的内部源文件，供字段扫描和标记使用。 */
function getTechnicalPlanBidTemplateSourcePath(app) {
  return path.join(getTechnicalPlanDir(app), 'bid-template-source.docx');
}

/** 与最终投标模版成对保存的待填字段清单。 */
function getTechnicalPlanBidTemplateFieldsPath(app) {
  return path.join(getTechnicalPlanDir(app), 'bid-template-fields.json');
}

function getTechnicalPlanOriginalPlanMarkdownPath(app) {
  return path.join(getTechnicalPlanDir(app), 'original-plan.md');
}

function getTechnicalPlanIllustrationsDir(app) {
  return path.join(getTechnicalPlanDir(app), 'illustrations');
}

function getTechnicalPlanGeneratedIllustrationsDir(app) {
  return path.join(getGeneratedImagesDir(app), 'technical-plan', 'illustrations');
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
  const tenderDocumentId = String(documentId || '').trim();
  if (tenderDocumentId && tenderDocumentId !== 'tender') {
    const safeDocumentId = tenderDocumentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(getRejectionCheckDir(app), 'tenders', `${safeDocumentId}.md`);
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

function getPlatformArchKey() {
  return `${process.platform}-${process.arch}`;
}

function getBundledAgentToolsBinDir(app) {
  if (process.env.YIBIAO_AGENT_TOOLS_BIN_DIR) {
    return process.env.YIBIAO_AGENT_TOOLS_BIN_DIR;
  }

  const platformArch = getPlatformArchKey();
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-tools', platformArch, 'bin');
  }

  return path.join(__dirname, '..', '..', 'vendor', 'agent-tools', platformArch, 'bin');
}

/** Open XML 助手任务根目录。 */
function getOpenXmlJobsDir(app) {
  return path.join(getWorkspaceDir(app), 'openxml-jobs');
}

/** 单个 Open XML 任务目录。 */
function getOpenXmlJobDir(app, jobId) {
  return path.join(getOpenXmlJobsDir(app), String(jobId || ''));
}

/** 开发时编译用的助手工程路径。 */
function getOpenXmlHelperProjectPath() {
  return path.join(__dirname, '..', '..', '..', 'openxmlhelper', 'src', 'OpenXmlHelper', 'OpenXmlHelper.csproj');
}

/** 开发编译后的助手可执行文件。 */
function getOpenXmlHelperDebugExecutablePath() {
  const fileName = process.platform === 'win32' ? 'openxmlhelper.exe' : 'openxmlhelper';
  return path.join(__dirname, '..', '..', '..', 'openxmlhelper', 'src', 'OpenXmlHelper', 'bin', 'Debug', 'net10.0', fileName);
}

/** 安装包或本地 vendor 中的自包含助手目录。 */
function getBundledOpenXmlHelperDir(app) {
  if (process.env.YIBIAO_OPENXML_HELPER_DIR) {
    return process.env.YIBIAO_OPENXML_HELPER_DIR;
  }

  const platformArch = getPlatformArchKey();
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'openxml-tools', platformArch);
  }

  return path.join(__dirname, '..', '..', 'vendor', 'openxml-tools', platformArch);
}

/** 安装包内的助手可执行文件。 */
function getBundledOpenXmlHelperPath(app) {
  const fileName = process.platform === 'win32' ? 'openxmlhelper.exe' : 'openxmlhelper';
  return path.join(getBundledOpenXmlHelperDir(app), fileName);
}

module.exports = {
  getAgentRuntimeDir,
  getAiLogsDir,
  getBundledAgentToolsBinDir,
  getBundledOpenXmlHelperDir,
  getBundledOpenXmlHelperPath,
  getDeveloperLogsDir,
  getDuplicateCheckContentDir,
  getDuplicateCheckDir,
  getConfigFilePath,
  getDonationStateFilePath,
  getGpuStartupProbePath,
  getFeasibilityReportDir,
  getFeasibilityReportSourcesDir,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getLicenseFilePath,
  getOpenXmlHelperDebugExecutablePath,
  getOpenXmlHelperProjectPath,
  getOpenXmlJobDir,
  getOpenXmlJobsDir,
  getRejectionCheckDir,
  getRejectionCheckDocumentMarkdownPath,
  getTechnicalPlanDir,
  getTechnicalPlanGeneratedIllustrationsDir,
  getTechnicalPlanIllustrationsDir,
  getTechnicalPlanLogsDir,
  getTechnicalPlanOriginalPlanMarkdownPath,
  getTechnicalPlanBidTemplatePath,
  getTechnicalPlanBidTemplateSourcePath,
  getTechnicalPlanBidTemplateFieldsPath,
  getTechnicalPlanTenderMarkdownPath,
  getTechnicalPlanTenderOriginalsDir,
  getWorkspaceDir,
  getWorkspaceDatabasePath,
  getUserDataPath,
};
