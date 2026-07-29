import { assertReady, getSelectedProjectName, requestDownload, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { appState, state } from '../state.js';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,49}$/;

function setAgentErrorStatus(message, type = '') {
  state.agentErrorStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.agentErrorStatus.textContent = message || '';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function truncate(value, maxLength = 120) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderVersions() {
  const versions = appState.agentErrorVersions || [];
  state.agentErrorVersions.innerHTML = versions.length
    ? versions.map((version) => `
      <span class="agent-error-version-chip">
        <code>${escapeHtml(version)}</code>
        <button type="button" data-agent-error-version-remove="${escapeHtml(version)}" aria-label="移除版本 ${escapeHtml(version)}">×</button>
      </span>
    `).join('')
    : '<span class="agent-error-version-empty">未配置版本，当前不会接收任何异常日志。</span>';
}

function fillConfig(config = {}) {
  state.agentErrorReceiveEnabled.checked = config.receiveEnabled === true;
  appState.agentErrorVersions = Array.isArray(config.versions) ? [...config.versions] : [];
  state.agentErrorStorageUsed.textContent = formatBytes(config.usedBytes);
  state.agentErrorStorageLimit.textContent = formatBytes(config.maxStorageBytes);
  state.agentErrorStorageRemaining.textContent = formatBytes(config.remainingBytes);
  state.agentErrorLogCount.textContent = formatNumber(config.logCount);
  renderVersions();
}

function updateSelectionControls() {
  const pageIds = (appState.agentErrorLogs || []).map((log) => log.id);
  const selectedCount = pageIds.filter((id) => appState.selectedAgentErrorIds.has(id)).length;
  state.selectAllAgentErrors.checked = pageIds.length > 0 && selectedCount === pageIds.length;
  state.selectAllAgentErrors.indeterminate = selectedCount > 0 && selectedCount < pageIds.length;
  state.deleteSelectedAgentErrorsButton.disabled = appState.selectedAgentErrorIds.size === 0;
  state.deleteSelectedAgentErrorsButton.textContent = appState.selectedAgentErrorIds.size
    ? `批量删除（${appState.selectedAgentErrorIds.size}）`
    : '批量删除';
}

function renderLogs() {
  const logs = appState.agentErrorLogs || [];
  if (!logs.length) {
    state.agentErrorTable.innerHTML = '<div class="empty">暂无异常日志。</div>';
    updateSelectionControls();
    return;
  }
  const rows = logs.map((log) => `
    <tr>
      <td class="agent-error-check-cell"><input type="checkbox" data-agent-error-select="${escapeHtml(log.id)}" ${appState.selectedAgentErrorIds.has(log.id) ? 'checked' : ''} /></td>
      <td class="agent-error-time-cell">${escapeHtml(log.receivedAt || log.occurredAt || '-')}</td>
      <td><code>${escapeHtml(log.version || '-')}</code></td>
      <td><code>${escapeHtml(log.runtime || '-')}</code></td>
      <td class="agent-error-client-cell"><code title="${escapeHtml(log.clientId || '')}">${escapeHtml(log.clientId || '-')}</code></td>
      <td class="agent-error-summary-cell" title="${escapeHtml(log.errorSummary || '')}">${escapeHtml(truncate(log.errorSummary, 150) || '-')}</td>
      <td>${escapeHtml(formatBytes(log.compressedBytes))}<br /><small>原始 ${escapeHtml(formatBytes(log.originalBytes))}</small></td>
      <td class="agent-error-row-actions">
        <button type="button" class="secondary-button" data-agent-error-action="download" data-agent-error-id="${escapeHtml(log.id)}">下载</button>
        <button type="button" class="danger-button" data-agent-error-action="delete" data-agent-error-id="${escapeHtml(log.id)}">删除</button>
      </td>
    </tr>
  `).join('');
  state.agentErrorTable.innerHTML = `
    <table class="agent-error-table">
      <thead><tr><th></th><th>接收时间</th><th>版本</th><th>运行时</th><th>Client ID</th><th>错误摘要</th><th>大小</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  updateSelectionControls();
}

function updatePager() {
  const totalPages = Math.max(1, Math.ceil(appState.agentErrorTotal / appState.agentErrorPageSize));
  appState.agentErrorPage = Math.min(appState.agentErrorPage, totalPages);
  state.agentErrorPageInfo.textContent = `第 ${appState.agentErrorPage} / ${totalPages} 页，共 ${formatNumber(appState.agentErrorTotal)} 条`;
  state.agentErrorPageInput.value = String(appState.agentErrorPage);
  state.agentErrorPageInput.max = String(totalPages);
  state.prevAgentErrorPage.disabled = appState.agentErrorPage <= 1;
  state.nextAgentErrorPage.disabled = appState.agentErrorPage >= totalPages;
}

async function loadLogPage() {
  const projectName = encodeURIComponent(getSelectedProjectName());
  const data = await requestJson(`/api/agent-errors?projectName=${projectName}&page=${appState.agentErrorPage}&pageSize=${appState.agentErrorPageSize}`);
  appState.agentErrorLogs = data.logs || [];
  appState.agentErrorTotal = Number(data.total || 0);
  appState.selectedAgentErrorIds.clear();
  renderLogs();
  updatePager();
}

export async function loadAgentErrors(options = {}) {
  assertReady();
  saveSettings();
  if (options.resetPage) appState.agentErrorPage = 1;
  const projectName = encodeURIComponent(getSelectedProjectName());
  const [configData] = await Promise.all([
    requestJson(`/api/agent-errors/config?projectName=${projectName}`),
    loadLogPage(),
  ]);
  fillConfig(configData.config || {});
  if (!options.quiet) setAgentErrorStatus('异常日志设置和列表已读取。', 'ok');
}

function addVersionsFromInput() {
  const versions = state.agentErrorVersionInput.value
    .split(/[，,;；\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!versions.length) return;
  const invalid = versions.find((version) => !VERSION_PATTERN.test(version));
  if (invalid) {
    setAgentErrorStatus(`版本号格式无效：${invalid}`, 'error');
    return;
  }
  if (new Set([...appState.agentErrorVersions, ...versions]).size > 50) {
    setAgentErrorStatus('接收版本号最多配置 50 个。', 'error');
    return;
  }
  appState.agentErrorVersions = [...new Set([...appState.agentErrorVersions, ...versions])].sort((left, right) => left.localeCompare(right));
  state.agentErrorVersionInput.value = '';
  renderVersions();
  setAgentErrorStatus('版本已加入列表，点击“保存接收设置”后生效。');
}

async function saveConfig() {
  setAgentErrorStatus('');
  try {
    assertReady();
    state.saveAgentErrorConfigButton.disabled = true;
    const data = await requestJson('/api/agent-errors/config', {
      method: 'POST',
      body: {
        projectName: getSelectedProjectName(),
        receiveEnabled: state.agentErrorReceiveEnabled.checked,
        versions: appState.agentErrorVersions,
      },
    });
    fillConfig(data.config || {});
    setAgentErrorStatus('异常日志接收设置已保存。', 'ok');
  } catch (error) {
    setAgentErrorStatus(error?.message || String(error), 'error');
  } finally {
    state.saveAgentErrorConfigButton.disabled = false;
  }
}

function openDeleteDialog(ids) {
  const normalizedIds = [...new Set(ids)].filter(Boolean);
  if (!normalizedIds.length) return;
  appState.pendingDeleteAgentErrorIds = normalizedIds;
  const bytes = (appState.agentErrorLogs || [])
    .filter((log) => normalizedIds.includes(log.id))
    .reduce((total, log) => total + Number(log.compressedBytes || 0), 0);
  state.agentErrorDeleteMessage.textContent = `确认删除 ${normalizedIds.length} 份异常日志？删除后将释放 ${formatBytes(bytes)}，此操作不可恢复。`;
  state.agentErrorDeleteDialog.showModal();
}

async function confirmDelete() {
  const ids = appState.pendingDeleteAgentErrorIds || [];
  if (!ids.length) return;
  try {
    state.confirmAgentErrorDelete.disabled = true;
    const projectName = encodeURIComponent(getSelectedProjectName());
    const result = await requestJson(`/api/agent-errors?projectName=${projectName}`, {
      method: 'DELETE',
      body: { ids },
    });
    state.agentErrorDeleteDialog.close();
    appState.pendingDeleteAgentErrorIds = [];
    if (appState.agentErrorPage > 1 && ids.length >= appState.agentErrorLogs.length) appState.agentErrorPage -= 1;
    await loadAgentErrors({ quiet: true });
    setAgentErrorStatus(`已删除 ${formatNumber(result.deletedCount)} 份日志，释放 ${formatBytes(result.deletedBytes)}。`, 'ok');
  } catch (error) {
    setAgentErrorStatus(error?.message || String(error), 'error');
  } finally {
    state.confirmAgentErrorDelete.disabled = false;
  }
}

async function downloadLog(reportId) {
  try {
    assertReady();
    const projectName = encodeURIComponent(getSelectedProjectName());
    await requestDownload(
      `/api/agent-errors/download?projectName=${projectName}&id=${encodeURIComponent(reportId)}`,
      `agent-error-${reportId}.json.gz`,
    );
    setAgentErrorStatus('异常日志已开始下载。', 'ok');
  } catch (error) {
    setAgentErrorStatus(error?.message || String(error), 'error');
  }
}

function jumpPage() {
  const totalPages = Math.max(1, Math.ceil(appState.agentErrorTotal / appState.agentErrorPageSize));
  const page = Number(state.agentErrorPageInput.value || appState.agentErrorPage);
  if (!Number.isFinite(page)) return;
  appState.agentErrorPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  void loadAgentErrors({ quiet: true }).catch((error) => setAgentErrorStatus(error?.message || String(error), 'error'));
}

// 绑定异常日志配置、选择、下载和删除交互。
export function setupAgentErrorsPage() {
  state.addAgentErrorVersionButton.addEventListener('click', addVersionsFromInput);
  state.agentErrorVersionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addVersionsFromInput();
  });
  state.agentErrorVersions.addEventListener('click', (event) => {
    const version = event.target.closest('[data-agent-error-version-remove]')?.dataset.agentErrorVersionRemove;
    if (!version) return;
    appState.agentErrorVersions = appState.agentErrorVersions.filter((item) => item !== version);
    renderVersions();
  });
  state.saveAgentErrorConfigButton.addEventListener('click', saveConfig);
  state.selectAllAgentErrors.addEventListener('change', () => {
    for (const log of appState.agentErrorLogs) {
      if (state.selectAllAgentErrors.checked) appState.selectedAgentErrorIds.add(log.id);
      else appState.selectedAgentErrorIds.delete(log.id);
    }
    renderLogs();
  });
  state.agentErrorTable.addEventListener('change', (event) => {
    const id = event.target.dataset.agentErrorSelect;
    if (!id) return;
    if (event.target.checked) appState.selectedAgentErrorIds.add(id);
    else appState.selectedAgentErrorIds.delete(id);
    updateSelectionControls();
  });
  state.agentErrorTable.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent-error-action]');
    if (!button) return;
    const id = button.dataset.agentErrorId;
    if (button.dataset.agentErrorAction === 'download') void downloadLog(id);
    if (button.dataset.agentErrorAction === 'delete') openDeleteDialog([id]);
  });
  state.deleteSelectedAgentErrorsButton.addEventListener('click', () => openDeleteDialog([...appState.selectedAgentErrorIds]));
  state.cancelAgentErrorDelete.addEventListener('click', () => {
    appState.pendingDeleteAgentErrorIds = [];
    state.agentErrorDeleteDialog.close();
  });
  state.confirmAgentErrorDelete.addEventListener('click', confirmDelete);
  state.prevAgentErrorPage.addEventListener('click', () => {
    appState.agentErrorPage = Math.max(1, appState.agentErrorPage - 1);
    void loadAgentErrors({ quiet: true }).catch((error) => setAgentErrorStatus(error?.message || String(error), 'error'));
  });
  state.nextAgentErrorPage.addEventListener('click', () => {
    appState.agentErrorPage += 1;
    void loadAgentErrors({ quiet: true }).catch((error) => setAgentErrorStatus(error?.message || String(error), 'error'));
  });
  state.jumpAgentErrorPage.addEventListener('click', jumpPage);
  state.agentErrorPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') jumpPage();
  });
}
