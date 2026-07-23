const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const { createPluginContext } = require('./pluginContext.cjs');

const PLUGIN_MARKET_URL = 'https://analytics.agnet.top/plugins';
const PLUGIN_DOWNLOAD_URL = `${PLUGIN_MARKET_URL}/download`;
const PLUGIN_STATE_FILE = 'plugin-states.json';

class PluginService {
  constructor() {
    this.app = null;
    this.plugins = new Map();
    this.pluginStates = {};
    this.services = {};
    this.marketCache = [];
    this.marketCacheTime = 0;
  }

  /**
   * 初始化插件服务
   */
  async initialize(app, services) {
    this.app = app;
    this.services = services;
    
    const pluginsDir = this.getPluginsDir();
    fs.mkdirSync(pluginsDir, { recursive: true });
    
    this.loadPluginStates();
    
    console.log('[plugin-service] 插件服务已初始化');
  }

  /**
   * 更新服务引用（在 workspace database 初始化后调用）
   */
  updateServices(services) {
    this.services = { ...this.services, ...services };
    console.log('[plugin-service] 服务已更新');
  }

  /**
   * 获取插件目录
   */
  getPluginsDir() {
    return path.join(this.app.getPath('userData'), 'plugins');
  }

  /**
   * 获取插件状态文件路径
   */
  getStateFilePath() {
    return path.join(this.app.getPath('userData'), PLUGIN_STATE_FILE);
  }

  /**
   * 加载插件状态
   */
  loadPluginStates() {
    try {
      const stateFile = this.getStateFilePath();
      if (fs.existsSync(stateFile)) {
        const data = fs.readFileSync(stateFile, 'utf-8');
        this.pluginStates = JSON.parse(data);
      }
    } catch (error) {
      console.error('[plugin-service] 加载插件状态失败:', error);
      this.pluginStates = {};
    }
  }

  /**
   * 保存插件状态
   */
  savePluginStates() {
    try {
      const stateFile = this.getStateFilePath();
      fs.writeFileSync(stateFile, JSON.stringify(this.pluginStates, null, 2), 'utf-8');
    } catch (error) {
      console.error('[plugin-service] 保存插件状态失败:', error);
    }
  }

  /**
   * 读取插件 manifest
   */
  readManifest(pluginDir) {
    try {
      const manifestPath = path.join(pluginDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      const data = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[plugin-service] 读取 manifest 失败:', error);
      return null;
    }
  }

  /**
   * 清理插件目录下已加载的 CommonJS 模块缓存
   */
  clearPluginModuleCache(pluginDir) {
    for (const modulePath of Object.keys(require.cache)) {
      const relativePath = path.relative(pluginDir, modulePath);
      const isPluginModule = relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);

      if (isPluginModule) {
        delete require.cache[modulePath];
      }
    }
  }

