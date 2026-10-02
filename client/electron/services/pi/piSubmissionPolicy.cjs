// 按相邻两轮的阻塞问题及质量剩余量判断进展，每个业务阶段独立维护修复状态。
function createSubmissionPolicy() {
  let previous = null;
  let stalled = 0;
  let repairCount = 0;
  let minimumAttempted = false;

  return {
    get attempts() { return repairCount; },
    inspect(report) {
      const blocking = report.issues.filter(issue => issue.severity === 'blocking');
      if (minimumAttempted) return { action: blocking.length ? 'stop' : 'accept' };
      if (!report.issues.length) return { action: 'accept' };

      const current = {
        blocking: blocking.length,
        remaining: report.progress ?? report.issues.filter(issue => issue.severity === 'quality').length,
      };
      if (previous) {
        const improved = current.blocking < previous.blocking
          || (current.blocking === 0 && previous.blocking === 0 && current.remaining < previous.remaining);
        stalled = improved ? 0 : stalled + 1;
      }
      previous = current;

      if (stalled >= 2 && !blocking.length) return { action: 'accept' };
      const mode = stalled >= 2 ? 'minimum' : stalled === 1 ? 'change-strategy' : 'normal';
      if (mode === 'minimum') minimumAttempted = true;
      repairCount += 1;
      return { action: 'repair', mode, attempt: repairCount };
    },
  };
}

// 业务提示提供文件和工具细节，公共提示统一决定换方法及最后一轮的最低完成目标。
function buildSubmissionRepairPrompt(report, decision, businessPrompt = '') {
  const issues = decision.mode === 'minimum'
    ? report.issues.filter(issue => issue.severity === 'blocking')
    : report.issues;
  const messages = issues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n');
  const instruction = decision.mode === 'minimum'
    ? `连续两次修复未取得进展。现在进行最后一轮最低目标修复。\n最低完成目标：${report.minimumGoal || '解决下列阻塞问题，使当前产物能被后续流程正常读取和使用。'}\n本轮只要求消除上述阻塞问题，暂不要求消除一致性、表格、字数等质量瑕疵；此前业务提示中的质量完成条件本轮不再作为验收条件。完成最低目标后重新提交；如果仍有阻塞问题，任务将停止。`
    : decision.mode === 'change-strategy'
      ? '上一轮修复未取得进展。先核对最新产物并定位原方法未解决问题的原因，再更换具体处理方法；不要重复相同操作。可使用当前可用工具和命令验证新的处理方法，修复后重新提交。'
      : '保留已完成成果，根据当前问题修复后重新提交。';
  return [
    businessPrompt,
    `本轮待修复问题：\n${messages}`,
    `这是本阶段第 ${decision.attempt} 次提交修复。`,
    instruction,
  ].filter(Boolean).join('\n\n');
}

module.exports = { createSubmissionPolicy, buildSubmissionRepairPrompt };
