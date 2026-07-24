import { assertAdminToken, getEncodedProjectAndDays, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { appState, state } from '../state.js';

function setPluginsStatus(message, type = '') {
  state.pluginsStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.pluginsStatus.textContent = message || '';
}

function truncate(value, maxLength = 80) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderPluginIcon(plugin) {
  if (plugin.iconUrl) {
    return `<img class="plugin-icon" src="${escapeHtml(plugin.iconUrl)}" alt="" />`;
  }

  return '<span class="plugin-icon-placeholder">📦</span>';
}

function renderPluginTags(plugin) {
  const tags = plugin.tags?.length ? plugin.tags : splitTags(plugin.tagsText);
  if (!tags.length) {
    return '-';
  }

  return `<div class="plugin-tag-list">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function getNextPluginSortOrder() {
  const maxOrder = (appState.plugins || []).reduce((max, plugin) => {
    const order = Number(plugin.sortOrder);
    return Number.isFinite(order) ? Math.max(max, Math.trunc(order)) : max;
  }, 0);
  return maxOrder + 1;
}

function isBlankNewPluginForm() {
  return !state.pluginId.value.trim() && !state.pluginRepository.value.trim();
}

function splitTags(value) {
  return String(value || '')
    .split(/[，,;；\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderPluginsTable() {
  const plugins = appState.plugins || [];
  if (!plugins.length) {
    state.pluginsTable.innerHTML = '<div class="empty">暂无插件，请先新增一个插件。</div>';
    return;
  }

  const rows = plugins.map((plugin) => `
    <tr>
      <td class="plugin-icon-cell">${renderPluginIcon(plugin)}</td>
      <td class="plugin-name-cell">
        <strong>${escapeHtml(plugin.name)}</strong><br />
        <small>${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version)}</small><br />
        <small>${escapeHtml(plugin.enabled ? '启用' : '停用')} · 排序 ${escapeHtml(plugin.sortOrder)}</small>
      </td>
      <td class="plugin-tags-cell">${renderPluginTags(plugin)}</td>
      <td>${escapeHtml(plugin.author || '-')}</td>
      <td>${escapeHtml(formatNumber(plugin.downloadCount))}</td>
      <td class="plugin-description-cell">${escapeHtml(truncate(plugin.description, 90) || '-')}</td>
      <td class="plugin-repository-cell"><a href="${escapeHtml(plugin.repository)}" target="_blank">查看仓库</a></td>
      <td class="plugin-row-actions">
        <button type="button" class="secondary-button" data-plugin-action="edit" data-plugin-id="${escapeHtml(plugin.id)}">编辑</button>
        <button type="button" class="danger-button" data-plugin-action="delete" data-plugin-id="${escapeHtml(plugin.id)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.pluginsTable.innerHTML = `
    <table class="plugin-table">
      <thead>
        <tr>
          <th>图标</th>
          <th>名称</th>
          <th>标签</th>
          <th>作者</th>
          <th>下载量</th>
          <th>描述</th>
          <th>仓库</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** 使用同步接口返回的最新数据更新当前列表，保留本次同步失败的插件 */
function applySyncedPlugins(syncedPlugins) {
  const syncedById = new Map((syncedPlugins || []).map((plugin) => [plugin.id, plugin]));
  appState.plugins = (appState.plugins || []).map((plugin) => syncedById.get(plugin.id) || plugin);
  renderPluginsTable();
}
export function resetPluginForm() {
  state.pluginForm.reset();
  state.pluginId.value = '';
  state.pluginEnabled.value = 'true';
  state.pluginSortOrder.value = String(getNextPluginSortOrder());
  setPluginsStatus('已清空表单，可新增插件。', 'ok');
}

function fillPluginForm(plugin) {
  state.pluginId.value = plugin?.id || '';
  state.pluginRepository.value = plugin?.repository || '';
  state.pluginEnabled.value = plugin?.enabled === false ? 'false' : 'true';
  state.pluginSortOrder.value = String(plugin?.sortOrder ?? 0);
}

export async function loadPlugins(options = {}) {
  try {
    assertAdminToken();
    saveSettings();
    const { projectName } = getEncodedProjectAndDays();
    const data = await requestJson(`/api/plugins?projectName=${projectName}`);
    appState.plugins = data.plugins || [];
    renderPluginsTable();
    if (isBlankNewPluginForm()) {
      state.pluginSortOrder.value = String(getNextPluginSortOrder());
    }
    if (!options.quiet) {
      setPluginsStatus(`已读取 ${appState.plugins.length} 个插件。`, 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setPluginsStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

/** 手动同步市场中全部插件的最新正式 Release */
export async function syncPlugins() {
  try {
    assertAdminToken();
    saveSettings();
    state.syncPluginsButton.disabled = true;
    setPluginsStatus('正在同步所有插件的最新正式 Release...', '');

    const data = await requestJson('/api/plugins/sync', { method: 'POST' });
    applySyncedPlugins(data.plugins);
    await loadPlugins({ quiet: true });
    const totalCount = Number(data.totalCount) || 0;
    const syncedCount = Number(data.syncedCount) || 0;
    const failedCount = Number(data.failedCount) || 0;
    const failureSummary = (data.failures || [])
      .map((failure) => `${failure.id || '未知插件'}：${truncate(failure.message, 120) || '未知错误'}`)
      .join('；');
    console.info('[analytics] 插件同步完成', {
      totalCount,
      syncedCount,
      failedCount,
      versions: (data.plugins || []).map((plugin) => plugin.id + '@' + plugin.version),
      failures: data.failures || [],
    });
    if (failedCount > 0) {
      const prefix = syncedCount > 0
        ? `同步完成：成功 ${syncedCount} 个，失败 ${failedCount} 个。`
        : `同步失败：${failedCount} 个插件均未同步。`;
      setPluginsStatus(`${prefix}${failureSummary ? ` ${failureSummary}` : ''}`, 'error');
    } else if (totalCount === 0) {
      setPluginsStatus('当前没有可同步的插件。', 'ok');
    } else {
      setPluginsStatus(`同步完成，已同步 ${syncedCount} 个插件。`, 'ok');
    }
  } catch (error) {
    setPluginsStatus(error?.message || String(error), 'error');
  } finally {
    state.syncPluginsButton.disabled = false;
  }
}

export async function savePlugin(event) {
  event?.preventDefault?.();
  try {
    assertAdminToken();
    saveSettings();

    const repository = state.pluginRepository.value.trim();
    if (!repository) {
      setPluginsStatus('请填写 GitHub 仓库地址。', 'error');
      return;
    }

    const body = {
      id: state.pluginId.value.trim(),
      repository,
      enabled: state.pluginEnabled.value !== 'false',
      sortOrder: Number(state.pluginSortOrder.value || 0),
    };

    setPluginsStatus('正在读取 manifest.json 和最新正式 Release...', '');
    const data = await requestJson('/api/plugins', {
      method: 'POST',
      body,
    });

    await loadPlugins({ quiet: true });
    fillPluginForm(data.plugin);
    setPluginsStatus(`插件「${data.plugin.name}」已同步并保存。`, 'ok');
  } catch (error) {
    setPluginsStatus(error?.message || String(error), 'error');
  }
}

export async function deletePlugin(pluginId) {
  if (!confirm(`确认删除插件「${pluginId}」吗？`)) {
    return;
  }

  try {
    assertAdminToken();
    saveSettings();
    setPluginsStatus('删除中...', '');
    await requestJson(`/api/plugins?id=${encodeURIComponent(pluginId)}`, { method: 'DELETE' });
    await loadPlugins({ quiet: true });
    if (!isBlankNewPluginForm() && state.pluginId.value === pluginId) {
      resetPluginForm();
    }
    setPluginsStatus('插件已删除。', 'ok');
  } catch (error) {
    setPluginsStatus(error?.message || String(error), 'error');
  }
}

export function setupPluginsPage() {
  state.pluginsTable.addEventListener('click', (event) => {
    const button = event.target.closest('[data-plugin-action]');
    if (!button) return;

    const action = button.dataset.pluginAction;
    const pluginId = button.dataset.pluginId;

    if (action === 'edit') {
      const plugin = appState.plugins?.find((item) => item.id === pluginId);
      if (plugin) {
        fillPluginForm(plugin);
        setPluginsStatus('', '');
      }
    } else if (action === 'delete') {
      deletePlugin(pluginId);
    }
  });

  state.syncPluginsButton.addEventListener('click', syncPlugins);
  state.pluginForm.addEventListener('submit', savePlugin);
  state.resetPluginButton.addEventListener('click', resetPluginForm);
}
