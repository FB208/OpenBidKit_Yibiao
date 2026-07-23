import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { AvailablePlugin } from '../../../shared/types/ipc';

const downloadCountFormatter = new Intl.NumberFormat('zh-CN');

function PluginsPage() {
  const [plugins, setPlugins] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [operatingPluginId, setOperatingPluginId] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<AvailablePlugin | null>(null);
  const { showToast } = useToast();
  const controlsDisabled = loading || operatingPluginId !== null;

  useEffect(() => {
    void loadPlugins();
  }, []);

  const loadPlugins = async () => {
    try {
      setLoading(true);
      const availablePlugins = await window.yibiao?.plugins?.getAvailablePlugins();
      setPlugins(availablePlugins || []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载插件列表失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (pluginId: string) => {
    setOperatingPluginId(pluginId);
    try {
      showToast('正在安装插件...', 'info');
      await window.yibiao?.plugins?.install(pluginId);
      showToast('插件安装成功', 'success');
      await loadPlugins();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '安装失败', 'error');
    } finally {
      setOperatingPluginId(null);
    }
  };

  const handleUninstall = async (pluginId: string) => {
    setOperatingPluginId(pluginId);
    try {
      await window.yibiao?.plugins?.uninstall(pluginId);
      showToast('插件已卸载', 'success');
      await loadPlugins();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '卸载失败', 'error');
    } finally {
      setOperatingPluginId(null);
    }
  };

  const handleEnable = async (pluginId: string) => {
    setOperatingPluginId(pluginId);
    try {
      await window.yibiao?.plugins?.enable(pluginId);
      showToast('插件已启用', 'success');
      await loadPlugins();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启用失败', 'error');
    } finally {
      setOperatingPluginId(null);
    }
  };

  const handleDisable = async (pluginId: string) => {
    setOperatingPluginId(pluginId);
    try {
      await window.yibiao?.plugins?.disable(pluginId);
      showToast('插件已禁用', 'success');
      await loadPlugins();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '禁用失败', 'error');
    } finally {
      setOperatingPluginId(null);
    }
  };

  const handleUpdate = async (pluginId: string) => {
    setOperatingPluginId(pluginId);
    try {
      showToast('正在更新插件...', 'info');
      await window.yibiao?.plugins?.update(pluginId);
      showToast('插件更新成功', 'success');
      await loadPlugins();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新失败', 'error');
    } finally {
      setOperatingPluginId(null);
    }
  };

  const handleOpenConfig = async (pluginId: string) => {
    try {
      await window.yibiao?.plugins?.openConfig(pluginId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开配置失败', 'error');
    }
  };

  // 从本地 ZIP 安装插件，同 ID 时覆盖升级
  const handleOfflineInstall = async () => {
    setLoading(true);
    try {
      const result = await window.yibiao?.plugins?.installOffline();
      if (!result || result.canceled) return;

      await loadPlugins();
      showToast(
        result.updated
          ? `插件“${result.name}”已覆盖升级至 v${result.version}`
          : `插件“${result.name}”已离线安装`,
        'success',
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : '离线安装失败', 'error');
    } finally {
      setLoading(false);
    }
  };
  const handleRefresh = async () => {
    setLoading(true);
    try {
      await window.yibiao?.plugins?.refreshMarket();
      await loadPlugins();
      showToast('插件市场已刷新', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '刷新失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    const pluginId = uninstallTarget.id;
    setUninstallTarget(null);
    await handleUninstall(pluginId);
  };

  return (
    <div className="plugins-page">
      <section className="plugins-panel" aria-label="插件管理">
        <div className="plugins-head">
          <div className="plugins-head-copy">
            <span className="section-kicker">插件管理</span>
            <h2>插件市场</h2>
            <p>安装和管理插件，按需扩展软件功能。</p>
          </div>
          <div className="plugins-head-actions">
            <button type="button" className="primary-action" onClick={handleOfflineInstall} disabled={controlsDisabled}>
              离线安装
            </button>
            <button type="button" className="secondary-action" onClick={handleRefresh} disabled={controlsDisabled}>
              刷新市场
            </button>
          </div>
        </div>

        <div className="plugins-list">
          {loading && plugins.length === 0 ? (
            <div className="plugins-empty-state">
              <strong>正在读取插件</strong>
              <span>请稍候...</span>
            </div>
          ) : plugins.length === 0 ? (
            <div className="plugins-empty-state">
              <strong>暂无可用插件</strong>
              <span>插件市场正在建设中，稍后再来看看。</span>
            </div>
          ) : (
            <div className="plugins-grid">
              {plugins.map((plugin) => {
                const busy = operatingPluginId === plugin.id;
                return (
                  <article className="plugin-card" key={plugin.id}>
                    <div className="plugin-card-head">
                      {plugin.iconUrl ? (
                        <img className="plugin-card-icon" src={plugin.iconUrl} alt="" />
                      ) : (
                        <span className="plugin-card-icon is-placeholder" aria-hidden="true">📦</span>
                      )}
                      <div className="plugin-card-title">
                        <strong>{plugin.name}</strong>
                        <small>{plugin.author || '未知作者'} · v{plugin.version}</small>
                        {plugin.tags.length > 0 ? (
                          <div className="plugin-card-tags">
                            {plugin.tags.slice(0, 3).map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <p className="plugin-card-description">{plugin.description || '暂无插件描述。'}</p>

                    <div className="plugin-card-footer">
                      <div className="plugin-card-status">
                        {plugin.installed ? (
                          <>
                            <span className="plugin-status-pill is-installed">已安装 v{plugin.installedVersion}</span>
                            {plugin.enabled ? <span className="plugin-status-pill is-enabled">已启用</span> : null}
                            {plugin.hasUpdate ? <span className="plugin-status-pill is-update">可更新</span> : null}
                          </>
                        ) : (
                          <span className="plugin-status-pill">下载 {downloadCountFormatter.format(plugin.downloadCount)} 次</span>
                        )}
                      </div>

                      <div className="plugin-card-actions">
                        {!plugin.installed ? (
                          <button type="button" className="primary-action" onClick={() => handleInstall(plugin.id)} disabled={controlsDisabled}>
                            {busy ? '安装中' : '安装'}
                          </button>
                        ) : (
                          <>
                            {plugin.enabled ? (
                              <button type="button" className="secondary-action" onClick={() => handleDisable(plugin.id)} disabled={controlsDisabled}>
                                禁用
                              </button>
                            ) : (
                              <button type="button" className="primary-action" onClick={() => handleEnable(plugin.id)} disabled={controlsDisabled}>
                                启用
                              </button>
                            )}
                            {plugin.hasUpdate ? (
                              <button type="button" className="secondary-action" onClick={() => handleUpdate(plugin.id)} disabled={controlsDisabled}>
                                更新
                              </button>
                            ) : null}
                            {plugin.hasConfig ? (
                              <button type="button" className="secondary-action" onClick={() => handleOpenConfig(plugin.id)} disabled={controlsDisabled}>
                                配置
                              </button>
                            ) : null}
                            <button type="button" className="danger-action" onClick={() => setUninstallTarget(plugin)} disabled={controlsDisabled}>
                              卸载
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <Dialog.Root open={Boolean(uninstallTarget)} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="plugin-uninstall-dialog">
            <Dialog.Title>卸载插件</Dialog.Title>
            <Dialog.Description>
              确定卸载“{uninstallTarget?.name || '该插件'}”吗？卸载后其配置和本地文件都会被删除。
            </Dialog.Description>
            <div className="plugin-uninstall-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="danger-action" onClick={() => void confirmUninstall()}>确认卸载</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default PluginsPage;
