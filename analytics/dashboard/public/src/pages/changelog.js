import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { escapeHtml } from '../render.js';
import { appState, state } from '../state.js';

const versionPattern = /^\d+\.\d+\.\d+$/;
const summaryMaxLength = 60;
let markdownRenderer;

function setChangelogStatus(message, type = '') {
  state.changelogStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.changelogStatus.textContent = message || '';
}

// 去掉开头的 v，与 Worker 的版本号规范化保持一致。
function normalizeVersionInput(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

// 取第一行非空文本作为表格摘要，去掉常见 Markdown 行首标记。
function summarizeContent(content) {
  const line = String(content || '')
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '').trim())
    .find(Boolean) || '';
  return line.length > summaryMaxLength ? `${line.slice(0, summaryMaxLength)}…` : line;
}

// 预览与客户端一致：不渲染原始 HTML。
function renderChangelogPreview() {
  markdownRenderer ||= window.markdownit({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  const content = state.changelogContent.value;
  if (!content.trim()) {
    state.changelogPreviewContent.innerHTML = '<div class="notice-preview-empty">暂无可预览内容。</div>';
    return;
  }

  state.changelogPreviewContent.innerHTML = markdownRenderer.render(content);
  for (const link of state.changelogPreviewContent.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
}

// 切换日志正文的编辑和预览面板。
function setChangelogContentMode(mode) {
  const previewing = mode === 'preview';
  if (previewing) renderChangelogPreview();
  state.changelogEditorTab.classList.toggle('active', !previewing);
  state.changelogPreviewTab.classList.toggle('active', previewing);
  state.changelogEditorTab.setAttribute('aria-selected', String(!previewing));
  state.changelogPreviewTab.setAttribute('aria-selected', String(previewing));
  state.changelogEditorPanel.hidden = previewing;
  state.changelogPreviewPanel.hidden = !previewing;
}

// 按版本号筛选后渲染日志列表，列表已由 Worker 按版本号倒序。
function renderChangelogsTable() {
  const changelogs = appState.changelogs || [];
  if (!changelogs.length) {
    state.changelogsTable.innerHTML = '<div class="empty">当前项目暂无更新日志。</div>';
    return;
  }

  const keyword = normalizeVersionInput(state.changelogFilter.value);
  const visible = keyword ? changelogs.filter((changelog) => changelog.version.includes(keyword)) : changelogs;
  if (!visible.length) {
    state.changelogsTable.innerHTML = '<div class="empty">没有匹配的版本。</div>';
    return;
  }

  const rows = visible.map((changelog) => `
    <tr>
      <td><strong>v${escapeHtml(changelog.version)}</strong></td>
      <td class="changelog-summary-cell" title="${escapeHtml(summarizeContent(changelog.content))}">${escapeHtml(summarizeContent(changelog.content) || '-')}</td>
      <td>${escapeHtml(changelog.createdAt || '-')}</td>
      <td>${escapeHtml(changelog.updatedAt || '-')}</td>
      <td class="notice-row-actions">
        <button type="button" class="secondary-button" data-changelog-action="edit" data-changelog-id="${escapeHtml(changelog.id)}">编辑</button>
        <button type="button" class="danger-button" data-changelog-action="delete" data-changelog-id="${escapeHtml(changelog.id)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.changelogsTable.innerHTML = `
    <table class="notice-table">
      <thead><tr><th>版本号</th><th>内容摘要</th><th>发布时间</th><th>最后修改</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// 将日志载入编辑表单。
function fillChangelogForm(changelog) {
  state.changelogId.value = changelog?.id || '';
  state.changelogVersion.value = changelog?.version || '';
  state.changelogContent.value = changelog?.content || '';
  state.deleteChangelogButton.disabled = !changelog;
  state.changelogMeta.textContent = changelog
    ? `记录 ID：${changelog.id}\n发布时间：${changelog.createdAt || '-'}\n最后修改：${changelog.updatedAt || '-'}\n项目：${changelog.projectName || '-'}\n修改不会改变发布时间，客户端不会再次显示红点。`
    : '新增日志，保存后客户端立即可见并显示红点。';
  if (!state.changelogPreviewPanel.hidden) renderChangelogPreview();
}

// 清空编辑表单并进入新增状态。
function resetChangelogForm() {
  state.changelogForm.reset();
  fillChangelogForm(null);
  setChangelogContentMode('edit');
  setChangelogStatus('已清空表单，可新增日志。', 'ok');
}

// 从 D1 加载当前项目的全部更新日志。
export async function loadChangelogs(options = {}) {
  try {
    assertReady();
    saveSettings();
    const projectName = getSelectedProjectName();
    const selectedId = options.selectedId ?? state.changelogId.value;
    const data = await requestJson(`/api/changelogs?projectName=${encodeURIComponent(projectName)}`);
    appState.changelogs = data.changelogs || [];
    renderChangelogsTable();

    const selected = appState.changelogs.find((changelog) => changelog.id === selectedId);
    if (selected) fillChangelogForm(selected);
    else if (selectedId) fillChangelogForm(null);

    if (!options.quiet) setChangelogStatus(`已读取 ${appState.changelogs.length} 条更新日志。`, 'ok');
  } catch (error) {
    if (!options.quiet) setChangelogStatus(error?.message || String(error), 'error');
    throw error;
  }
}

// 保存日志；新增会触发客户端红点，修改保留发布时间。
async function saveChangelog(event) {
  event.preventDefault();
  setChangelogStatus('');
  const id = state.changelogId.value.trim();
  const version = normalizeVersionInput(state.changelogVersion.value);
  try {
    assertReady();
    const content = state.changelogContent.value.trim();
    if (!versionPattern.test(version)) throw new Error('版本号格式应为 x.y.z，例如 2.30.16');
    if (!content) throw new Error('请先填写 Markdown 内容');
    if (appState.changelogs.some((changelog) => changelog.version === version && changelog.id !== id)) {
      throw new Error(`版本号 v${version} 已存在`);
    }

    state.saveChangelogButton.disabled = true;
    const data = await requestJson('/api/changelogs', {
      method: 'POST',
      body: {
        id,
        projectName: getSelectedProjectName(),
        version,
        content,
      },
    });
    await loadChangelogs({ quiet: true, selectedId: data.changelog.id });
    setChangelogStatus(id ? '更新日志已保存，客户端不会再次显示红点。' : '更新日志已发布，客户端将显示红点提醒。', 'ok');
  } catch (error) {
    const message = error?.message || String(error);
    setChangelogStatus(message === 'version already exists' ? `版本号 v${version} 已存在` : message, 'error');
  } finally {
    state.saveChangelogButton.disabled = false;
  }
}

// 永久删除一条更新日志。
async function deleteChangelog(id) {
  const changelog = appState.changelogs.find((item) => item.id === id);
  if (!changelog || !window.confirm(`确认永久删除 v${changelog.version} 的更新日志？`)) return;

  setChangelogStatus('');
  try {
    const projectName = getSelectedProjectName();
    await requestJson(`/api/changelogs?projectName=${encodeURIComponent(projectName)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.changelogId.value === id) fillChangelogForm(null);
    await loadChangelogs({ quiet: true });
    setChangelogStatus('更新日志已删除。', 'ok');
  } catch (error) {
    setChangelogStatus(error?.message || String(error), 'error');
  }
}

// 绑定更新日志页面交互事件。
export function bindChangelogEvents() {
  state.loadChangelogButton.addEventListener('click', () => loadChangelogs().catch(() => undefined));
  state.newChangelogButton.addEventListener('click', resetChangelogForm);
  state.changelogForm.addEventListener('submit', saveChangelog);
  state.deleteChangelogButton.addEventListener('click', () => void deleteChangelog(state.changelogId.value));
  state.changelogEditorTab.addEventListener('click', () => setChangelogContentMode('edit'));
  state.changelogPreviewTab.addEventListener('click', () => setChangelogContentMode('preview'));
  state.changelogFilter.addEventListener('input', renderChangelogsTable);
  state.changelogsTable.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-changelog-action]') : null;
    if (!button) return;
    const changelog = appState.changelogs.find((item) => item.id === button.dataset.changelogId);
    if (button.dataset.changelogAction === 'edit') {
      fillChangelogForm(changelog || null);
      setChangelogStatus(changelog ? `已载入 v${changelog.version}，修改后点击保存。` : '未找到更新日志。', changelog ? 'ok' : 'error');
    }
    if (button.dataset.changelogAction === 'delete' && changelog) void deleteChangelog(changelog.id);
  });
}
