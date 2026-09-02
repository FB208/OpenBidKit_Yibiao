import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, renderTable, setError } from '../render.js';
import { appState, state } from '../state.js';

function detailButton(clientId) {
  return `<button class="link-button" type="button" data-client-detail="${escapeHtml(clientId)}">详情</button>`;
}

function licenseStatusText(value) {
  const status = String(value || '').trim();
  const map = {
    active: '有效',
    expired: '已过期',
    missing: '无授权',
    invalid: '签名无效',
    invalidated: '已失效',
    machine_mismatch: '设备不匹配',
    refresh_failed: '刷新失败',
  };
  return map[status] || status || '-';
}

function licensePlanText(value) {
  const plan = String(value || '').trim();
  const map = {
    free: '免费授权',
    offline: '离线授权',
    personal_premium: '个人高级版',
    enterprise_premium: '企业高级版',
  };
  return map[plan] || plan || '-';
}

function sourceTrustedText(value) {
  if (value === 'true' || value === true) return '可信';
  if (value === 'false' || value === false) return '不可信';
  return '-';
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

// 按当前筛选和页码加载客户端列表。
export async function loadClients(options = {}) {
  if (options.resetClientsPage) {
    appState.clientsPage = 1;
  }

  assertReady();
  await loadProjectOptions();
  saveSettings();

  const query = new URLSearchParams({
    projectName: state.projectName.value.trim(),
    page: String(appState.clientsPage),
  });
  const filters = [
    ['clientId', state.clientIdFilter.value.trim()],
    ['activeFrom', state.clientActiveFrom.value],
    ['activeTo', state.clientActiveTo.value],
    ['licensePlan', state.clientLicensePlan.value],
    ['lastAccessIp', state.clientIpFilter.value.trim()],
    ['lastActiveVersion', state.clientVersionFilter.value.trim()],
  ];
  for (const [key, value] of filters) {
    if (value) query.set(key, value);
  }

  const data = await requestJson(`/api/clients?${query}`);
  appState.clientsTotal = Number(data.total || 0);
  appState.clientsPage = Number(data.page || appState.clientsPage);
  appState.clientsPageSize = Number(data.pageSize || appState.clientsPageSize);
  const rows = (data.items || []).map((client) => ({
    ...client,
    activeDays: formatNumber(client.activeDays),
    licensePlanText: licensePlanText(client.licensePlan),
    licenseStatusText: licenseStatusText(client.licenseStatus),
    sourceTrustedText: sourceTrustedText(client.sourceTrusted),
    action: detailButton(client.clientId),
  }));

  renderTable(state.clientsTable, rows, [
    { key: 'clientId', label: '客户端 ID', code: true },
    { key: 'firstSeenAt', label: '首次访问时间' },
    { key: 'activeDays', label: '访问天数' },
    { key: 'lastActiveDate', label: '最近活跃日期' },
    { key: 'lastActiveVersion', label: '最近活跃版本', code: true },
    { key: 'licensePlanText', label: '授权类型' },
    { key: 'licenseStatusText', label: '授权状态' },
    { key: 'licenseExpiresAt', label: '授权有效期' },
    { key: 'sourceTrustedText', label: '安装来源' },
    { key: 'lastAccessIp', label: '最后访问 IP', code: true },
    { key: 'action', label: '操作', html: true },
  ], '暂无客户端数据');
  bindClientDetailButtons();
}

export async function loadIpStats(options = {}) {
  if (options.resetIpPage) {
    appState.ipPage = 1;
  }

  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName } = getEncodedProjectAndDays();
  const activityDate = state.ipDate.value;
  const dateQuery = activityDate ? `&date=${encodeURIComponent(activityDate)}` : '';
  const data = await requestJson(`/api/ip-stats?projectName=${projectName}&page=${appState.ipPage}${dateQuery}`);
  appState.ipTotal = Number(data.total || 0);
  appState.ipPage = Number(data.page || appState.ipPage);
  appState.ipPageSize = Number(data.pageSize || appState.ipPageSize);
  const rows = (data.items || []).map((item) => ({
    ip: item.ip,
    clientCount: formatNumber(item.clientCount),
    newClientCount: formatNumber(item.newClientCount),
    totalTokens: formatNumber(item.totalTokens),
    aiServices: (item.aiServices || [])
      .map((service) => [service.provider, service.endpointHost].filter(Boolean).join(' / '))
      .join('；') || '-',
    action: `<button class="danger-button" type="button" data-ip-stats-block="${escapeHtml(item.ip)}">封禁</button>`,
  }));

  const columns = [
    { key: 'ip', label: 'IP 地址', code: true },
    { key: 'clientCount', label: '客户端数' },
  ];
  if (activityDate) {
    columns.push({ key: 'newClientCount', label: '新客户端数' });
    columns.push({ key: 'totalTokens', label: 'Total Tokens' });
    columns.push({ key: 'aiServices', label: 'AI 服务商 / 域名', code: true });
  }
  columns.push({ key: 'action', label: '操作', html: true });
  renderTable(state.ipStatsTable, rows, columns, '暂无 IP 统计数据');
}

// 从 IP 统计表直接添加全局封禁。
export function setupIpStatsActions() {
  state.ipStatsTable.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ip-stats-block]');
    if (!button) return;
    const ip = button.dataset.ipStatsBlock;
    if (!window.confirm(`确认添加全局 IP 规则「${ip}」并清理当前项目可恢复的历史统计吗？`)) return;

    button.disabled = true;
    button.textContent = '封禁中';
    try {
      const date = state.ipDate.value;
      const data = await requestJson('/api/block-rules', {
        method: 'POST',
        body: {
          type: 'ip',
          value: ip,
          projectName: state.projectName.value.trim(),
          reason: date ? `IP 统计快捷封禁（${date}）` : 'IP 统计快捷封禁',
        },
      });
      setError('');
      button.textContent = data.cleanup?.status === 'failed' ? '已封禁（清理失败）' : '已封禁';
      button.title = data.cleanup?.status === 'failed'
        ? `规则已生效，历史清理失败：${data.cleanup.error || '请到封禁规则页重试'}`
        : `历史统计已清理至 ${data.cleanup?.cleanedUntil || '当前汇总进度'}`;
    } catch (error) {
      button.disabled = false;
      button.textContent = '封禁';
      setError(error?.message || String(error));
    }
  });
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
