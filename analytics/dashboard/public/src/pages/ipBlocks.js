import { assertAdminToken, requestJson, saveSettings } from '../api.js';
import { escapeHtml } from '../render.js';
import { state } from '../state.js';

// 显示封禁规则页面操作结果。
function setBlockRuleStatus(message, type = '') {
  state.blockRuleStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.blockRuleStatus.textContent = message || '';
}

// 将底层空字符串规则显示为明确的空版本标签。
function ruleValueText(type, value) {
  return type === 'version' && value === '' ? '空版本' : value;
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
      <td><strong>${escapeHtml(ruleValueText(item.type, item.value))}</strong></td>
      <td>${item.type === 'ip' ? '全局 / 添加当天起' : `${escapeHtml(item.projectName || '-')} / 添加当天起`}</td>
      <td>${escapeHtml(item.reason || '未填写')}</td>
      <td>${escapeHtml(item.createdAt || '-')}</td>
      <td>
        <button type="button" class="danger-button" data-block-rule-delete="${escapeHtml(item.value)}" data-block-rule-type="${item.type}">解除规则</button>
      </td>
    </tr>
  `).join('');
  state.blockRuleTable.innerHTML = `
    <table>
      <thead><tr><th>类型</th><th>规则值</th><th>作用范围</th><th>原因</th><th>创建时间</th><th>操作</th></tr></thead>
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
  const selectedType = state.blockRuleType.value;
  const isIp = selectedType === 'ip';
  const isEmptyVersion = selectedType === 'empty-version';
  state.blockRuleValue.disabled = isEmptyVersion;
  if (isEmptyVersion) state.blockRuleValue.value = '';
  state.blockRuleValue.placeholder = isIp ? '例如：124.193.61.30' : isEmptyVersion ? '无需填写' : '例如：web';
  state.blockRuleValue.maxLength = isIp ? 80 : 50;
  state.blockRuleScope.textContent = isIp
    ? '作用范围：全局拦截；清理当天实时写入的异常客户端，不修改历史汇总。'
    : isEmptyVersion
      ? '作用范围：仅当前项目；从添加当天起匹配原始版本值为空的埋点。'
      : '作用范围：仅当前项目；从添加当天起按大小写精确匹配版本号。';
}

// 提交规则，并清理当天实时写入的异常客户端。
async function submitBlockRule(type, value, reason) {
  const projectName = state.projectName.value.trim();
  const data = await requestJson('/api/block-rules', {
    method: 'POST',
    body: { type, value, projectName, reason },
  });
  await loadBlockRules();
  if (data.cleanup?.status === 'failed') {
    setBlockRuleStatus(`规则已生效，但当天实时客户端清理失败：${data.cleanup.error || '可重复添加规则重试'}`, 'error');
  } else {
    setBlockRuleStatus(`规则已生效；已清理当天实时客户端 ${data.cleanup?.removedClients || 0} 个，历史汇总未改动。`, 'ok');
  }
}

// 绑定添加和解除规则操作。
export function setupBlockRulesPage() {
  state.loadBlockRulesButton.addEventListener('click', () => loadBlockRules().catch((error) => setBlockRuleStatus(error?.message || String(error), 'error')));
  state.blockRuleType.addEventListener('change', updateRuleInput);
  state.addBlockRuleButton.addEventListener('click', async () => {
    const selectedType = state.blockRuleType.value;
    const isEmptyVersion = selectedType === 'empty-version';
    const type = isEmptyVersion ? 'version' : selectedType;
    const value = isEmptyVersion ? '' : state.blockRuleValue.value.trim();
    const valueText = ruleValueText(type, value);
    const reason = state.blockRuleReason.value.trim();
    const projectName = state.projectName.value.trim();
    if (!isEmptyVersion && !value) return setBlockRuleStatus('请输入规则值。', 'error');
    if (!projectName) return setBlockRuleStatus('请先输入项目名。', 'error');
    if (type === 'version' && value === '-') return setBlockRuleStatus('“-”是页面占位符，不能作为版本规则。', 'error');
    if (!window.confirm(`确认添加${type === 'ip' ? '全局 IP' : '当前项目版本号'}规则「${valueText}」并过滤今天及之后的埋点吗？历史汇总不会改动。`)) return;
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
    const button = event.target.closest('[data-block-rule-delete]');
    if (!button) return;
    const value = button.dataset.blockRuleDelete;
    const type = button.dataset.blockRuleType;
    const valueText = ruleValueText(type, value);
    if (!window.confirm(`确认解除规则「${valueText}」吗？Analytics Engine 保留期内的匹配事件会重新显示并可能参与后续汇总。`)) return;
    try {
      const projectName = state.projectName.value.trim();
      await requestJson(`/api/block-rules?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}&projectName=${encodeURIComponent(projectName)}`, { method: 'DELETE' });
      await loadBlockRules();
      setBlockRuleStatus(`已解除规则 ${valueText}；之后的新事件将恢复统计。`, 'ok');
    } catch (error) {
      setBlockRuleStatus(error?.message || String(error), 'error');
    }
  });
  updateRuleInput();
}
