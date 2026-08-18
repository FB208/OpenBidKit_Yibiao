import { assertAdminToken, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { appState, state } from '../state.js';

let searchTimer = null;

function setModelInfoCacheStatus(message, type = '') {
  state.modelInfoCacheStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.modelInfoCacheStatus.textContent = message || '';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function splitReasoningEfforts(value) {
  return [...new Set(String(value || '')
    .split(/[，,;；\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

// 渲染模型信息缓存的最近同步状态。
function renderModelInfoCache(status, overrideCount) {
  const available = Boolean(status?.lastSuccessAt);
  state.modelInfoCacheState.textContent = status?.status === 'failed' ? '同步失败' : available ? '可用' : '未同步';
  state.modelInfoCacheLastSuccess.textContent = formatDateTime(status?.lastSuccessAt);
  state.modelInfoCacheProviders.textContent = formatNumber(status?.providerCount || 0);
  state.modelInfoCacheSourceModels.textContent = formatNumber(status?.sourceModelCount || 0);
  state.modelInfoCacheModels.textContent = formatNumber(status?.indexedModelCount || 0);
  state.modelInfoCacheReasoningModels.textContent = formatNumber(status?.reasoningEffortModelCount || 0);
  state.modelInfoCacheOverrides.textContent = formatNumber(overrideCount || 0);
  state.modelInfoCacheBytes.textContent = formatBytes(status?.sourceBytes);
  state.modelInfoCacheTrigger.textContent = status?.trigger === 'cron' ? '定时任务' : status?.trigger === 'manual' ? '管理员手动' : '-';
  state.modelInfoCacheMeta.textContent = status
    ? `最近尝试：${formatDateTime(status.lastAttemptAt)}\n数据源：${status.sourceUrl || '-'}${status.error ? `\n错误：${status.error}` : ''}`
    : '当前没有模型信息缓存，请点击“立即同步”。';
}

function renderReasoningEfforts(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return '<span class="model-info-empty-value">无明确档位</span>';
  return `<div class="model-info-efforts">${efforts.map((effort) => `<span>${escapeHtml(effort)}</span>`).join('')}</div>`;
}

// 渲染当前分页的模型详细索引。
function renderModelInfoTable() {
  const models = appState.modelInfoModels || [];
  if (!models.length) {
    state.modelInfoTable.innerHTML = '<div class="empty">当前筛选条件下没有模型索引。</div>';
    return;
  }

  const rows = models.map((model) => `
    <tr class="${model.overridden ? 'is-overridden' : ''}">
      <td class="model-info-name-cell"><code title="${escapeHtml(model.modelName)}">${escapeHtml(model.modelName)}</code></td>
      <td>${renderReasoningEfforts(model.reasoningEfforts)}</td>
      <td class="model-info-number-cell">${escapeHtml(formatNumber(model.context))}</td>
      <td class="model-info-number-cell">${escapeHtml(formatNumber(model.output))}</td>
      <td><span class="model-info-source ${model.overridden ? 'is-overridden' : ''}">${model.overridden ? '人工修改' : '自动同步'}</span></td>
      <td class="model-info-time-cell">${escapeHtml(formatDateTime(model.updatedAt))}</td>
      <td class="model-info-row-actions">
        <button type="button" class="secondary-button" data-model-info-action="edit" data-model-name="${escapeHtml(model.modelName)}">修改</button>
        ${model.overridden ? `<button type="button" class="link-button" data-model-info-action="restore" data-model-name="${escapeHtml(model.modelName)}">恢复默认</button>` : ''}
      </td>
    </tr>
  `).join('');

  state.modelInfoTable.innerHTML = `
    <table class="model-info-table">
      <thead>
        <tr>
          <th>模型名称</th>
          <th>思考强度</th>
          <th>上下文长度</th>
          <th>最大输出</th>
          <th>数据来源</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateModelInfoPager() {
  const totalPages = Math.max(1, Math.ceil(appState.modelInfoTotal / appState.modelInfoPageSize));
  state.modelInfoPageInfo.textContent = `第 ${appState.modelInfoPage} / ${totalPages} 页，共 ${formatNumber(appState.modelInfoTotal)} 条`;
  state.modelInfoPageInput.value = String(appState.modelInfoPage);
  state.modelInfoPageInput.max = String(totalPages);
  state.prevModelInfoPage.disabled = appState.modelInfoPage <= 1;
  state.nextModelInfoPage.disabled = appState.modelInfoPage >= totalPages;
}

// 读取当前模型信息缓存状态和详细索引。
export async function loadModelInfoCache(options = {}) {
  assertAdminToken();
  saveSettings();
  const params = new URLSearchParams({
    q: state.modelInfoSearch.value.trim(),
    scope: state.modelInfoScope.value,
    page: String(appState.modelInfoPage),
    pageSize: String(appState.modelInfoPageSize),
  });
  const data = await requestJson(`/api/model-info-cache?${params.toString()}`);
  appState.modelInfoModels = data.models || [];
  appState.modelInfoTotal = Number(data.total) || 0;
  appState.modelInfoPage = Number(data.page) || 1;
  appState.modelInfoPageSize = Number(data.pageSize) || 50;
  renderModelInfoCache(data.status, data.overrideCount);
  renderModelInfoTable();
  updateModelInfoPager();
  if (!options.quiet) {
    setModelInfoCacheStatus(data.status?.lastSuccessAt ? `已读取 ${formatNumber(data.total)} 条模型索引。` : '当前还没有可用缓存。', data.status?.lastSuccessAt ? 'ok' : '');
  }
}

// 手动触发 models.dev 模型信息同步。
export async function syncModelInfoCache() {
  try {
    assertAdminToken();
    saveSettings();
    state.syncModelInfoCacheButton.disabled = true;
    setModelInfoCacheStatus('正在从 models.dev 同步模型信息...', '');
    await requestJson('/api/model-info-cache', { method: 'POST' });
    await loadModelInfoCache({ quiet: true });
    setModelInfoCacheStatus('模型信息同步完成，人工修改记录已保留。', 'ok');
  } catch (error) {
    setModelInfoCacheStatus(error?.message || String(error), 'error');
    await loadModelInfoCache({ quiet: true }).catch(() => undefined);
  } finally {
    state.syncModelInfoCacheButton.disabled = false;
  }
}

function openModelInfoEditor(modelName) {
  const model = (appState.modelInfoModels || []).find((item) => item.modelName === modelName);
  if (!model) {
    setModelInfoCacheStatus('未找到要修改的模型索引。', 'error');
    return;
  }
  state.modelInfoEditName.value = model.modelName;
  state.modelInfoEditEfforts.value = (model.reasoningEfforts || []).join(', ');
  state.modelInfoEditContext.value = String(model.context || 0);
  state.modelInfoEditOutput.value = String(model.output || 0);
  state.modelInfoEditDialog.showModal();
}

async function saveModelInfoEdit(event) {
  event.preventDefault();
  const modelName = state.modelInfoEditName.value.trim();
  const context = Number(state.modelInfoEditContext.value);
  const output = Number(state.modelInfoEditOutput.value);
  if (!Number.isInteger(context) || context < 0 || !Number.isInteger(output) || output < 0) {
    setModelInfoCacheStatus('上下文长度和最大输出必须是非负整数。', 'error');
    return;
  }

  try {
    state.saveModelInfoEdit.disabled = true;
    await requestJson('/api/model-info-cache/override', {
      method: 'POST',
      body: {
        modelName,
        reasoningEfforts: splitReasoningEfforts(state.modelInfoEditEfforts.value),
        context,
        output,
      },
    });
    await loadModelInfoCache({ quiet: true });
    state.modelInfoEditDialog.close();
    setModelInfoCacheStatus(`模型“${modelName}”已保存为人工修改。`, 'ok');
  } catch (error) {
    setModelInfoCacheStatus(error?.message || String(error), 'error');
  } finally {
    state.saveModelInfoEdit.disabled = false;
  }
}

async function restoreModelInfo(button, modelName) {
  try {
    button.disabled = true;
    await requestJson(`/api/model-info-cache/override?modelName=${encodeURIComponent(modelName)}`, { method: 'DELETE' });
    await loadModelInfoCache({ quiet: true });
    setModelInfoCacheStatus(`模型“${modelName}”已恢复默认，并重新参与自动同步。`, 'ok');
  } catch (error) {
    button.disabled = false;
    setModelInfoCacheStatus(error?.message || String(error), 'error');
  }
}

function reloadFirstModelInfoPage() {
  appState.modelInfoPage = 1;
  void loadModelInfoCache({ quiet: true }).catch((error) => setModelInfoCacheStatus(error?.message || String(error), 'error'));
}

function jumpModelInfoPage() {
  const totalPages = Math.max(1, Math.ceil(appState.modelInfoTotal / appState.modelInfoPageSize));
  const page = Number(state.modelInfoPageInput.value);
  if (!Number.isFinite(page)) return;
  appState.modelInfoPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  void loadModelInfoCache({ quiet: true }).catch((error) => setModelInfoCacheStatus(error?.message || String(error), 'error'));
}

// 绑定模型缓存页面的筛选、分页和编辑事件。
export function setupModelInfoCachePage() {
  state.modelInfoSearch.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(reloadFirstModelInfoPage, 250);
  });
  state.modelInfoScope.addEventListener('change', reloadFirstModelInfoPage);
  state.prevModelInfoPage.addEventListener('click', () => {
    appState.modelInfoPage = Math.max(1, appState.modelInfoPage - 1);
    void loadModelInfoCache({ quiet: true }).catch((error) => setModelInfoCacheStatus(error?.message || String(error), 'error'));
  });
  state.nextModelInfoPage.addEventListener('click', () => {
    appState.modelInfoPage += 1;
    void loadModelInfoCache({ quiet: true }).catch((error) => setModelInfoCacheStatus(error?.message || String(error), 'error'));
  });
  state.jumpModelInfoPage.addEventListener('click', jumpModelInfoPage);
  state.modelInfoPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') jumpModelInfoPage();
  });
  state.modelInfoTable.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-model-info-action]');
    if (!button) return;
    const modelName = button.dataset.modelName || '';
    if (button.dataset.modelInfoAction === 'edit') openModelInfoEditor(modelName);
    if (button.dataset.modelInfoAction === 'restore') void restoreModelInfo(button, modelName);
  });
  state.modelInfoEditForm.addEventListener('submit', saveModelInfoEdit);
  state.closeModelInfoEdit.addEventListener('click', () => state.modelInfoEditDialog.close());
  state.cancelModelInfoEdit.addEventListener('click', () => state.modelInfoEditDialog.close());
}
