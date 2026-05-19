import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { renderTable, updateLatestPager } from '../render.js';
import { appState, state } from '../state.js';

export async function loadLatest(options = {}) {
  if (options.resetLatestPage) {
    appState.latestPage = 1;
  }

  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName } = getEncodedProjectAndDays();
  const latest = await requestJson(`/api/latest?projectName=${projectName}&page=${appState.latestPage}`);

  appState.latestTotal = Number(latest.total || 0);
  appState.latestPage = Number(latest.page || appState.latestPage);
  updateLatestPager();

  renderTable(state.latestTable, latest.events || [], [
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
