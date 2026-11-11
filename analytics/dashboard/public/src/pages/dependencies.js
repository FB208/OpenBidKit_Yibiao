import { assertAdminToken, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { appState, state } from '../state.js';

const PLATFORM_LABELS = {
  all: '通用',
  'win32-x64': 'Windows x64',
  'darwin-x64': 'macOS Intel',
  'darwin-arm64': 'macOS Apple 芯片',
};

function setDependenciesStatus(message, type = '') {
  state.dependenciesStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.dependenciesStatus.textContent = message || '';
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function findDependency(id, platform) {
  return (appState.dependencies || []).find((item) => item.id === id && item.platform === platform);
}

function renderDependenciesTable() {
  const dependencies = appState.dependencies || [];
  if (!dependencies.length) {
    state.dependenciesTable.innerHTML = '<div class="empty">暂无依赖，请先登记一个安装包。</div>';
    return;
  }

  const rows = dependencies.map((dependency) => `
    <tr>
      <td class="plugin-name-cell">
        <strong>${escapeHtml(dependency.name)}</strong><br />
        <small>${escapeHtml(dependency.id)} · v${escapeHtml(dependency.version)}</small><br />
        <small>${escapeHtml(dependency.enabled ? '启用' : '停用')}</small>
      </td>
      <td>${escapeHtml(PLATFORM_LABELS[dependency.platform] || dependency.platform)}</td>
      <td>${escapeHtml(formatSize(dependency.size))}</td>
      <td>${escapeHtml(formatNumber(dependency.downloadCount))}</td>
      <td class="plugin-description-cell">${escapeHtml(dependency.description || '-')}</td>
      <td class="plugin-description-cell"><a href="${escapeHtml(dependency.downloadUrl)}" target="_blank">${escapeHtml(dependency.downloadUrl)}</a></td>
      <td>${escapeHtml(dependency.updatedAt || '-')}</td>
      <td class="plugin-row-actions">
        <button type="button" class="secondary-button" data-dependency-action="edit" data-dependency-id="${escapeHtml(dependency.id)}" data-dependency-platform="${escapeHtml(dependency.platform)}">编辑</button>
        <button type="button" class="danger-button" data-dependency-action="delete" data-dependency-id="${escapeHtml(dependency.id)}" data-dependency-platform="${escapeHtml(dependency.platform)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.dependenciesTable.innerHTML = `
    <table class="plugin-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>适用平台</th>
          <th>大小</th>
          <th>下载量</th>
          <th>说明</th>
          <th>下载链接</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function resetDependencyForm() {
  state.dependencyForm.reset();
  state.dependencyPlatform.value = 'all';
  state.dependencyEnabled.value = 'true';
  setDependenciesStatus('已清空表单，可登记新的安装包。', 'ok');
}

function fillDependencyForm(dependency) {
  state.dependencyId.value = dependency?.id || '';
  state.dependencyPlatform.value = dependency?.platform || 'all';
  state.dependencyEnabled.value = dependency?.enabled === false ? 'false' : 'true';
  state.dependencyName.value = dependency?.name || '';
  state.dependencyVersion.value = dependency?.version || '';
  state.dependencyDescription.value = dependency?.description || '';
  state.dependencyDownloadUrl.value = dependency?.downloadUrl || '';
}

export async function loadDependencies(options = {}) {
  try {
    assertAdminToken();
    saveSettings();
    const data = await requestJson('/api/dependencies');
    appState.dependencies = data.dependencies || [];
    renderDependenciesTable();
    if (!options.quiet) {
      setDependenciesStatus(`已读取 ${appState.dependencies.length} 个安装包。`, 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setDependenciesStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

async function saveDependency(event) {
  event?.preventDefault?.();
  try {
    assertAdminToken();
    saveSettings();

    const body = {
      id: state.dependencyId.value.trim(),
      platform: state.dependencyPlatform.value,
      enabled: state.dependencyEnabled.value !== 'false',
      name: state.dependencyName.value.trim(),
      version: state.dependencyVersion.value.trim(),
      description: state.dependencyDescription.value.trim(),
      downloadUrl: state.dependencyDownloadUrl.value.trim(),
    };

    state.saveDependencyButton.disabled = true;
    setDependenciesStatus('正在检查下载链接并保存...', '');
    const data = await requestJson('/api/dependencies', { method: 'POST', body });
    await loadDependencies({ quiet: true });
    fillDependencyForm(data.dependency);
    setDependenciesStatus(`「${data.dependency.name}」已保存，安装包大小 ${formatSize(data.dependency.size)}。`, 'ok');
  } catch (error) {
    setDependenciesStatus(error?.message || String(error), 'error');
  } finally {
    state.saveDependencyButton.disabled = false;
  }
}

async function deleteDependency(id, platform) {
  if (!confirm(`确认删除依赖「${id}」（${PLATFORM_LABELS[platform] || platform}）吗？已安装的客户端不受影响，未安装的客户端将无法下载。`)) {
    return;
  }

  try {
    assertAdminToken();
    saveSettings();
    setDependenciesStatus('删除中...', '');
    await requestJson(`/api/dependencies?id=${encodeURIComponent(id)}&platform=${encodeURIComponent(platform)}`, { method: 'DELETE' });
    await loadDependencies({ quiet: true });
    setDependenciesStatus('依赖已删除。', 'ok');
  } catch (error) {
    setDependenciesStatus(error?.message || String(error), 'error');
  }
}

export function setupDependenciesPage() {
  state.dependenciesTable.addEventListener('click', (event) => {
    const button = event.target.closest('[data-dependency-action]');
    if (!button) return;

    const { dependencyAction, dependencyId, dependencyPlatform } = button.dataset;
    if (dependencyAction === 'edit') {
      const dependency = findDependency(dependencyId, dependencyPlatform);
      if (dependency) {
        fillDependencyForm(dependency);
        setDependenciesStatus('', '');
      }
    } else if (dependencyAction === 'delete') {
      void deleteDependency(dependencyId, dependencyPlatform);
    }
  });

  state.dependencyForm.addEventListener('submit', saveDependency);
  state.resetDependencyButton.addEventListener('click', resetDependencyForm);
}
