import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { renderTable, updateLatestPager } from '../render.js';
import { appState, state } from '../state.js';

const allowedEvents = ['app_open', 'page_view', 'config_usage', 'ai_request', 'resource_click', 'agent_runtime'];

function ensureEventOptions() {
  if (state.latestEventOptions.children.length) return;
  for (const event of allowedEvents) {
    const option = document.createElement('option');
    option.value = event;
    state.latestEventOptions.appendChild(option);
  }
}

export async function loadLatest(options = {}) {
  if (options.resetLatestPage) {
    appState.latestPage = 1;
  }

  assertReady();
  await loadProjectOptions();
  saveSettings();
  ensureEventOptions();

  const { projectName } = getEncodedProjectAndDays();
  const event = state.latestEventFilter.value.trim();
  const eventQuery = event ? `&event=${encodeURIComponent(event)}` : '';
  const latest = await requestJson(`/api/latest?projectName=${projectName}&page=${appState.latestPage}${eventQuery}`);

  appState.latestTotal = Number(latest.total || 0);
  appState.latestPage = Number(latest.page || appState.latestPage);
  updateLatestPager();

  const events = [...(latest.events || [])].sort((left, right) => Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''));

  renderTable(state.latestTable, events, [
    { key: 'timestamp', label: '时间' },
    { key: 'event', label: '事件', code: true },
    { key: 'page', label: '页面', code: true },
    { key: 'version', label: '版本', code: true },
    { key: 'platform', label: '平台' },
    { key: 'arch', label: '架构' },
    { key: 'clientCreatedAt', label: '创建日期' },
    { key: 'clientId', label: '客户端ID', code: true },
  ], '暂无最近事件');
}
