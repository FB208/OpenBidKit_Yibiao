import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { renderTable } from '../render.js';
import { state } from '../state.js';

export async function loadTraffic() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName, days } = getEncodedProjectAndDays();
  const summary = await requestJson(`/api/summary?projectName=${projectName}&days=${days}`);

  renderTable(state.pagesTable, summary.pages || [], [
    { key: 'page', label: '页面', code: true },
    { key: 'count', label: '访问量' },
  ], '暂无页面访问数据');

  renderTable(state.versionsTable, summary.versions || [], [
    { key: 'version', label: '版本', code: true },
    { key: 'clients', label: '活跃客户端数' },
    { key: 'count', label: '事件数' },
  ], '暂无版本数据');
}
