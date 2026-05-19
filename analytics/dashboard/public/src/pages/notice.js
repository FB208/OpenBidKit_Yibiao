import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { setNoticeStatus } from '../render.js';
import { state } from '../state.js';

function renderNoticeMeta(notice) {
  if (!notice) {
    state.noticeMeta.textContent = '当前项目暂无公告。';
    return;
  }

  const enabledText = notice.enabled === false ? '停用' : '启用';
  state.noticeMeta.textContent = `公告 ID：${notice.id || '-'}\n状态：${enabledText}\n公告时间：${notice.updatedAt || '-'}\n项目：${notice.projectName || '-'}`;
}

function fillNoticeForm(notice) {
  state.noticeTitle.value = notice?.title || '';
  state.noticeEnabled.value = notice?.enabled === false ? 'false' : 'true';
  state.noticeContent.value = notice?.content || '';
  renderNoticeMeta(notice);
}

export async function loadNotice(options = {}) {
  try {
    assertReady();
    saveSettings();

    const projectName = getSelectedProjectName();
    const data = await requestJson(`/api/notice?projectName=${encodeURIComponent(projectName)}`);
    fillNoticeForm(data.notice || null);
    if (!options.quiet) {
      setNoticeStatus(data.notice ? '公告已读取。' : '当前项目暂无公告。', 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setNoticeStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

export async function publishNotice() {
  setNoticeStatus('');
  try {
    assertReady();
    const projectName = getSelectedProjectName();
    const title = state.noticeTitle.value.trim();
    const content = state.noticeContent.value.trim();
    if (!title) {
      throw new Error('请先填写公告标题');
    }
    if (!content) {
      throw new Error('请先填写 Markdown 内容');
    }

    state.publishNoticeButton.disabled = true;
    const data = await requestJson('/api/notice', {
      method: 'POST',
      body: {
        projectName,
        title,
        content,
        enabled: state.noticeEnabled.value !== 'false',
      },
    });
    fillNoticeForm(data.notice || null);
    setNoticeStatus('公告已发布。客户端会在下一次轮询时拉取新公告。', 'ok');
  } catch (error) {
    setNoticeStatus(error?.message || String(error), 'error');
  } finally {
    state.publishNoticeButton.disabled = false;
  }
}

export async function disableNotice() {
  setNoticeStatus('');
  try {
    assertReady();
    const projectName = getSelectedProjectName();

    state.disableNoticeButton.disabled = true;
    await requestJson(`/api/notice?projectName=${encodeURIComponent(projectName)}`, { method: 'DELETE' });
    fillNoticeForm(null);
    setNoticeStatus('公告已停用。客户端后续不会再拉取到该公告。', 'ok');
  } catch (error) {
    setNoticeStatus(error?.message || String(error), 'error');
  } finally {
    state.disableNoticeButton.disabled = false;
  }
}
