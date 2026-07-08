import { assertReady, buildRangeQuery, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, formatPercent } from '../render.js';
import { state } from '../state.js';

function renderModelRows(models = []) {
  if (!models.length) {
    return '<div class="empty">暂无模型维度数据</div>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>服务商</th>
          <th>域名</th>
          <th>模型</th>
          <th>成功</th>
          <th>失败</th>
          <th>总数</th>
          <th>重试次数</th>
          <th>最终成功率</th>
          <th>重试成功率</th>
        </tr>
      </thead>
      <tbody>${models.map((row) => `
        <tr>
          <td><code>${escapeHtml(row.provider || '-')}</code></td>
          <td><code>${escapeHtml(row.endpointHost || row.endpoint_host || '-')}</code></td>
          <td><code>${escapeHtml(row.model || '-')}</code></td>
          <td>${formatNumber(row.successCount)}</td>
          <td>${formatNumber(row.failedCount)}</td>
          <td>${formatNumber(row.totalCount)}</td>
          <td>${formatNumber(row.retryCount)}</td>
          <td>${formatPercent(row.successRate)}</td>
          <td>${formatPercent(row.retrySuccessRate)}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

function renderAgentRuntime(stats = {}) {
  const successCount = Number(stats.successCount || 0);
  const failedCount = Number(stats.failedCount || 0);
  const totalCount = Number(stats.totalCount || 0);
  const successRate = Number(stats.successRate || 0);
  const retryCount = Number(stats.retryCount || 0);
  const retriedRunCount = Number(stats.retriedRunCount || 0);
  const retrySuccessCount = Number(stats.retrySuccessCount || 0);
  const retrySuccessRate = Number(stats.retrySuccessRate || 0);
  const models = Array.isArray(stats.models) ? stats.models : [];

  state.agentRuntime.innerHTML = `
    <div class="agent-runtime-layout">
      <div class="agent-runtime-card panel">
        <h3>Agent分析</h3>
        <span>Agent 最终成功率</span>
        <strong>${formatPercent(successRate)}</strong>
        <div class="agent-runtime-metrics">
          <div><small>成功次数</small><b>${formatNumber(successCount)}</b></div>
          <div><small>失败次数</small><b>${formatNumber(failedCount)}</b></div>
          <div><small>总数</small><b>${formatNumber(totalCount)}</b></div>
          <div><small>重试次数</small><b>${formatNumber(retryCount)}</b></div>
          <div><small>重试任务数</small><b>${formatNumber(retriedRunCount)}</b></div>
          <div><small>重试后成功</small><b>${formatNumber(retrySuccessCount)}</b></div>
          <div><small>最终成功率</small><b>${formatPercent(successRate)}</b></div>
          <div><small>重试成功率</small><b>${formatPercent(retrySuccessRate)}</b></div>
        </div>
      </div>
      <div class="agent-runtime-models panel">
        <h3>模型维度</h3>
        ${renderModelRows(models)}
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
