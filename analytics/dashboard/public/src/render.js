import { appState, state } from './state.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

export function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

export function setStatus(type, text) {
  state.statusDot.className = type === 'ok' ? 'dot ok' : type === 'error' ? 'dot error' : 'dot';
  state.statusText.textContent = text;
}

export function setError(message) {
  state.errorBox.style.display = message ? 'block' : 'none';
  state.errorBox.textContent = message || '';
}

export function renderTable(target, rows, columns, emptyText) {
  if (!rows || rows.length === 0) {
    target.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const value = row[column.key] == null || row[column.key] === '' ? '-' : row[column.key];
      const content = column.html ? value : column.code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value);
      return `<td>${content}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  target.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function updateLatestPager() {
  const totalPages = Math.max(1, Math.ceil(appState.latestTotal / appState.latestPageSize));
  state.latestPageInfo.textContent = `第 ${appState.latestPage} / ${totalPages} 页，共 ${formatNumber(appState.latestTotal)} 条`;
  state.latestPageInput.value = String(appState.latestPage);
  state.latestPageInput.max = String(totalPages);
  state.prevLatestPage.disabled = appState.latestPage <= 1;
  state.nextLatestPage.disabled = appState.latestPage >= totalPages;
}

export function setNoticeStatus(message, type = '') {
  state.noticeStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.noticeStatus.textContent = message || '';
}
