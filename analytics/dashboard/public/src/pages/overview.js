import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { state } from '../state.js';
import { formatNumber, formatPercent, renderTable } from '../render.js';

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

  const { projectName } = getEncodedProjectAndDays('30');
  const [summary, retention, githubStats] = await Promise.all([
    requestJson(`/api/overview?projectName=${projectName}`),
    requestJson(`/api/retention?projectName=${projectName}&days=30`).catch(() => ({ retention: [] })),
    requestJson('/api/github-repo-stats').catch(() => ({ repo: null })),
  ]);

  const daily = (summary.daily || []).map((row) => ({
    date: row.date,
    activeClients: formatNumber(row.activeClients),
    appOpen: formatNumber(row.appOpen),
    pageView: formatNumber(row.pageView),
  }));
  const totalOpen = Number(summary.totalOpen || 0);
  const totalView = Number(summary.totalView || 0);

  state.totalOpen.textContent = formatNumber(totalOpen);
  state.totalView.textContent = formatNumber(totalView);
  state.totalEvents.textContent = formatNumber(summary.totalEvents);
  state.totalAiRequests.textContent = formatNumber(summary.totalAiRequests);
  state.totalClients.textContent = formatNumber(summary.totalClients);
  state.todayActiveClients.textContent = formatNumber(summary.todayActiveClients);
  state.todayNewClients.textContent = formatNumber(summary.todayNewClients);
  state.last7NewClients.textContent = formatNumber(summary.last7NewClients);
  renderGitHubStats(githubStats.repo);

  renderTable(state.dailyTable, daily, [
    { key: 'date', label: '日期' },
    { key: 'activeClients', label: '活跃客户端数' },
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