  /**
   * 启用所有标记为 enabled 的插件
   * 在 workspace database 就绪后调用
   */
  async activateEnabledPlugins() {
    const pluginsDir = this.getPluginsDir();
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const pluginId = entry.name;
      
      // 如果插件状态为 enabled，自动启用
      if (this.pluginStates[pluginId]?.enabled) {
        console.log(`[plugin-service] 自动启用插件: ${pluginId}`);
        try {
          await this.enablePlugin(pluginId);
        } catch (error) {
          console.error(`[plugin-service] 自动启用插件失败: ${pluginId}`, error);
        }
      }
    }
  }

  /**
   * 从服务器获取可用插件列表
   */
  async fetchAvailablePlugins() {
    // 使用缓存，5分钟内不重复请求
    const now = Date.now();
    if (this.marketCache.length > 0 && now - this.marketCacheTime < 5 * 60 * 1000) {
      return this.marketCache;
    }

    return new Promise((resolve, reject) => {
      https.get(PLUGIN_MARKET_URL, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 0 && json.plugins) {
              this.marketCache = json.plugins;
              this.marketCacheTime = now;
              resolve(json.plugins);
            } else {
              reject(new Error('插件市场响应格式错误'));
            }
          } catch (error) {
            reject(error);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 获取已安装插件列表
   */
  getInstalledPlugins() {
    const pluginsDir = this.getPluginsDir();
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const installed = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const pluginId = entry.name;
      const pluginDir = path.join(pluginsDir, pluginId);
      const manifest = this.readManifest(pluginDir);
      
      if (!manifest) continue;
      
      const state = this.pluginStates[pluginId] || {};
      
      installed.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled: state.enabled || false,
        installed: true,
        installPath: pluginDir,
        hasConfig: manifest.hasConfig || false,
        manifest,
      });
    }
    
    return installed;
  }

  /**
   * 下载插件
   */
  async downloadPlugin(releaseUrl) {
    const tempDir = path.join(this.app.getPath('temp'), 'yibiao-plugins');
    fs.mkdirSync(tempDir, { recursive: true });
    
    const fileName = path.basename(new URL(releaseUrl).pathname);
    const zipPath = path.join(tempDir, fileName);
    
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      
      https.get(releaseUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // 处理重定向
          https.get(response.headers.location, (redirectResponse) => {
            redirectResponse.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve(zipPath);
            });
          }).on('error', (err) => {
            fs.unlinkSync(zipPath);
            reject(err);
          });
        } else {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve(zipPath);
          });
        }
      }).on('error', (err) => {
        fs.unlinkSync(zipPath);
        reject(err);
      });
    });
  }

  /**
   * 静默记录一次成功的插件下载
   */
  recordPluginDownload(pluginId) {
    const body = JSON.stringify({ id: pluginId });
    const request = https.request(PLUGIN_DOWNLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => response.resume());
    request.on('error', () => {});
    request.end(body);
  }

  /**
   * 解压插件
   */
  async extractPlugin(zipPath, targetDir) {
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(targetDir, true);
    } catch (error) {
      throw new Error(`解压失败: ${error.message}`);
    }
  }

  /**
   * 安装插件
   */
  async installPlugin(pluginId) {
    try {
      // 从服务器获取插件信息
      const plugins = await this.fetchAvailablePlugins();
      const pluginInfo = plugins.find(p => p.id === pluginId);
      
      if (!pluginInfo) {
        throw new Error('插件不存在');
      }
      
      // 下载插件
      console.log('[plugin-service] 下载插件:', pluginInfo.releaseUrl);
      const zipPath = await this.downloadPlugin(pluginInfo.releaseUrl);
      
      // 解压到插件目录
      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      
      fs.mkdirSync(pluginDir, { recursive: true });
      await this.extractPlugin(zipPath, pluginDir);
      
      // 清理临时文件
      fs.unlinkSync(zipPath);
      
      // 读取 manifest
      const manifest = this.readManifest(pluginDir);
      if (!manifest) {
        throw new Error('插件 manifest.json 不存在或格式错误');
      }

      if (manifest.id !== pluginId) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
        throw new Error(`插件 manifest.id 与市场 ID 不一致：应为 ${pluginId}`);
      }
      
      // 保存状态
      this.pluginStates[pluginId] = {
        installed: true,
        enabled: false,
        version: manifest.version,
        installedAt: new Date().toISOString(),
      };
      this.savePluginStates();

      this.recordPluginDownload(pluginId);
      
      console.log('[plugin-service] 插件安装成功:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 安装插件失败:', error);
      throw error;
    }
  }

  /**
   * 从本地 ZIP 安装插件，同 ID 插件直接覆盖升级
   */
  async installOfflinePlugin(zipPath) {
    if (path.extname(zipPath).toLowerCase() !== '.zip') {
      throw new Error('请选择 ZIP 格式的插件安装包');
    }

    const tempRoot = path.join(this.app.getPath('temp'), 'yibiao-plugins');
    fs.mkdirSync(tempRoot, { recursive: true });
    let stagingDir = fs.mkdtempSync(path.join(tempRoot, 'offline-'));

    try {
      await this.extractPlugin(zipPath, stagingDir);

      const manifest = this.readManifest(stagingDir);
      if (!manifest) {
        throw new Error('ZIP 根目录缺少有效的 manifest.json');
      }

      const pluginId = String(manifest.id || '');
      const pluginName = String(manifest.name || '').trim();
      const pluginVersion = String(manifest.version || '').trim();
      const hasMain = fs.existsSync(path.join(stagingDir, 'main.cjs'));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(pluginId)) {
        throw new Error('manifest.json 中的插件 ID 缺失或格式不正确');
      }
      if (!pluginName) {
        throw new Error('manifest.json 中缺少插件名称');
      }
      if (!pluginVersion) {
        throw new Error('manifest.json 中缺少插件版本');
      }

      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      const previousManifest = this.readManifest(pluginDir);
      const previousState = { ...(this.pluginStates[pluginId] || {}) };
      const wasEnabled = Boolean(previousManifest) && previousState.enabled === true;
      const shouldRestoreEnabledState = wasEnabled && hasMain;
      if (this.plugins.has(pluginId)) {
        await this.disablePlugin(pluginId);
      }
      this.clearPluginModuleCache(pluginDir);
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }

      fs.renameSync(stagingDir, pluginDir);
      stagingDir = null;

      this.pluginStates[pluginId] = {
        ...previousState,
        installed: true,
        enabled: false,
        version: pluginVersion,
        installedAt: previousState.installedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.savePluginStates();

      if (shouldRestoreEnabledState) {
        await this.enablePlugin(pluginId);
      }

      console.log('[plugin-service] 离线插件安装成功:', pluginId, pluginVersion);
      return {
        id: pluginId,
        name: pluginName,
        version: pluginVersion,
        previousVersion: previousManifest?.version || null,
        updated: Boolean(previousManifest),
        enabled: shouldRestoreEnabledState,
      };
    } catch (error) {
      console.error('[plugin-service] 离线安装插件失败:', error);
      throw error;
    } finally {
      if (stagingDir && fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(pluginId) {
    try {
      // 先禁用
      if (this.plugins.has(pluginId)) {
        await this.disablePlugin(pluginId);
      }

      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      this.clearPluginModuleCache(pluginDir);
      
      // 删除目录
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      
      // 删除状态
      delete this.pluginStates[pluginId];
      this.savePluginStates();
      
      console.log('[plugin-service] 插件已卸载:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 卸载插件失败:', error);
      throw error;
    }
  }

  /**
   * 启用插件
   */
  async enablePlugin(pluginId) {
    try {
      if (this.plugins.has(pluginId)) {
        return;
      }
      
      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      const manifest = this.readManifest(pluginDir);
      
      if (!manifest) {
        throw new Error('插件 manifest 不存在');
      }
      
      // 检查是否有 main.cjs
      const mainPath = path.join(pluginDir, 'main.cjs');
      if (!fs.existsSync(mainPath)) {
        throw new Error('插件 main.cjs 不存在');
      }
      
      // 加载插件模块
      const pluginModule = require(mainPath);
      
      if (typeof pluginModule.activate !== 'function') {
        throw new Error('插件缺少 activate 方法');
      }
      
      // 创建上下文
      const context = createPluginContext(this.app, pluginId, this.services);
      
      // 激活插件
      await pluginModule.activate(context);
      
      // 保存插件实例
      this.plugins.set(pluginId, { module: pluginModule, context });
      
      // 更新状态
      this.pluginStates[pluginId] = {
        ...(this.pluginStates[pluginId] || {}),
        enabled: true,
      };
      this.savePluginStates();
      
      console.log('[plugin-service] 插件已启用:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 启用插件失败:', error);
      throw error;
    }
  }

  /**
   * 禁用插件
   */
  async disablePlugin(pluginId) {
    try {
      const plugin = this.plugins.get(pluginId);
      if (plugin && typeof plugin.module.deactivate === 'function') {
        await plugin.module.deactivate();
      }
      
      this.plugins.delete(pluginId);
      
      // 更新状态
      if (this.pluginStates[pluginId]) {
        this.pluginStates[pluginId].enabled = false;
        this.savePluginStates();
      }
      
      console.log('[plugin-service] 插件已禁用:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 禁用插件失败:', error);
      throw error;
    }
  }

  /**
   * 更新插件
   */
  async updatePlugin(pluginId) {
    try {
      const wasEnabled = this.pluginStates[pluginId]?.enabled === true;

      // 先卸载旧版本（会自动禁用）
      await this.uninstallPlugin(pluginId);
      
      // 重新安装
      await this.installPlugin(pluginId);

      if (wasEnabled) {
        await this.enablePlugin(pluginId);
      }
    } catch (error) {
      console.error('[plugin-service] 更新插件失败:', error);
      throw error;
    }
  }

  /**
   * 刷新插件市场
   */
  async refreshMarket() {
    try {
      this.marketCache = [];
      this.marketCacheTime = 0;
      await this.fetchAvailablePlugins();
    } catch (error) {
      console.error('[plugin-service] 刷新市场失败:', error);
      throw error;
    }
  }
}

module.exports = new PluginService();
