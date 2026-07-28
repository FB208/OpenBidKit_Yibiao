import { assertAdminToken, requestJson, saveSettings } from '../api.js';
import { formatNumber } from '../render.js';
import { state } from '../state.js';

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

// 渲染模型信息缓存的最近同步状态。
function renderModelInfoCache(status) {
  const available = Boolean(status?.lastSuccessAt);
  state.modelInfoCacheState.textContent = status?.status === 'failed' ? '同步失败' : available ? '可用' : '未同步';
  state.modelInfoCacheLastSuccess.textContent = formatDateTime(status?.lastSuccessAt);
  state.modelInfoCacheProviders.textContent = formatNumber(status?.providerCount || 0);
  state.modelInfoCacheSourceModels.textContent = formatNumber(status?.sourceModelCount || 0);
  state.modelInfoCacheModels.textContent = formatNumber(status?.indexedModelCount || 0);
  state.modelInfoCacheReasoningModels.textContent = formatNumber(status?.reasoningEffortModelCount || 0);
  state.modelInfoCacheBytes.textContent = formatBytes(status?.sourceBytes);
  state.modelInfoCacheTrigger.textContent = status?.trigger === 'cron' ? '定时任务' : status?.trigger === 'manual' ? '管理员手动' : '-';
  state.modelInfoCacheMeta.textContent = status
    ? `最近尝试：${formatDateTime(status.lastAttemptAt)}\n数据源：${status.sourceUrl || '-'}${status.error ? `\n错误：${status.error}` : ''}`
    : '当前没有模型信息缓存，请点击“立即同步”。';
}

// 读取当前模型信息缓存状态。
export async function loadModelInfoCache(options = {}) {
  assertAdminToken();
  saveSettings();
  const data = await requestJson('/api/model-info-cache');
  renderModelInfoCache(data.status);
  if (!options.quiet) {
    setModelInfoCacheStatus(data.status?.lastSuccessAt ? '模型信息缓存状态已读取。' : '当前还没有可用缓存。', data.status?.lastSuccessAt ? 'ok' : '');
  }
}

// 手动触发 models.dev 模型信息同步。
export async function syncModelInfoCache() {
  try {
    assertAdminToken();
    saveSettings();
    state.syncModelInfoCacheButton.disabled = true;
    setModelInfoCacheStatus('正在从 models.dev 同步模型信息...', '');
    const data = await requestJson('/api/model-info-cache', { method: 'POST' });
    renderModelInfoCache(data.status);
    setModelInfoCacheStatus('模型信息同步完成。', 'ok');
  } catch (error) {
    setModelInfoCacheStatus(error?.message || String(error), 'error');
    await loadModelInfoCache({ quiet: true }).catch(() => undefined);
  } finally {
    state.syncModelInfoCacheButton.disabled = false;
  }
}
