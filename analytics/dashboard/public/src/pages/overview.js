import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { state } from '../state.js';
import { formatNumber, formatPercent, renderTable } from '../render.js';

function normalizeDaily(rows, clientRows) {
  const map = new Map();
  for (const row of rows || []) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    if (!map.has(date)) map.set(date, { date, clients: 0, appOpen: 0, pageView: 0 });
    const item = map.get(date);
    if (row.event === 'app_open') item.appOpen += Number(row.count || 0);
    if (row.event === 'page_view') item.pageView += Number(row.count || 0);
  }

  for (const row of clientRows || []) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    if (!map.has(date)) map.set(date, { date, clients: 0, appOpen: 0, pageView: 0 });
    map.get(date).clients = Number(row.clients || 0);
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadOverview() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName, days } = getEncodedProjectAndDays();
  const [summary, retention] = await Promise.all([
    requestJson(`/api/summary?projectName=${projectName}&days=${days}`),
    requestJson(`/api/retention?projectName=${projectName}&days=${days}`),
  ]);

  const daily = normalizeDaily(summary.daily || [], summary.dailyClients || []);
  const totalOpen = daily.reduce((sum, row) => sum + row.appOpen, 0);
  const totalView = daily.reduce((sum, row) => sum + row.pageView, 0);

  state.totalOpen.textContent = formatNumber(totalOpen);
  state.totalView.textContent = formatNumber(totalView);
  state.totalClients.textContent = formatNumber(summary.totalClients);
  state.todayActiveClients.textContent = formatNumber(summary.todayActiveClients);
  state.wau.textContent = formatNumber(summary.wau);
  state.mau.textContent = formatNumber(summary.mau);
  state.newClients.textContent = formatNumber(summary.newClients);
  state.returningClients.textContent = formatNumber(summary.returningClients);

  renderTable(state.dailyTable, daily, [
    { key: 'date', label: '日期' },
    { key: 'clients', label: '客户端数' },
    { key: 'appOpen', label: '打开量' },
    { key: 'pageView', label: '页面访问量' },
  ], '暂无每日统计数据');

  renderTable(state.retentionTable, (retention.retention || []).map((row) => ({
    ...row,
    retentionRate: formatPercent(row.retentionRate),
  })), [
    { key: 'day', label: '留存日' },
    { key: 'cohortClients', label: '可观察客户端' },
    { key: 'retainedClients', label: '当日回访客户端' },
    { key: 'retentionRate', label: '留存率' },
  ], '暂无留存数据');
}
