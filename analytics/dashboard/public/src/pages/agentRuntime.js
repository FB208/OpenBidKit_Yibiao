import { assertReady, buildRangeQuery, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { formatNumber, formatPercent } from '../render.js';
import { state } from '../state.js';

function renderAgentRuntime(stats = {}) {
  const successCount = Number(stats.successCount || 0);
  const failedCount = Number(stats.failedCount || 0);
  const totalCount = Number(stats.totalCount || 0);
  const successRate = Number(stats.successRate || 0);

  state.agentRuntime.innerHTML = `
    <div class="agent-runtime-card panel">
      <h3>Agent分析</h3>
      <span>agent执行成功率</span>
      <strong>${formatPercent(successRate)}</strong>
      <div class="agent-runtime-metrics">
        <div><small>成功次数</small><b>${formatNumber(successCount)}</b></div>
        <div><small>失败次数</small><b>${formatNumber(failedCount)}</b></div>
        <div><small>总数</small><b>${formatNumber(totalCount)}</b></div>
        <div><small>成功率</small><b>${formatPercent(successRate)}</b></div>
      </div>
    </div>
  `;
}

export async function loadAgentRuntime() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const range = String(state.agentRange.value || 'history');
  const { projectName } = getEncodedProjectAndDays();
  const data = await requestJson(`/api/agent-runtime?projectName=${projectName}&${buildRangeQuery(range)}`);
  renderAgentRuntime(data.agentRuntime || {});
}
