import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, setNoticeStatus } from '../render.js';
import { appState, state } from '../state.js';

let markdownRenderer;

// 仅接受管理员明确提供的 HTTP(S) 媒体或跳转地址。
function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// 切换记录、类型或面板前停止视频并释放预览资源。
function stopNoticePreview() {
  for (const video of state.noticePreviewContent.querySelectorAll('video')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

// 在既有预览入口展示 Markdown、图片或静音视频，不执行关闭跳转。
function renderNoticePreview() {
  stopNoticePreview();
  if (state.noticeType.value === 'image') {
    const url = state.noticeMediaUrl.value.trim();
    const linkUrl = state.noticeMediaLinkUrl.value.trim();
    state.noticePreviewContent.innerHTML = '';
    if (!isHttpUrl(url)) {
      state.noticePreviewContent.innerHTML = '<div class="notice-preview-empty">请先填写有效的 HTTP(S) 媒体地址。</div>';
      return;
    }
    const video = state.noticeMediaKind.value === 'video';
    const media = document.createElement(video ? 'video' : 'img');
    if (video) {
      media.muted = true;
      media.autoplay = true;
      media.controls = true;
      media.playsInline = true;
    } else {
      media.alt = state.noticeTitle.value;
    }
    media.src = url;
    state.noticePreviewContent.append(media);
    if (isHttpUrl(linkUrl)) {
      const link = document.createElement('a');
      link.href = linkUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      if (video) link.textContent = '查看详情';
      else link.append(media);
      state.noticePreviewContent.append(link);
    }
    return;
  }
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

// 切换公告编辑和预览面板，离开预览即停止播放。
function setNoticeContentMode(mode) {
  const previewing = mode === 'preview';
  if (previewing) renderNoticePreview();
  else stopNoticePreview();
  state.noticeEditorTab.classList.toggle('active', !previewing);
  state.noticePreviewTab.classList.toggle('active', previewing);
  state.noticeEditorTab.setAttribute('aria-selected', String(!previewing));
  state.noticePreviewTab.setAttribute('aria-selected', String(previewing));
  state.noticeEditorPanel.hidden = previewing;
  state.noticePreviewPanel.hidden = !previewing;
}

// 按所选类型显示编辑项，保留尚未保存的另一类输入。
function updateNoticeFields() {
  stopNoticePreview();
  const isMedia = state.noticeType.value === 'image';
  state.noticeContent.hidden = isMedia;
  state.noticeContent.disabled = isMedia;
  state.noticeMediaFields.hidden = !isMedia;
  for (const input of state.noticeMediaFields.querySelectorAll('input, select')) input.disabled = !isMedia;
  state.noticeContentLabel.textContent = isMedia ? '媒体配置' : 'Markdown 内容';
  state.noticeMediaUrlLabel.textContent = state.noticeMediaKind.value === 'video' ? '视频地址' : '图片地址';
  if (!state.noticePreviewPanel.hidden) renderNoticePreview();
}

// 读取并校验媒体表单，文字公告不调用此函数。
function readNoticeMedia() {
  const kind = state.noticeMediaKind.value;
  const url = state.noticeMediaUrl.value.trim();
  const linkUrl = state.noticeMediaLinkUrl.value.trim();
  const delay = state.noticeCloseDelaySeconds.value.trim();
  const closeDelaySeconds = Number(delay);
  const openLinkOnClose = state.noticeOpenLinkOnClose.value === 'true';
  if (!isHttpUrl(url)) throw new Error('请填写有效的 HTTP(S) 图片或视频地址');
  if (linkUrl && !isHttpUrl(linkUrl)) throw new Error('点击跳转链接必须是 HTTP(S) 地址');
  if (!delay || !Number.isSafeInteger(closeDelaySeconds) || closeDelaySeconds < 0) {
    throw new Error('关闭倒计时必须是非负安全整数');
  }
  if (openLinkOnClose && !linkUrl) throw new Error('关闭时强制跳转需要填写点击跳转链接');
  return { kind, url, linkUrl, closeDelaySeconds, openLinkOnClose };
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
        <small>${notice.noticeType === 'image' ? `图片公告${notice.media?.kind === 'video' ? ' · 视频' : ''}` : '文字公告'}</small>
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
  state.noticeType.value = notice?.noticeType || 'text';
  state.noticeMediaKind.value = notice?.media?.kind || 'image';
  state.noticeMediaUrl.value = notice?.media?.url || '';
  state.noticeMediaLinkUrl.value = notice?.media?.linkUrl || '';
  state.noticeCloseDelaySeconds.value = String(notice?.media?.closeDelaySeconds ?? 0);
  state.noticeOpenLinkOnClose.value = String(notice?.media?.openLinkOnClose === true);
  state.deleteNoticeButton.disabled = !notice;
  state.noticeMeta.textContent = notice
    ? `记录 ID：${notice.id}\n客户端版本：${notice.clientNoticeId || '-'}\n送达用户数：${formatNumber(notice.deliveredUserCount)}\n状态：${notice.current ? '当前 KV 公告' : '历史公告'}\n更新时间：${notice.updatedAt || '-'}\n项目：${notice.projectName || '-'}`
    : '新增公告，保存后将同步到客户端 KV。';
  updateNoticeFields();
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
    const noticeType = state.noticeType.value;
    const content = state.noticeContent.value.trim();
    if (!title) throw new Error('请先填写公告标题');
    if (noticeType === 'text' && !content) throw new Error('请先填写 Markdown 内容');
    const media = noticeType === 'image' ? readNoticeMedia() : null;

    state.saveNoticeButton.disabled = true;
    const data = await requestJson('/api/notice', {
      method: 'POST',
      body: {
        id: state.noticeId.value.trim(),
        projectName: getSelectedProjectName(),
        title,
        noticeType,
        media,
        ...(noticeType === 'text' ? { content } : {}),
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
  updateNoticeFields();
  state.noticeType.addEventListener('change', updateNoticeFields);
  state.noticeMediaKind.addEventListener('change', updateNoticeFields);
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
