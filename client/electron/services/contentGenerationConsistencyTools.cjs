const fs = require('node:fs');
const path = require('node:path');
const { editContentSections } = require('./contentGenerationEditTools.cjs');

const CONSISTENCY_TOOLS = ['read', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', 'repair-sections', 'complete-consistency-round', 'report-failure'];

// 每轮审计继续使用正文主会话，只读取本次 targets，修复后不再调整字数。
function buildConsistencyPrompt(state, hasKnowledgeBase, hasOriginalPlan) {
  if (state.status === 'completed') return '一致性审计已经结束。保留现有正文及结果清单，读取正文生成结果.json并标记 task_complete=true；不要重新生成、调整字数或开始新一轮审计。';
  return `正文与图片生成、总字数调整已完成，现在执行第 ${state.round}/3 轮一致性审计及修复。
由你亲自审计：完整阅读正文编排决策.json中 targets 对应的全部小节 HTML，检查正文与项目概述、全局事实设定${hasOriginalPlan ? '、已还原材料' : ''}是否冲突，同时比较各小节之间及小节内部的事实、参数、时间、职责、范围和承诺，发现 AI 正文自身的前后矛盾。只审计本次 targets；局部生成不能宣称已审计未提供的全文。${hasKnowledgeBase ? '知识库按需检索核实来源。' : ''}
完整阅读全局事实设定，冲突以全局事实设定为准；没有确定依据时不要编造事实，记录尚未解决的问题。遵守编排决策中的 global_facts_mode，不将【待填写】替换为猜测值。正常场景差异不是矛盾，不做无关润色。上一轮尚未解决的问题：${JSON.stringify(state.remaining_issues || [])}。
你统一确定每个冲突的证据、受影响小节和修复口径，再调用 repair-sections 并发修复不同小节；给子任务提供准确的来源、相关原文和修改要求，避免各自猜测统一口径。小范围修改也可直接用原生 edit。子任务失败必须重新安排修复，不能当作完成。等待全部子任务结束后，重读修改位置与关联小节，确认修复结果及已知矛盾是否消除。
已插入的图片块、图注、提示词、引用、顺序和图片表格布局受写入前保护；普通文字可改，原表格和实质信息应保留，仅修正有依据的冲突。不要生成或替换图片，不使用命令或脚本绕过 edit。
本轮无问题可立即结束；否则完成本轮修复及核实后，调用 complete-consistency-round，提交本轮结论和仍未解决的问题。最多三轮，第三轮后保留未解决问题说明，不再开展第四轮。完成标记放在该工具调用上；程序会决定结束或继续下一轮。若本轮结论已经提交，不重复修复，读取结果清单并标记完成即可。
审计及修复之后不再检查总字数范围、不调用扩缩写，不为满足字数删改内容。正文直接留在原小节 HTML 文件中，不输出合并 Markdown 或补丁，不修改输入资料、其他小节或业务数据库。`;
}

// 主 Agent 提交审计结论；轮次和子任务失败随持久会话保存。
function createContentGenerationConsistencyTools({ agentService, signal, activity, validateHtml, validateResult, onActivity, consistency }, { Type, workspaceDir }) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  function requireRound() {
    const state = consistency.get();
    if (!state || state.status !== 'running') throw new Error('当前不在可编辑的一致性审计轮次中');
    if (activity.pending) throw new Error('请等待全部并发任务结束');
    return state;
  }
  return [{
    name: 'repair-sections', label: '并发修复一致性问题', executionMode: 'sequential',
    description: '主 Agent 审计并确定统一修复口径后，分配不同小节并发修复。各子任务原生 edit 自己的小节，保留图片，不检查或调整字数。失败返回主 Agent 重试。',
    parameters: Type.Object({ sections: Type.Array(Type.Object({ section_id: Type.String(), instructions: Type.String() }), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      const state = requireRound();
      // 先登记待完成项，取消或中断恢复后仍需处理，不能直接提交本轮成功。
      const failed = new Set([...(state.failed_sections || []), ...params.sections.map(job => job.section_id)]);
      const ids = params.sections.map(job => job.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能修复本次目标小节，一批不能重复提交同一小节');
      consistency.save({ ...state, failed_sections: [...failed] });
      const results = await editContentSections({ jobs: params.sections, targets, workspaceDir, agentService, signal, toolSignal, activity, validateHtml, onActivity,
        title: '一致性修复', instructions: '只修复主 Agent 指定的矛盾，遵循其统一事实口径与证据，不作无关改写，不检查或调整总字数。',
      });
      for (const item of results) if (item.status === 'success') failed.delete(item.section_id);
      consistency.save({ ...state, failed_sections: [...failed] });
      return result({ results });
    },
  }, {
    name: 'complete-consistency-round', label: '提交本轮一致性审计结论', executionMode: 'sequential',
    description: '全部修复完成并核实后提交本轮结论。remaining_issues 为空表示本次目标内无已知未解决矛盾；有问题则列出小节、证据及原因，最多三轮。',
    parameters: Type.Object({ summary: Type.String(), remaining_issues: Type.Array(Type.String()) }),
    async execute(_callId, params) {
      const state = requireRound();
      if (state.failed_sections?.length) throw new Error(`以下修复任务未成功，请先重新安排：${state.failed_sections.join('、')}`);
      validateResult();
      const next = { ...state, summary: params.summary, remaining_issues: params.remaining_issues, status: 'round-completed' };
      consistency.save(next);
      return result(next);
    },
  }];
}

module.exports = { CONSISTENCY_TOOLS, buildConsistencyPrompt, createContentGenerationConsistencyTools };
