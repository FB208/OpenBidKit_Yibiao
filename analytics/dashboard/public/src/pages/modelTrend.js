import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { state } from '../state.js';

const TREND_COLORS = [
  '#2563eb', '#f97316', '#22c55e', '#a855f7', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16',
];

const CHART_WIDTH = 960;
const CHART_HEIGHT = 340;
const PAD_LEFT = 64;
const PAD_RIGHT = 16;
const PAD_TOP = 14;
const PAD_BOTTOM = 36;

function formatAxisTokens(value) {
  const fixed = (ratio) => {
    const text = ratio >= 100 ? ratio.toFixed(0) : ratio.toFixed(1);
    return text.replace(/\.0$/, '');
  };
  if (value >= 1e8) return `${fixed(value / 1e8)}亿`;
  if (value >= 1e4) return `${fixed(value / 1e4)}万`;
  return String(Math.round(value));
}

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  for (const multiplier of [1, 2, 5, 10]) {
    if (rough <= multiplier * pow) return multiplier * pow;
  }
  return 10 * pow;
}

function renderModelTrend(target, data) {
  const dates = data.dates || [];
  const total = data.total || [];
  const series = [
    { label: '全部文本 Token', values: total, total: true },
    ...(data.series || []).map((item) => ({
      label: item.endpointHost || '未记录域名',
      values: item.values || [],
    })),
  ];

  if (!dates.length) {
    target.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  const innerWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const step = niceStep(Math.max(1, ...total) / 4);
  const yMax = step * Math.ceil(Math.max(1, ...total) / step);
  const x = (index) => PAD_LEFT + (dates.length === 1 ? innerWidth / 2 : (index * innerWidth) / (dates.length - 1));
  const y = (value) => PAD_TOP + innerHeight - (Math.max(0, value) / yMax) * innerHeight;
  const xLabelEvery = Math.max(1, Math.ceil(dates.length / 6));

  const grid = [];
  const yLabels = [];
  for (let value = 0; value <= yMax; value += step) {
    const top = y(value);
    grid.push(`<line class="trend-grid" x1="${PAD_LEFT}" y1="${top}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${top}" />`);
    yLabels.push(`<text class="trend-axis-text" x="${PAD_LEFT - 8}" y="${top + 4}" text-anchor="end">${escapeHtml(formatAxisTokens(value))}</text>`);
  }
  const xLabels = dates
    .map((date, index) => (index % xLabelEvery === 0 || index === dates.length - 1
      ? `<text class="trend-axis-text" x="${x(index)}" y="${CHART_HEIGHT - 10}" text-anchor="middle">${escapeHtml(date.slice(5))}</text>`
      : ''))
    .join('');

  const lines = series.map((item, index) => {
    const color = TREND_COLORS[index % TREND_COLORS.length];
    const points = item.values.map((value, pointIndex) => `${x(pointIndex)},${y(value)}`).join(' ');
    const dots = item.values.map((value, pointIndex) => (
      `<circle class="trend-dot" cx="${x(pointIndex)}" cy="${y(value)}" r="3" fill="${color}"><title>${escapeHtml(dates[pointIndex])} ${escapeHtml(item.label)}：${escapeHtml(formatNumber(value))}</title></circle>`
    )).join('');
    return `<polyline class="trend-line${item.total ? ' trend-line-total' : ''}" points="${points}" stroke="${color}" /><g>${dots}</g>`;
  }).join('');

  const legend = series.map((item, index) => {
    const color = TREND_COLORS[index % TREND_COLORS.length];
    return `<span class="trend-legend-item"><i class="trend-legend-swatch" style="background:${color}"></i>${escapeHtml(item.label)}</span>`;
  }).join('');

  target.innerHTML = `
    <div class="trend-chart">
      <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="模型趋势折线图">
        ${grid.join('')}
        ${yLabels.join('')}
        ${xLabels}
        ${lines}
      </svg>
      <div class="trend-legend">${legend}</div>
    </div>`;
}

export async function loadModelTrend() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const { projectName } = getEncodedProjectAndDays();
  const days = String(state.modelTrendRange.value || '30');
  const data = await requestJson(`/api/model-trend?projectName=${projectName}&days=${encodeURIComponent(days)}`);
  renderModelTrend(state.modelTrendChart, data);
}
