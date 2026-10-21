const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { session } = require('electron');
const {
  getAiLogsDir,
  getConfigFilePath,
  getCredentialLibraryDir,
  getDonationStateFilePath,
  getDuplicateCheckContentDir,
  getFeasibilityReportSourcesDir,
  getGpuStartupProbePath,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getLicenseFilePath,
  getOfficialApiSessionFilePath,
  getOfficialRechargeQrCachePath,
  getOpenXmlJobsDir,
  getRejectionCheckDir,
  getRejectionCheckDocumentMarkdownPath,
  getUserDataPath,
  getWorkspaceDatabasePath,
  getWorkspaceDir,
} = require('../utils/paths.cjs');
const { createPiEnvironmentLayout } = require('./pi/piEnvironment.cjs');

// electron-builder 默认按 `${package.name}-updater` 命名更新缓存目录，安装包内的 app-update.yml 优先。
const DEFAULT_UPDATER_CACHE_DIR_NAME = 'yibiao-client-updater';
const PLUGIN_ENTRY_NAMES = ['plugins', 'plugin-configs', 'plugin-states.json'];
const BROWSER_CACHE_DIR_NAMES = ['Cache', 'Code Cache'];
const RESTRICTED_HTML_ASSET_PREFIX = 'restricted-html-assets-';
const DUPLICATE_CONTENT_IMAGE_PREFIX = 'duplicate-check-content-';
const REMOVE_CONCURRENCY = 16;

function normalizePathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 统计文件或目录的实际字节数；不存在或无法读取的条目按 0 计。
async function measurePath(targetPath) {
  let stat;
  try {
    stat = await fsp.lstat(targetPath);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  const children = await listChildren(targetPath);
  const sizes = await Promise.all(children.map(measurePath));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function measurePaths(targetPaths) {
  const sizes = await Promise.all(targetPaths.map(measurePath));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function listChildren(directory) {
  try {
    return (await fsp.readdir(directory)).map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

async function listFilesRecursive(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFilesRecursive(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }));
  return nested.flat();
}

// 并发删除，被占用或无权限的条目计入失败数，留到下次清理。
async function removePaths(targetPaths) {
  let failed = 0;
  let index = 0;
  const worker = async () => {
    while (index < targetPaths.length) {
      const targetPath = targetPaths[index];
      index += 1;
      try {
        await fsp.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMOVE_CONCURRENCY, targetPaths.length) }, worker));
  return failed;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// electron-updater 在 Windows 本地应用数据目录缓存下载的安装包；其他平台走手动安装包，不使用该目录。
async function resolveUpdaterCacheDir() {
  if (process.platform !== 'win32') return '';
  let dirName = DEFAULT_UPDATER_CACHE_DIR_NAME;
  try {
    const content = await fsp.readFile(path.join(process.resourcesPath, 'app-update.yml'), 'utf-8');
    const match = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(content);
    if (match) dirName = match[1].trim();
  } catch {
    // 开发环境没有 app-update.yml，沿用默认目录名。
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, dirName);
}

/**
 * 存储空间统计与清理：业务数据按数据库引用识别孤儿文件，日志与缓存按目录整体清理。
 * 清理前先列出待删条目，再检查相关任务；运行中的任务会让对应清理项整体跳过。
 */
function createStorageSpaceService({ app, db, taskService, agentService, openXmlHelperService, isUpdateCacheInUse }) {
  const userDataDir = getUserDataPath(app);
  const workspaceDir = getWorkspaceDir(app);
  const logsDir = path.dirname(getAiLogsDir(app));
  const updatesDir = path.join(userDataDir, 'updates');
  const piTempDir = createPiEnvironmentLayout(app).tempDir;
  const updaterCacheDirPromise = resolveUpdaterCacheDir();
  let cleaning = false;

  function getTaskBusyReason() {
    return taskService.getActiveTasks().length ? '后台任务运行中' : '';
  }

  // 数据库已无记录的知识库文档目录；文件夹本身也已删除且没有在用文档时整体移除。
  async function collectKnowledgeBaseOrphans() {
    const baseDir = getKnowledgeBaseDir(app);
    const folderIds = new Set(db.prepare('SELECT folder_id FROM knowledge_folders').all().map((row) => row.folder_id));
    const documentDirs = new Set(db.prepare('SELECT document_dir FROM knowledge_documents').all()
      .map((row) => normalizePathKey(path.join(baseDir, row.document_dir || ''))));
    const targets = [];
    for (const folderPath of await listChildren(path.join(baseDir, 'folders'))) {
      const documentPaths = await listChildren(path.join(folderPath, 'documents'));
      const orphanDocuments = documentPaths.filter((documentPath) => !documentDirs.has(normalizePathKey(documentPath)));
      if (!folderIds.has(path.basename(folderPath)) && orphanDocuments.length === documentPaths.length) {
        targets.push(folderPath);
      } else {
        targets.push(...orphanDocuments);
      }
    }
    return targets;
  }

  // 查重正文按 `<file_id>.md` 保存，导入图片批次以 `duplicate-check-content-<file_id>-` 开头。
  async function collectDuplicateCheckOrphans() {
    const fileIds = new Set(db.prepare('SELECT file_id FROM duplicate_check_content_files').all().map((row) => row.file_id));
    const contents = (await listChildren(getDuplicateCheckContentDir(app)))
      .filter((filePath) => !fileIds.has(path.basename(filePath, '.md')));
    const imageBatches = (await listChildren(getImportedImagesDir(app))).filter((batchPath) => {
      const name = path.basename(batchPath);
      return name.startsWith(DUPLICATE_CONTENT_IMAGE_PREFIX)
        && !fileIds.has(name.slice(DUPLICATE_CONTENT_IMAGE_PREFIX.length).split('-')[0]);
    });
    return [...contents, ...imageBatches];
  }

  // 与废标检查 Store 相同的路径解析：未记录路径的文档使用默认文件名。
  async function collectRejectionCheckOrphans() {
    const referenced = new Set(db.prepare('SELECT document_id, role, markdown_path FROM rejection_check_documents').all()
      .map((row) => {
        const value = String(row.markdown_path || '').trim();
        if (!value) return normalizePathKey(getRejectionCheckDocumentMarkdownPath(app, row.role, row.document_id));
        return normalizePathKey(path.isAbsolute(value) ? value : path.join(workspaceDir, value));
      }));
    return (await listFilesRecursive(getRejectionCheckDir(app))).filter((filePath) => !referenced.has(normalizePathKey(filePath)));
  }

  async function collectCredentialLibraryOrphans() {
    const rootDir = getCredentialLibraryDir(app);
    const referenced = new Set(db.prepare('SELECT relative_path FROM credential_library_images').all()
      .map((row) => normalizePathKey(path.join(rootDir, ...String(row.relative_path || '').split('/').filter(Boolean)))));
    return (await listFilesRecursive(path.join(rootDir, 'images'))).filter((filePath) => !referenced.has(normalizePathKey(filePath)));
  }

  async function collectFeasibilityReportOrphans() {
    const referenced = new Set(db.prepare('SELECT source_files_json FROM feasibility_report_meta').all()
      .flatMap((row) => parseJsonArray(row.source_files_json))
      .map((file) => String(file?.markdownPath || '').trim())
      .filter(Boolean)
      .map((relativePath) => normalizePathKey(path.join(workspaceDir, relativePath))));
    return (await listFilesRecursive(getFeasibilityReportSourcesDir(app))).filter((filePath) => !referenced.has(normalizePathKey(filePath)));
  }

  async function collectUpdateCaches() {
    const updaterCacheDir = await updaterCacheDirPromise;
    const partialDownloads = (await listChildren(updatesDir)).filter((filePath) => filePath.toLowerCase().endsWith('.tmp'));
    return [...partialDownloads, ...(updaterCacheDir ? await listChildren(updaterCacheDir) : [])];
  }

  async function collectOpenXmlJobs() {
    const assetDirs = (await listChildren(workspaceDir))
      .filter((dirPath) => path.basename(dirPath).startsWith(RESTRICTED_HTML_ASSET_PREFIX));
    return [...await listChildren(getOpenXmlJobsDir(app)), ...assetDirs];
  }

  const legacyItems = [
    {
      id: 'knowledge-base-orphans',
      label: '知识库残留文档',
      description: '数据库中已无记录的知识库文档目录',
      collect: collectKnowledgeBaseOrphans,
      getBusyReason: getTaskBusyReason,
    },
    {
      id: 'duplicate-check-orphans',
      label: '标书查重残留内容',
      description: '已不再使用的查重正文和导入图片',
      collect: collectDuplicateCheckOrphans,
      getBusyReason: getTaskBusyReason,
    },
    {
      id: 'rejection-check-orphans',
      label: '废标检查残留文件',
      description: '旧命名或已被替换的招标、投标文件正文',
      collect: collectRejectionCheckOrphans,
      getBusyReason: getTaskBusyReason,
    },
    {
      id: 'credential-library-orphans',
      label: '资信库残留图片',
      description: '资信库中已删除的图片原件',
      collect: collectCredentialLibraryOrphans,
      getBusyReason: getTaskBusyReason,
    },
    {
      id: 'feasibility-report-orphans',
      label: '可研报告残留资料',
      description: '已移除的可研项目资料正文',
      collect: collectFeasibilityReportOrphans,
      getBusyReason: getTaskBusyReason,
    },
  ];

  const temporaryItems = [
    {
      id: 'ai-logs',
      label: 'AI 请求日志',
      description: '开发者模式下记录的每次 AI 请求',
      collect: () => listChildren(getAiLogsDir(app)),
    },
    {
      id: 'developer-logs',
      label: '其他开发日志',
      description: '开发者模式下各功能模块的运行日志',
      collect: async () => (await listChildren(logsDir)).filter((entryPath) => normalizePathKey(entryPath) !== normalizePathKey(getAiLogsDir(app))),
    },
    {
      id: 'browser-cache',
      label: '页面缓存',
      description: '界面脚本和网络资源缓存，清理后会自动重建',
      collect: async () => BROWSER_CACHE_DIR_NAMES.map((name) => path.join(userDataDir, name)),
      clean: async () => {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearCodeCaches({});
      },
    },
    {
      id: 'update-cache',
      label: '更新安装包缓存',
      description: '已安装版本的更新包和中断的下载',
      collect: collectUpdateCaches,
      getBusyReason: () => (isUpdateCacheInUse?.() ? '更新下载中或等待安装' : ''),
    },
    {
      id: 'openxml-jobs',
      label: 'Word 助手临时任务',
      description: 'Word 转换、导出和模板提取留下的中间文件',
      collect: collectOpenXmlJobs,
      getBusyReason: () => (openXmlHelperService.hasActiveJobs() ? 'Word 助手任务运行中' : getTaskBusyReason()),
    },
    {
      id: 'agent-temp',
      label: '智能体临时文件',
      description: '智能体执行命令时产生的临时文件',
      collect: () => listChildren(piTempDir),
      getBusyReason: () => (agentService.getStatus().active_tasks.length ? '智能体任务运行中' : ''),
    },
  ];

  const cleanableGroups = { legacy: legacyItems, temporary: temporaryItems };

  async function measureItem(item) {
    return { id: item.id, label: item.label, description: item.description, bytes: await measurePaths(await item.collect()) };
  }

  function sumBytes(items) {
    return items.reduce((sum, item) => sum + item.bytes, 0);
  }

  function itemBytes(items, ids) {
    return sumBytes(items.filter((item) => ids.includes(item.id)));
  }

  // 不能清理的部分按 userData 一级目录归类，并扣除其中可清理的部分。
  async function measureProtectedItems(legacy, temporary) {
    const rootSizes = new Map(await Promise.all((await listChildren(userDataDir))
      .map(async (entryPath) => [path.basename(entryPath), await measurePath(entryPath)])));
    const rootBytes = (names) => names.reduce((sum, name) => sum + (rootSizes.get(name) || 0), 0);
    const configBytes = await measurePaths([
      getConfigFilePath(app),
      getOfficialApiSessionFilePath(app),
      getOfficialRechargeQrCachePath(app),
      getLicenseFilePath(app),
      getDonationStateFilePath(app),
      getGpuStartupProbePath(app),
    ]);
    const databaseName = path.basename(getWorkspaceDatabasePath(app));
    const databaseBytes = await measurePaths((await listChildren(workspaceDir))
      .filter((entryPath) => path.basename(entryPath).startsWith(databaseName)));
    const workspaceBytes = rootBytes(['workspace']) - databaseBytes - sumBytes(legacy) - itemBytes(temporary, ['openxml-jobs']);
    const agentBytes = rootBytes(['agent-runtime']) - itemBytes(temporary, ['agent-temp']);
    const pluginBytes = rootBytes(PLUGIN_ENTRY_NAMES);
    const partialDownloadBytes = await measurePaths((await listChildren(updatesDir)).filter((filePath) => filePath.toLowerCase().endsWith('.tmp')));
    const runtimeBytes = rootBytes([...rootSizes.keys()]) - configBytes
      - rootBytes(['workspace', 'agent-runtime', 'logs', ...PLUGIN_ENTRY_NAMES, ...BROWSER_CACHE_DIR_NAMES]) - partialDownloadBytes;
    return [
      { id: 'config', label: '配置与授权', description: '模型配置、API Key、许可证和账户登录状态', bytes: configBytes },
      { id: 'database', label: '业务数据库', description: '各功能的项目状态、目录和检查结果', bytes: databaseBytes },
      { id: 'workspace', label: '业务文件', description: '知识库、招标文件、资信库等正在使用的文件', bytes: workspaceBytes },
      { id: 'agent-sessions', label: '智能体会话', description: '可继续执行的智能体任务和运行环境', bytes: agentBytes },
      { id: 'plugins', label: '插件', description: '已安装的插件及其配置', bytes: pluginBytes },
      { id: 'runtime', label: '软件运行数据', description: '界面运行状态、本地存储和待安装的更新', bytes: runtimeBytes },
    ].map((item) => ({ ...item, bytes: Math.max(0, item.bytes) }));
  }

  async function getUsage() {
    const [legacy, temporary] = await Promise.all([
      Promise.all(legacyItems.map(measureItem)),
      Promise.all(temporaryItems.map(measureItem)),
    ]);
    const protectedItems = await measureProtectedItems(legacy, temporary);
    const groups = [
      { id: 'legacy', label: '历史遗留文件', description: '旧版本或异常中断留下、数据库中已无记录的文件', items: legacy },
      { id: 'temporary', label: '临时、缓存、日志', description: '会随使用重新产生，可定期清理', items: temporary },
      { id: 'protected', label: '不能清理', description: '配置、业务数据和运行状态，删除会影响软件正常使用', items: protectedItems },
    ].map((group) => ({ ...group, bytes: sumBytes(group.items) }));
    return {
      groups,
      totalBytes: sumBytes(groups),
      scannedAt: new Date().toISOString(),
    };
  }

  // 每项先列出待删条目再检查任务：检查时仍在运行的任务整项跳过，之后新建的任务目录不在列表中。
  async function clean(groupId) {
    const items = cleanableGroups[groupId];
    if (!items) throw new Error('不支持的清理类型');
    if (cleaning) throw new Error('正在清理，请稍候');
    cleaning = true;
    try {
      const skipped = [];
      let freedBytes = 0;
      let failedCount = 0;
      for (const item of items) {
        const targets = await item.collect();
        const before = await measurePaths(targets);
        if (!before) continue;
        const busyReason = item.getBusyReason?.() || '';
        if (busyReason) {
          skipped.push({ label: item.label, reason: busyReason });
          continue;
        }
        if (item.clean) await item.clean();
        else failedCount += await removePaths(targets);
        freedBytes += Math.max(0, before - await measurePaths(targets));
      }
      return { freedBytes, failedCount, skipped, usage: await getUsage() };
    } finally {
      cleaning = false;
    }
  }

  return { getUsage, clean };
}

module.exports = {
  createStorageSpaceService,
};
