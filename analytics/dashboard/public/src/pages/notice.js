import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, setNoticeStatus } from '../render.js';
import { appState, state } from '../state.js';

let markdownRenderer;

// 使用与客户端相同的基础配置渲染公告 Markdown，并允许公告内嵌 HTML。
function renderNoticePreview() {
  markdownRenderer ||= window.markdownit({
    html: true,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  const content = state.noticeContent.value;
  if (!content.trim()) {
    state.noticePreviewContent.innerHTML = '<div class="notice-preview-empty">暂无可预览内容。</div>';
    return;
  }

  state.noticePreviewContent.innerHTML = markdownRenderer.render(content);
  for (const link of state.noticePreviewContent.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
}

// 切换公告正文的编辑和预览面板。
function setNoticeContentMode(mode) {
  const previewing = mode === 'preview';
  if (previewing) renderNoticePreview();
  state.noticeEditorTab.classList.toggle('active', !previewing);
  state.noticePreviewTab.classList.toggle('active', previewing);
  state.noticeEditorTab.setAttribute('aria-selected', String(!previewing));
  state.noticePreviewTab.setAttribute('aria-selected', String(previewing));
  state.noticeEditorPanel.hidden = previewing;
  state.noticePreviewPanel.hidden = !previewing;
}

// 渲染公告历史列表。
function renderNoticesTable() {
  const notices = appState.notices || [];
  if (!notices.length) {
    state.noticesTable.innerHTML = '<div class="empty">当前项目暂无已保存公告。</div>';
    return;
  }

  const rows = notices.map((notice) => `
    <tr>
      <td class="notice-title-cell">
        <strong>${escapeHtml(notice.title)}</strong>
        ${notice.current ? '<span class="notice-current-badge">当前 KV</span>' : ''}
        <small>${escapeHtml(notice.clientNoticeId || '-')}</small>
      </td>
      <td>${escapeHtml(notice.enabled ? '启用' : '不展示')}</td>
      <td>${escapeHtml(formatNumber(notice.deliveredUserCount))}</td>
      <td>${escapeHtml(notice.updatedAt || '-')}</td>
      <td class="notice-row-actions">
        <button type="button" class="secondary-button" data-notice-action="edit" data-notice-id="${escapeHtml(notice.id)}">编辑</button>
        <button type="button" class="danger-button" data-notice-action="delete" data-notice-id="${escapeHtml(notice.id)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.noticesTable.innerHTML = `
    <table class="notice-table">
      <thead><tr><th>公告</th><th>状态</th><th>送达用户数</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// 将公告载入编辑表单。
function fillNoticeForm(notice) {
  state.noticeId.value = notice?.id || '';
  state.noticeTitle.value = notice?.title || '';
  state.noticeEnabled.value = notice?.enabled === false ? 'false' : 'true';
  state.noticeContent.value = notice?.content || '';
  state.deleteNoticeButton.disabled = !notice;
  state.noticeMeta.textContent = notice
    ? `记录 ID：${notice.id}\n客户端版本：${notice.clientNoticeId || '-'}\n送达用户数：${formatNumber(notice.deliveredUserCount)}\n状态：${notice.current ? '当前 KV 公告' : '历史公告'}\n更新时间：${notice.updatedAt || '-'}\n项目：${notice.projectName || '-'}`
    : '新增公告，保存后将同步到客户端 KV。';
  if (!state.noticePreviewPanel.hidden) renderNoticePreview();
}

// 清空编辑表单并进入新增状态。
export function resetNoticeForm() {
  state.noticeForm.reset();
  fillNoticeForm(null);
  setNoticeContentMode('edit');
  setNoticeStatus('已清空表单，可新增公告。', 'ok');
}

// 从 D1 加载当前项目的公告历史。
export async function loadNotices(options = {}) {
  try {
    assertReady();
    saveSettings();
    const projectName = getSelectedProjectName();
    const selectedId = options.selectedId ?? state.noticeId.value;
    const data = await requestJson(`/api/notice?projectName=${encodeURIComponent(projectName)}`);
    appState.notices = data.notices || [];
    renderNoticesTable();

    const selected = appState.notices.find((notice) => notice.id === selectedId);
    if (selected) fillNoticeForm(selected);
    else if (selectedId) fillNoticeForm(null);

    if (!options.quiet) setNoticeStatus(`已读取 ${appState.notices.length} 条公告。`, 'ok');
  } catch (error) {
    if (!options.quiet) setNoticeStatus(error?.message || String(error), 'error');
    throw error;
  }
}

// 保存公告到 D1，并将该版本设为客户端 KV 当前公告。
async function saveNotice(event) {
  event.preventDefault();
  setNoticeStatus('');
  try {
    assertReady();
    const title = state.noticeTitle.value.trim();
    const content = state.noticeContent.value.trim();
    if (!title) throw new Error('请先填写公告标题');
    if (!content) throw new Error('请先填写 Markdown 内容');

    state.saveNoticeButton.disabled = true;
    const data = await requestJson('/api/notice', {
      method: 'POST',
      body: {
        id: state.noticeId.value.trim(),
        projectName: getSelectedProjectName(),
        title,
        content,
        enabled: state.noticeEnabled.value !== 'false',
      },
    });
    await loadNotices({ quiet: true, selectedId: data.notice.id });
    setNoticeStatus('公告已保存并同步到 KV，送达用户数已重置为 0。', 'ok');
  } catch (error) {
    setNoticeStatus(error?.message || String(error), 'error');
  } finally {
    state.saveNoticeButton.disabled = false;
  }
}

// 永久删除公告；删除当前版本时同时清空 KV。
async function deleteNotice(id) {
  const notice = appState.notices.find((item) => item.id === id);
  if (!notice || !window.confirm(`确认永久删除公告“${notice.title}”？${notice.current ? '客户端当前公告也会被清空。' : ''}`)) return;

  setNoticeStatus('');
  try {
    const projectName = getSelectedProjectName();
    await requestJson(`/api/notice?projectName=${encodeURIComponent(projectName)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.noticeId.value === id) fillNoticeForm(null);
    await loadNotices({ quiet: true });
    setNoticeStatus('公告已删除。', 'ok');
  } catch (error) {
    setNoticeStatus(error?.message || String(error), 'error');
  }
}

// 绑定公告页面交互事件。
export function bindNoticeEvents() {
  state.loadNoticeButton.addEventListener('click', () => loadNotices().catch(() => undefined));
  state.newNoticeButton.addEventListener('click', resetNoticeForm);
  state.noticeForm.addEventListener('submit', saveNotice);
  state.deleteNoticeButton.addEventListener('click', () => void deleteNotice(state.noticeId.value));
  state.noticeEditorTab.addEventListener('click', () => setNoticeContentMode('edit'));
  state.noticePreviewTab.addEventListener('click', () => setNoticeContentMode('preview'));
  state.noticesTable.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-notice-action]') : null;
    if (!button) return;
    const notice = appState.notices.find((item) => item.id === button.dataset.noticeId);
    if (button.dataset.noticeAction === 'edit') {
      fillNoticeForm(notice || null);
      setNoticeStatus(notice ? '已载入公告，保存后将作为最新版本同步到 KV。' : '未找到公告。', notice ? 'ok' : 'error');
    }
    if (button.dataset.noticeAction === 'delete' && notice) void deleteNotice(notice.id);
  });
}
