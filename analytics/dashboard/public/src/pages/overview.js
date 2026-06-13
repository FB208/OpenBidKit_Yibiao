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

  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
}

function renderGitHubStats(repo) {
  state.githubStars.textContent = repo ? formatNumber(repo.stars) : '-';
  state.githubForks.textContent = repo ? formatNumber(repo.forks) : '-';
  state.githubOpenIssues.textContent = repo ? formatNumber(repo.openIssues) : '-';
  state.githubRepoUrl.href = repo?.htmlUrl || 'https://github.com/FB208/OpenBidKit_Yibiao';
}

export async function loadOverview() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName, days } = getEncodedProjectAndDays(state.overviewRange.value);
  const [summary, retention, githubStats] = await Promise.all([
    requestJson(`/api/overview?projectName=${projectName}&days=${days}`),
    requestJson(`/api/retention?projectName=${projectName}&days=${days}`),
    requestJson('/api/github-repo-stats').catch(() => ({ repo: null })),
  ]);

  const daily = normalizeDaily(summary.daily || [], summary.dailyClients || []);
  const totalOpen = Number(summary.totalOpen || 0);
  const totalView = Number(summary.totalView || 0);

  state.totalOpen.textContent = formatNumber(totalOpen);
  state.totalView.textContent = formatNumber(totalView);
  state.totalEvents.textContent = formatNumber(summary.totalEvents);
  state.totalAiRequests.textContent = formatNumber(summary.totalAiRequests);
  state.totalResourceClicks.textContent = formatNumber(summary.totalResourceClicks);
  state.totalClients.textContent = formatNumber(summary.totalClients);
  state.todayActiveClients.textContent = formatNumber(summary.todayActiveClients);
  state.yesterdayActiveClients.textContent = formatNumber(summary.yesterdayActiveClients);
  state.wau.textContent = formatNumber(summary.wau);
  state.mau.textContent = formatNumber(summary.mau);
  state.todayNewClients.textContent = formatNumber(summary.todayNewClients);
  state.last30NewClients.textContent = formatNumber(summary.last30NewClients);
  state.newClients.textContent = formatNumber(summary.newClients);
  state.returningClients.textContent = formatNumber(summary.returningClients);
  renderGitHubStats(githubStats.repo);

  renderTable(state.dailyTable, daily, [
    { key: 'date', label: '日期' },
    { key: 'clients', label: '打开客户端数' },
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
