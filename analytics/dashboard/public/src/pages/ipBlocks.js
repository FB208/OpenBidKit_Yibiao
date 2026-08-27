import { assertAdminToken, requestJson, saveSettings } from '../api.js';
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
  state.loadIpBlocksButton.addEventListener('click', () => loadIpBlocks().catch((error) => setIpBlockStatus(error?.message || String(error), 'error')));
  state.addIpBlockButton.addEventListener('click', async () => {
    const ip = state.ipBlockInput.value.trim();
    const reason = state.ipBlockReason.value.trim();
    if (!ip) return setIpBlockStatus('请输入 IP 地址。', 'error');
    try {
      assertAdminToken();
      saveSettings();
      await requestJson('/api/ip-blocks', { method: 'POST', body: { ip, reason } });
      state.ipBlockInput.value = '';
      state.ipBlockReason.value = '';
      await loadIpBlocks();
      setIpBlockStatus(`已封禁 ${ip}。`, 'ok');
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
      await requestJson(`/api/ip-blocks?ip=${encodeURIComponent(ip)}`, { method: 'DELETE' });
      await loadIpBlocks();
      setIpBlockStatus(`已解除 ${ip}。`, 'ok');
    } catch (error) {
      setIpBlockStatus(error?.message || String(error), 'error');
    }
  });
}
