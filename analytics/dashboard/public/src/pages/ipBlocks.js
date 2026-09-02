import { assertAdminToken, requestJson, saveSettings } from '../api.js';
import { escapeHtml } from '../render.js';
import { state } from '../state.js';

// 显示封禁规则页面操作结果。
function setBlockRuleStatus(message, type = '') {
  state.blockRuleStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.blockRuleStatus.textContent = message || '';
}

function cleanupText(item) {
  if (item.cleanupStatus === 'success') return item.cleanedUntil ? `已清理至 ${item.cleanedUntil}` : '无需清理';
  if (item.cleanupStatus === 'running') return '清理中';
  if (item.cleanupStatus === 'stats_applied') return `统计已清理，资源待重算${item.cleanupError ? `：${item.cleanupError}` : ''}`;
  if (item.cleanupStatus === 'failed') return `清理失败：${item.cleanupError || '可重试'}`;
  return '待清理';
}

// 渲染当前项目可管理的 IP 与版本规则。
function renderBlockRules(items) {
  if (!items.length) {
    state.blockRuleTable.innerHTML = '<div class="empty">当前没有封禁规则。</div>';
    return;
  }
  const rows = items.map((item) => `
    <tr>
      <td>${item.type === 'ip' ? 'IP' : '版本号'}</td>
      <td><strong>${escapeHtml(item.value)}</strong></td>
      <td>${item.type === 'ip' ? '全局拦截 / 当前项目清理' : escapeHtml(item.projectName || '-')}</td>
      <td>${escapeHtml(item.reason || '未填写')}</td>
      <td>${escapeHtml(item.createdAt || '-')}</td>
      <td>${escapeHtml(cleanupText(item))}</td>
      <td>
        ${item.cleanupStatus !== 'success' ? `<button type="button" class="secondary-button" data-block-rule-retry="${escapeHtml(item.value)}" data-block-rule-type="${item.type}" data-block-rule-reason="${escapeHtml(item.reason || '')}">重试清理</button>` : ''}
        <button type="button" class="danger-button" data-block-rule-delete="${escapeHtml(item.value)}" data-block-rule-type="${item.type}" ${item.cleanupStatus === 'success' ? '' : 'disabled title="历史清理完成后才能解除规则"'}>解除规则</button>
      </td>
    </tr>
  `).join('');
  state.blockRuleTable.innerHTML = `
    <table>
      <thead><tr><th>类型</th><th>规则值</th><th>作用范围</th><th>原因</th><th>创建时间</th><th>清理进度</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// 从 Worker 读取当前项目的统一封禁规则。
export async function loadBlockRules() {
  assertAdminToken();
  saveSettings();
  const projectName = state.projectName.value.trim();
  if (!projectName) throw new Error('请先输入项目名');
  const data = await requestJson(`/api/block-rules?projectName=${encodeURIComponent(projectName)}`);
  renderBlockRules(Array.isArray(data.rules) ? data.rules : []);
  setBlockRuleStatus('规则列表已读取。', 'ok');
}

function updateRuleInput() {
  const isIp = state.blockRuleType.value === 'ip';
  state.blockRuleValue.placeholder = isIp ? '例如：124.193.61.30' : '例如：web';
  state.blockRuleValue.maxLength = isIp ? 80 : 50;
  state.blockRuleScope.textContent = isIp
    ? '作用范围：全局拦截；历史清理按当前项目执行。'
    : '作用范围：仅当前项目；版本号大小写敏感并且精确匹配。';
}

// 提交规则；重复提交同一规则即重试未完成的历史清理。
async function submitBlockRule(type, value, reason) {
  const projectName = state.projectName.value.trim();
  const data = await requestJson('/api/block-rules', {
    method: 'POST',
    body: { type, value, projectName, reason },
  });
  await loadBlockRules();
  if (data.cleanup?.status === 'failed') {
    setBlockRuleStatus(`规则已生效，但历史清理失败：${data.cleanup.error || '请重试'}`, 'error');
  } else {
    setBlockRuleStatus(`规则已生效，历史统计已清理至 ${data.cleanup?.cleanedUntil || '当前汇总进度'}。`, 'ok');
  }
}

// 绑定添加、重试清理和解除规则操作。
export function setupBlockRulesPage() {
  state.loadBlockRulesButton.addEventListener('click', () => loadBlockRules().catch((error) => setBlockRuleStatus(error?.message || String(error), 'error')));
  state.blockRuleType.addEventListener('change', updateRuleInput);
  state.addBlockRuleButton.addEventListener('click', async () => {
    const type = state.blockRuleType.value;
    const value = state.blockRuleValue.value.trim();
    const reason = state.blockRuleReason.value.trim();
    const projectName = state.projectName.value.trim();
    if (!value) return setBlockRuleStatus('请输入规则值。', 'error');
    if (!projectName) return setBlockRuleStatus('请先输入项目名。', 'error');
    if (type === 'version' && value === '-') return setBlockRuleStatus('“-”是页面占位符，不能作为版本规则。', 'error');
    if (!window.confirm(`确认添加${type === 'ip' ? '全局 IP' : '当前项目版本号'}规则「${value}」并清理可恢复的历史统计吗？`)) return;
    try {
      assertAdminToken();
      saveSettings();
      await submitBlockRule(type, value, reason);
      state.blockRuleValue.value = '';
      state.blockRuleReason.value = '';
    } catch (error) {
      setBlockRuleStatus(error?.message || String(error), 'error');
    }
  });
  state.blockRuleValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') state.addBlockRuleButton.click();
  });
  state.blockRuleTable.addEventListener('click', async (event) => {
    const retryButton = event.target.closest('[data-block-rule-retry]');
    if (retryButton) {
      try {
        setBlockRuleStatus('正在重试历史清理…');
        await submitBlockRule(retryButton.dataset.blockRuleType, retryButton.dataset.blockRuleRetry, retryButton.dataset.blockRuleReason || '');
      } catch (error) {
        setBlockRuleStatus(error?.message || String(error), 'error');
      }
      return;
    }
    const button = event.target.closest('[data-block-rule-delete]');
    if (!button) return;
    const value = button.dataset.blockRuleDelete;
    const type = button.dataset.blockRuleType;
    if (!window.confirm(`确认解除规则「${value}」吗？解除前的历史事件仍会保持排除。`)) return;
    try {
      const projectName = state.projectName.value.trim();
      await requestJson(`/api/block-rules?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}&projectName=${encodeURIComponent(projectName)}`, { method: 'DELETE' });
      await loadBlockRules();
      setBlockRuleStatus(`已解除规则 ${value}；之后的新事件将恢复统计。`, 'ok');
    } catch (error) {
      setBlockRuleStatus(error?.message || String(error), 'error');
    }
  });
  updateRuleInput();
}
