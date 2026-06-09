import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { state } from '../state.js';

function labelConfigValue(groupKey, value) {
  const labels = {
    fileParserProviders: {
      local: '本地解析',
      'mineru-accurate-api': 'MinerU 精准解析 API',
      'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
    },
    textModelProviders: {
      jinlong: '金龙中转站',
      volcengine: '火山方舟',
      deepseek: 'DeepSeek',
      longcat: '龙猫',
      custom: '自定义文本服务',
    },
    imageProviders: { jinlong: '金龙中转站', volcengine: '火山方舟', 'google-ai-studio': 'Google AI Studio', custom: '自定义生图服务' },
    imageModelStatuses: { untested: '未测试', available: '可用', unavailable: '不可用' },
    bidAnalysisModes: { key: '只解析关键项', full: '完整解析' },
    outlineModes: { free: '自由生成', aligned: '按评分项对齐' },
    tableRequirements: { none: '不要', light: '少量', moderate: '适中', heavy: '大量' },
    useMermaidImages: { true: '开启', false: '关闭' },
    useAiImages: { true: '开启', false: '关闭' },
    enableConsistencyAudit: { true: '开启', false: '关闭' },
    contentGenerationActions: {
      start: '首次生成',
      'continue': '继续生成',
      regenerate: '重新生成正文',
      retry_minimum_words: '继续补足字数',
      regenerate_section: '小节重新生成',
    },
  };

  return labels[groupKey]?.[value] || value || '-';
}

function labelModelProvider(groupKey, value) {
  return labelConfigValue(groupKey === 'textModelUsage' ? 'textModelProviders' : 'imageProviders', value);
}

const configUsageGroups = [
  ['fileParserProviders', '文件解析方式'],
  ['imageProviders', '生图服务商'],
  ['imageModelStatuses', '生图模型状态'],
  ['bidAnalysisModes', 'Step 02 解析模式'],
  ['outlineModes', 'Step 03 目录模式'],
  ['tableRequirements', '正文表格需求'],
  ['minimumWords', '最低字数'],
  ['contentConcurrencies', '正文生成并发速度'],
  ['contentGenerationActions', '正文生成动作'],
  ['enableConsistencyAudit', '全文一致性审计'],
  ['useMermaidImages', 'Mermaid 图片'],
  ['useAiImages', 'AI 生图'],
];

const modelUsageGroups = [
  ['textModelUsage', '文本模型请求'],
  ['imageModelUsage', '生图模型请求'],
];

function renderUsageGroups(target, usage, groups) {
  target.innerHTML = `<div class="usage-grid">${groups.map(([key, label]) => {
    const rows = usage?.[key] || [];
    const body = rows.length
      ? `<table><thead><tr><th>取值</th><th>客户端</th><th>次数</th></tr></thead><tbody>${rows.map((row) => `
          <tr>
            <td><code>${escapeHtml(labelConfigValue(key, row.value))}</code></td>
            <td>${formatNumber(row.clients)}</td>
            <td>${formatNumber(row.events)}</td>
          </tr>
        `).join('')}</tbody></table>`
      : '<div class="empty">暂无数据</div>';
    return `<div class="usage-card"><h3>${escapeHtml(label)}</h3>${body}</div>`;
  }).join('')}</div>`;
}

function renderModelUsageGroups(target, usage, groups) {
  target.innerHTML = `<div class="usage-grid">${groups.map(([key, label]) => {
    const rows = usage?.[key] || [];
    const body = rows.length
      ? `<table><thead><tr><th>服务商</th><th>域名</th><th>模型</th><th>客户端</th><th>次数</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Total Tokens</th></tr></thead><tbody>${rows.map((row) => `
          <tr>
            <td><code>${escapeHtml(labelModelProvider(key, row.provider))}</code></td>
            <td><code>${escapeHtml(row.endpoint_host || row.base_url || '-')}</code></td>
            <td><code>${escapeHtml(row.model || '-')}</code></td>
            <td>${formatNumber(row.clients)}</td>
            <td>${formatNumber(row.events)}</td>
            <td>${formatNumber(row.prompt_tokens)}</td>
            <td>${formatNumber(row.completion_tokens)}</td>
            <td>${formatNumber(row.total_tokens)}</td>
          </tr>
        `).join('')}</tbody></table>`
      : '<div class="empty">暂无数据</div>';
    return `<div class="usage-card usage-card-wide"><h3>${escapeHtml(label)}</h3>${body}</div>`;
  }).join('')}</div>`;
}

async function loadUsage() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName, days } = getEncodedProjectAndDays();
  return requestJson(`/api/config-usage?projectName=${projectName}&days=${days}`);
}

export async function loadConfigUsage() {
  const data = await loadUsage();
  renderUsageGroups(state.configUsage, data.usage || {}, configUsageGroups);
}

export async function loadModelUsage() {
  const data = await loadUsage();
  renderModelUsageGroups(state.modelUsage, data.usage || {}, modelUsageGroups);
}
