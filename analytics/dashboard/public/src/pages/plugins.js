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
  return !state.pluginId.value.trim() && !state.pluginName.value.trim();
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

export function resetPluginForm() {
  state.pluginForm.reset();
  state.pluginId.value = '';
  state.pluginId.readOnly = false;
  state.pluginEnabled.value = 'true';
  state.pluginSortOrder.value = String(getNextPluginSortOrder());
  setPluginsStatus('已清空表单，可新增插件。', 'ok');
}

function fillPluginForm(plugin) {
  state.pluginId.value = plugin?.id || '';
  state.pluginId.readOnly = Boolean(plugin?.id);
  state.pluginName.value = plugin?.name || '';
  state.pluginVersion.value = plugin?.version || '';
  state.pluginAuthor.value = plugin?.author || '';
  state.pluginRepository.value = plugin?.repository || '';
  state.pluginReleaseUrl.value = plugin?.releaseUrl || '';
  state.pluginTags.value = plugin?.tagsText || (plugin?.tags || []).join(', ');
  state.pluginDescription.value = plugin?.description || '';
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

export async function savePlugin(event) {
  event?.preventDefault?.();
  try {
    assertAdminToken();
    saveSettings();

    const id = state.pluginId.value.trim();
    const name = state.pluginName.value.trim();
    const version = state.pluginVersion.value.trim();
    const repository = state.pluginRepository.value.trim();
    const releaseUrl = state.pluginReleaseUrl.value.trim();

    if (!id) {
      setPluginsStatus('请填写与 manifest.json 一致的插件 ID。', 'error');
      return;
    }

    if (!name) {
      setPluginsStatus('请填写插件名称。', 'error');
      return;
    }

    if (!version) {
      setPluginsStatus('请填写版本号。', 'error');
      return;
    }

    if (!repository) {
      setPluginsStatus('请填写 GitHub 仓库地址。', 'error');
      return;
    }

    if (!releaseUrl) {
      setPluginsStatus('请填写 Release 下载地址。', 'error');
      return;
    }

    const body = {
      id,
      name,
      version,
      author: state.pluginAuthor.value.trim(),
      repository,
      releaseUrl,
      tags: state.pluginTags.value.trim(),
      description: state.pluginDescription.value.trim(),
      enabled: state.pluginEnabled.value !== 'false',
      sortOrder: Number(state.pluginSortOrder.value || 0),
    };

    setPluginsStatus('保存中...', '');
    const data = await requestJson('/api/plugins', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    await loadPlugins({ quiet: true });
    fillPluginForm(data.plugin);
    setPluginsStatus(`插件「${data.plugin.name}」已保存。`, 'ok');
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

  state.pluginForm.addEventListener('submit', savePlugin);
  state.resetPluginButton.addEventListener('click', resetPluginForm);
}
