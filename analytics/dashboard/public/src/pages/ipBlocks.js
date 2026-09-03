import { assertAdminToken, assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { escapeHtml } from '../render.js';
import { state } from '../state.js';

// 显示 IP 封禁页面操作结果。
function setIpBlockStatus(message, type = '') {
  state.ipBlockStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.ipBlockStatus.textContent = message || '';
}

// 渲染当前全局封禁列表。
function renderIpBlocks(items) {
  if (!items.length) {
    state.ipBlockTable.innerHTML = '<div class="empty">当前没有封禁 IP。</div>';
    return;
  }
  const rows = items.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.ip)}</strong></td>
      <td>${escapeHtml(item.reason || '未填写')}</td>
      <td>${escapeHtml(item.createdAt || '-')}</td>
      <td><button type="button" class="danger-button" data-ip-block-delete="${escapeHtml(item.ip)}">解除封禁</button></td>
    </tr>
  `).join('');
  state.ipBlockTable.innerHTML = `
    <table>
      <thead><tr><th>IP 地址</th><th>封禁原因</th><th>封禁时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// 从 Worker 读取全局封禁列表。
export async function loadIpBlocks() {
  assertAdminToken();
  saveSettings();
  const data = await requestJson('/api/ip-blocks');
  renderIpBlocks(Array.isArray(data.blockedIps) ? data.blockedIps : []);
  setIpBlockStatus('封禁列表已读取。', 'ok');
}

// 绑定添加和解除封禁操作。
export function setupIpBlocksPage() {
  state.loadIpBlocksButton.addEventListener('click', () => {
    loadIpBlocks().catch((error) => setIpBlockStatus(error?.message || String(error), 'error'));
    loadVersionBlocksSafely();
  });
  state.addIpBlockButton.addEventListener('click', async () => {
    const ip = state.ipBlockInput.value.trim();
    const reason = state.ipBlockReason.value.trim();
    const projectName = state.projectName.value.trim();
    if (!ip) return setIpBlockStatus('请输入 IP 地址。', 'error');
    if (!projectName) return setIpBlockStatus('请先输入项目名。', 'error');
    if (!window.confirm(`确认封禁 IP「${ip}」并删除当前项目中对应的客户端明细吗？`)) return;
    try {
      assertAdminToken();
      saveSettings();
      const data = await requestJson('/api/ip-blocks', {
        method: 'POST',
        body: { ip, reason, projectName },
      });
      state.ipBlockInput.value = '';
      state.ipBlockReason.value = '';
      await loadIpBlocks();
      setIpBlockStatus(`已封禁 ${ip}，删除 ${data.deletedClientCount || 0} 条客户端明细。`, 'ok');
    } catch (error) {
      setIpBlockStatus(error?.message || String(error), 'error');
    }
  });
  state.ipBlockInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') state.addIpBlockButton.click();
  });
  state.ipBlockTable.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ip-block-delete]');
    if (!button) return;
    const ip = button.dataset.ipBlockDelete;
    try {
      const data = await requestJson(`/api/ip-blocks?ip=${encodeURIComponent(ip)}`, { method: 'DELETE' });
      await loadIpBlocks();
      setIpBlockStatus(`已解除 ${ip}，释放 ${data.releasedClientCount || 0} 个客户端标记。`, 'ok');
    } catch (error) {
      setIpBlockStatus(error?.message || String(error), 'error');
    }
  });

  setupVersionBlocksPage();
}

// 显示版本号封禁页面操作结果。
function setVersionBlockStatus(message, type = '') {
  state.versionBlockStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.versionBlockStatus.textContent = message || '';
}

// 渲染当前项目的版本号封禁标签列表。
function renderVersionBlocks(items) {
  if (!items.length) {
    state.versionBlockTags.innerHTML = '<span class="agent-error-version-empty">当前项目没有封禁版本号。</span>';
    return;
  }
  state.versionBlockTags.innerHTML = items.map((item) => {
    const label = item.version === '' ? '（空版本号）' : item.version;
    return `
      <span class="agent-error-version-chip" title="${escapeHtml(item.reason || '未填写')} · ${escapeHtml(item.createdAt || '-')}">
        <code>${escapeHtml(label)}</code>
        <button type="button" data-version-block-delete="${escapeHtml(item.version)}" aria-label="移除版本 ${escapeHtml(label)}">×</button>
      </span>
    `;
  }).join('');
}

// 从 Worker 读取当前项目的版本号封禁列表。
export async function loadVersionBlocks() {
  assertReady();
  saveSettings();
  const projectName = getSelectedProjectName();
  const data = await requestJson(`/api/version-blocks?projectName=${encodeURIComponent(projectName)}`);
  renderVersionBlocks(Array.isArray(data.versionBlocks) ? data.versionBlocks : []);
}

// 加载版本号封禁列表；失败时把错误显示在版本封禁区域自身，不向上抛出，
// 避免和 IP 封禁一起并发加载时，这里的失败连累整个 tab 被判定为加载失败。
export async function loadVersionBlocksSafely() {
  try {
    await loadVersionBlocks();
  } catch (error) {
    setVersionBlockStatus(error?.message || String(error), 'error');
  }
}

// 提交一次版本号封禁请求（version 可为空字符串，代表封禁空版本号）。
async function submitVersionBlock(version) {
  assertReady();
  saveSettings();
  const projectName = getSelectedProjectName();
  const reason = state.versionBlockReason.value.trim();
  const data = await requestJson('/api/version-blocks', {
    method: 'POST',
    body: { projectName, version, reason },
  });
  await loadVersionBlocks();
  const label = version === '' ? '空版本号' : version;
  setVersionBlockStatus(`已封禁「${label}」，删除 ${data.deletedClientCount || 0} 条当天客户端明细。`, 'ok');
}

// 绑定版本号封禁相关操作。
function setupVersionBlocksPage() {
  state.addVersionBlockButton.addEventListener('click', async () => {
    const version = state.versionBlockInput.value.trim();
    if (!version) return setVersionBlockStatus('请输入版本号；封禁空版本号请使用下方的复选框。', 'error');
    try {
      await submitVersionBlock(version);
      state.versionBlockInput.value = '';
    } catch (error) {
      setVersionBlockStatus(error?.message || String(error), 'error');
    }
  });
  state.versionBlockInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') state.addVersionBlockButton.click();
  });
  state.versionBlockEmptyCheckbox.addEventListener('change', async (event) => {
    if (!event.target.checked) return;
    if (!window.confirm('确认封禁空版本号（未上报版本号的埋点）吗？')) {
      event.target.checked = false;
      return;
    }
    try {
      await submitVersionBlock('');
    } catch (error) {
      setVersionBlockStatus(error?.message || String(error), 'error');
    } finally {
      event.target.checked = false;
    }
  });
  state.versionBlockTags.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-version-block-delete]');
    if (!button) return;
    const version = button.dataset.versionBlockDelete;
    try {
      assertReady();
      const projectName = getSelectedProjectName();
      const data = await requestJson(`/api/version-blocks?projectName=${encodeURIComponent(projectName)}&version=${encodeURIComponent(version)}`, { method: 'DELETE' });
      await loadVersionBlocks();
      const label = version === '' ? '空版本号' : version;
      setVersionBlockStatus(`已解除「${label}」的封禁，释放 ${data.releasedClientCount || 0} 个客户端标记。`, 'ok');
    } catch (error) {
      setVersionBlockStatus(error?.message || String(error), 'error');
    }
  });
}
