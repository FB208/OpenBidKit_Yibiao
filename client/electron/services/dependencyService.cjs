const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { downloadFile } = require('../utils/downloadFile.cjs');
const { getDependenciesDir } = require('../utils/paths.cjs');

const DEPENDENCY_API_URL = process.env.YIBIAO_DEPENDENCY_API_URL || 'https://analytics.agnet.top/dependencies';
const DEPENDENCY_REQUEST_TIMEOUT_MS = 15000;
const INSTALL_RECORD_FILE = 'dependency.json';

/**
 * 按需下载的功能组件：不随安装包分发，用到时从看板登记的地址下载到 userData/dependencies/<依赖ID>/。
 * 这里只管文件的下载、解压和版本记录，不加载其中的代码，也没有启用停用的概念。
 *
 * 每次安装都解压到依赖目录下一个新的子目录，再改写 dependency.json 指向它。
 * 这样不需要删除或改名正在使用的目录：杀毒软件扫描、转换正在读取都不影响安装，
 * 旧的子目录删不掉也只是多占空间，下次安装时再清。
 */
function createDependencyService({ app, onProgress }) {
  const installs = new Map();
  const progress = new Map();

  function getDependencyDir(id) {
    return path.join(getDependenciesDir(app), id);
  }

  /** 读取已安装记录；没有记录、或记录没有指向版本子目录，视为未安装。 */
  function getInstalled(id) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(getDependencyDir(id), INSTALL_RECORD_FILE), 'utf-8'));
      return record.dir ? { ...record, installDir: path.join(getDependencyDir(id), record.dir) } : null;
    } catch {
      return null;
    }
  }

  /** 清掉依赖目录里除安装记录和指定子目录以外的内容；删不掉的留给下次。 */
  function removeStaleEntries(id, keepDir) {
    const dependencyDir = getDependencyDir(id);
    for (const name of fs.readdirSync(dependencyDir)) {
      if (name === INSTALL_RECORD_FILE || name === keepDir) continue;
      try {
        fs.rmSync(path.join(dependencyDir, name), { recursive: true, force: true });
      } catch (error) {
        console.warn('[dependency-service] 旧文件暂时无法删除', name, error?.message || String(error));
      }
    }
  }

  /** 读取线上登记的安装包：优先当前平台专用的，没有再取通用的。 */
  async function fetchAvailable(id) {
    const response = await fetch(DEPENDENCY_API_URL, { signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS) });
    const data = await response.json();
    if (!response.ok || data?.code !== 0) {
      throw new Error(data?.message || `组件信息读取失败：${response.status}`);
    }
    const candidates = (data.dependencies || []).filter((item) => item.id === id);
    const platformKey = `${process.platform}-${process.arch}`;
    return candidates.find((item) => item.platform === platformKey)
      || candidates.find((item) => item.platform === 'all')
      || null;
  }

  function emitProgress(id, patch) {
    const next = { id, ...patch };
    progress.set(id, next);
    onProgress?.(next);
  }

  async function getStatus(id) {
    const installed = getInstalled(id);
    let available = null;
    let message = '';
    try {
      available = await fetchAvailable(id);
    } catch (error) {
      console.warn('[dependency-service] 读取组件信息失败', error?.message || String(error));
      message = '暂时无法获取组件信息，请检查网络后重试';
    }

    return {
      id,
      installed: Boolean(installed),
      installedVersion: installed?.version || '',
      available: available
        ? {
            name: available.name,
            description: available.description,
            version: available.version,
            size: available.size,
            platform: available.platform,
          }
        : null,
      hasUpdate: Boolean(installed && available && available.version !== installed.version),
      installing: installs.has(id),
      progress: installs.has(id) ? progress.get(id) || null : null,
      message,
    };
  }

  /** 静默记录一次成功的下载，失败不影响安装结果。 */
  function recordDownload(id, platform) {
    fetch(`${DEPENDENCY_API_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, platform }),
    }).catch(() => undefined);
  }

  async function runInstall(id) {
    const available = await fetchAvailable(id);
    if (!available) {
      throw new Error('没有找到适用于当前系统的组件安装包');
    }

    const dependenciesDir = getDependenciesDir(app);
    const dependencyDir = getDependencyDir(id);
    fs.mkdirSync(dependencyDir, { recursive: true });
    const zipPath = path.join(dependenciesDir, `.download-${id}.zip`);

    try {
      emitProgress(id, { phase: 'downloading', percent: 0 });
      await downloadFile(available.downloadUrl, zipPath, {
        expectedSize: Number(available.size) || 0,
        label: '组件',
        onProgress: (percent) => emitProgress(id, { phase: 'downloading', percent }),
      });

      emitProgress(id, { phase: 'extracting', percent: 100 });
      const versionDir = fs.mkdtempSync(path.join(dependencyDir, `${String(available.version).replace(/[^\w.-]/g, '_')}-`));
      new AdmZip(zipPath).extractAllTo(versionDir, true);
      // 写入记录即切换到新版本，在此之前一直用旧版本。
      fs.writeFileSync(path.join(dependencyDir, INSTALL_RECORD_FILE), JSON.stringify({
        id,
        version: available.version,
        platform: available.platform,
        dir: path.basename(versionDir),
        installedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
      recordDownload(id, available.platform);
      emitProgress(id, { phase: 'done', percent: 100 });
    } catch (error) {
      emitProgress(id, { phase: 'error', percent: 0, message: error?.message || String(error) });
      throw error;
    } finally {
      fs.rmSync(zipPath, { force: true });
      // 成功时清掉旧版本，失败时清掉没装完的新目录；当前记录指向的子目录始终保留。
      removeStaleEntries(id, getInstalled(id)?.dir);
    }
  }

  /** 下载并安装（或更新）一个依赖；同一依赖重复调用时复用进行中的安装。 */
  function install(id) {
    if (!installs.has(id)) {
      // 先移出进行中的记录再读状态，返回的状态里不再带“安装中”。
      installs.set(id, runInstall(id).finally(() => installs.delete(id)).then(() => getStatus(id)));
    }
    return installs.get(id);
  }

  async function uninstall(id) {
    if (installs.has(id)) {
      throw new Error('组件正在安装，请稍后再试');
    }
    const dependencyDir = getDependencyDir(id);
    // 先删安装记录，组件即视为未安装；其余文件删不掉的留给下次安装时清。
    fs.rmSync(path.join(dependencyDir, INSTALL_RECORD_FILE), { force: true });
    if (fs.existsSync(dependencyDir)) {
      removeStaleEntries(id);
      if (!fs.readdirSync(dependencyDir).length) fs.rmdirSync(dependencyDir);
    }
    return getStatus(id);
  }

  return { getInstalled, getStatus, install, uninstall };
}

module.exports = { createDependencyService };
