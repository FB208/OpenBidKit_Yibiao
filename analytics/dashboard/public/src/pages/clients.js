import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, renderTable } from '../render.js';
import { appState, state } from '../state.js';

function detailButton(clientId) {
  return `<button class="link-button" type="button" data-client-detail="${escapeHtml(clientId)}">详情</button>`;
}

function bindClientDetailButtons() {
  state.clientsTable.querySelectorAll('[data-client-detail]').forEach((button) => {
    button.addEventListener('click', () => {
      appState.selectedClientId = button.getAttribute('data-client-detail') || '';
      state.clientDetailTitle.textContent = appState.selectedClientId || '未选择客户端';
      state.clientDetailDialog.showModal();
      void loadClientDetail();
    });
  });
}

export async function loadClients() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName } = getEncodedProjectAndDays();
  const data = await requestJson(`/api/clients?projectName=${projectName}`);
  const rows = (data.clients || []).map((client) => ({
    ...client,
    activeDays: formatNumber(client.activeDays),
    action: detailButton(client.clientId),
  }));

  renderTable(state.clientsTable, rows, [
    { key: 'clientId', label: '客户端 ID', code: true },
    { key: 'firstSeenAt', label: '首次访问时间' },
    { key: 'activeDays', label: '访问天数' },
    { key: 'lastActiveDate', label: '最近活跃日期' },
    { key: 'lastActiveVersion', label: '最近活跃版本', code: true },
    { key: 'action', label: '操作', html: true },
  ], '暂无客户端数据');
  bindClientDetailButtons();
}

export async function loadClientDetail() {
  if (!appState.selectedClientId) {
    return;
  }

  const { projectName } = getEncodedProjectAndDays();
  const clientId = encodeURIComponent(appState.selectedClientId);
  const range = encodeURIComponent(state.clientDetailRange.value || '7');
  const data = await requestJson(`/api/client-detail?projectName=${projectName}&clientId=${clientId}&range=${range}`);
  const daily = (data.daily || []).map((row) => ({
    date: row.date,
    total: formatNumber(row.total),
    appOpen: formatNumber(row.events?.app_open || 0),
    pageView: formatNumber(row.events?.page_view || 0),
    configUsage: formatNumber(row.events?.config_usage || 0),
    aiRequest: formatNumber(row.events?.ai_request || 0),
    resourceClick: formatNumber(row.events?.resource_click || 0),
  }));
  const events = (data.events || []).map((row) => ({
    event: row.event,
    count: formatNumber(row.count),
  }));

  renderTable(state.clientDetailDaily, daily, [
    { key: 'date', label: '日期' },
    { key: 'total', label: '事件数' },
    { key: 'appOpen', label: '打开' },
    { key: 'pageView', label: '页面访问' },
    { key: 'configUsage', label: '配置' },
    { key: 'aiRequest', label: 'AI 请求' },
    { key: 'resourceClick', label: '资源点击' },
  ], '暂无客户端明细');
  renderTable(state.clientDetailEvents, events, [
    { key: 'event', label: '事件', code: true },
    { key: 'count', label: '次数' },
  ], '暂无事件汇总');
}
