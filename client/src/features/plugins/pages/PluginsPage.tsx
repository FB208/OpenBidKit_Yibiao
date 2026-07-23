import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { AvailablePlugin } from '../../../shared/types/ipc';

function PluginsPage() {
  const [plugins, setPlugins] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [operatingPluginId, setOperatingPluginId] = useState<string | null>(null);
  const { showToast } = useToast();
  const controlsDisabled = loading || operatingPluginId !== null;

  useEffect(() => {
    loadPlugins();
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
    if (!confirm('确定要卸载此插件吗？')) return;

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

  if (loading && plugins.length === 0) {
    return (
      <div className="plugins-page">
        <div className="page-head">
          <h1>插件管理</h1>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="plugins-page">
      <div className="page-head">
        <div>
          <h1>插件管理</h1>
          <p>安装和管理插件，扩展软件功能</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="secondary-button" onClick={handleRefresh} disabled={controlsDisabled}>
            刷新市场
          </button>
        </div>
      </div>

      <div className="plugins-page-content">
        {plugins.length === 0 ? (
          <div className="empty-state">
            <p>暂无可用插件</p>
            <small>插件市场正在建设中</small>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
            {plugins.map((plugin) => (
              <div key={plugin.id} className="card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  {plugin.iconUrl ? (
                    <img src={plugin.iconUrl} alt="" style={{ width: '48px', height: '48px', borderRadius: '8px' }} />
                  ) : (
                    <div style={{ width: '48px', height: '48px', borderRadius: '8px', background: 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>
                      📦
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>{plugin.name}</h3>
                    <p style={{ margin: '4px 0', fontSize: '13px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {plugin.author || '未知'} · v{plugin.version}
                    </p>
                    {plugin.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                        {plugin.tags.slice(0, 3).map((tag: string) => (
                          <span key={tag} style={{ padding: '2px 8px', background: 'var(--color-background-secondary)', borderRadius: '4px', fontSize: '12px' }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <p style={{ margin: '12px 0', fontSize: '14px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                  {plugin.description}
                </p>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    {plugin.installed ? (
                      <span>
                        已安装 v{plugin.installedVersion}
                        {plugin.enabled && <span style={{ color: 'var(--color-success)', marginLeft: '8px' }}>● 已启用</span>}
                        {plugin.hasUpdate && <span style={{ color: 'var(--color-warning)', marginLeft: '8px' }}>可更新</span>}
                      </span>
                    ) : (
                      <span>下载 {plugin.downloadCount} 次</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    {!plugin.installed ? (
                      <button className="primary-button" onClick={() => handleInstall(plugin.id)} disabled={controlsDisabled}>
                        安装
                      </button>
                    ) : (
                      <>
                        {plugin.enabled ? (
                          <button className="secondary-button" onClick={() => handleDisable(plugin.id)} disabled={controlsDisabled}>
                            禁用
                          </button>
                        ) : (
                          <button className="primary-button" onClick={() => handleEnable(plugin.id)} disabled={controlsDisabled}>
                            启用
                          </button>
                        )}
                        {plugin.hasUpdate && (
                          <button className="secondary-button" onClick={() => handleUpdate(plugin.id)} disabled={controlsDisabled}>
                            更新
                          </button>
                        )}
                        {plugin.hasConfig && (
                          <button className="secondary-button" onClick={() => handleOpenConfig(plugin.id)} disabled={controlsDisabled}>
                            配置
                          </button>
                        )}
                        <button className="secondary-button" onClick={() => handleUninstall(plugin.id)} disabled={controlsDisabled}>
                          卸载
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default PluginsPage;
