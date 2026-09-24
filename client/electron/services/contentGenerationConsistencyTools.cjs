const fs = require('node:fs');
const path = require('node:path');
const { numberMarkdownLines } = require('../utils/markdownLineView.cjs');
const { editContentSections } = require('./contentGenerationEditTools.cjs');

const CONSISTENCY_TOOLS = ['read', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', 'repair-sections', 'complete-consistency-round', 'report-failure'];
const CONSISTENCY_INPUT_FILE = '正文一致性检查汇总.txt';

// 按目录中的目标顺序汇总最新 HTML，只增加导航和行号，不改动原小节文件。
function refreshConsistencyInput(workspaceDir) {
  const { targets } = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const sections = targets.map(section => {
    const html = fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
    return `小节：${section.number} ${section.title}\n小节 ID：${section.id}\n原文件：${section.file}\n${numberMarkdownLines(html)}`;
  });
  fs.writeFileSync(path.join(workspaceDir, CONSISTENCY_INPUT_FILE),
    `本轮目标小节完整 HTML，只供审计阅读。行号对应各自原文件；同一行的 [序号/总数] 是连续展示片段。修复请编辑原文件，修复后的核实以最新原文件为准。\n\n${sections.join('\n\n')}\n`, 'utf8');
}

// 每轮审计继续使用正文主会话，只读取本次 targets，修复后不再调整字数。
function buildConsistencyPrompt(state, hasKnowledgeBase, hasOriginalPlan) {
  if (state.status === 'completed') return '一致性审计已经结束。保留现有正文及结果清单，读取正文生成结果.json并标记 task_complete=true；不要重新生成、调整字数或开始新一轮审计。';
  return `正文与图片生成、总字数调整已完成，现在执行第 ${state.round}/3 轮一致性审计及修复。
主 Agent 负责审计判断。首先阅读程序准备的《${CONSISTENCY_INPUT_FILE}》，其中包含本轮目标小节的完整 HTML 及原文件位置。按需分段读完，读取方式由你自行安排。修复时修改对应原小节文件；修复后的核实以最新原文件为准，汇总文件不用于编辑。检查正文与项目概述、全局事实设定${hasOriginalPlan ? '、已还原材料' : ''}是否冲突，同时检查小节内部及目标小节之间的事实、参数、时间、职责、范围和承诺是否存在矛盾。检查并修复没有实际依据的引用。禁止生成没有实际依据的引用。审计结论仅覆盖本次目标，不将局部检查表述为全文审计通过。${hasKnowledgeBase ? '知识库按需检索核实来源。' : ''}
完整阅读全局事实设定，冲突以全局事实设定为准，并阅读编排决策中的 global_facts_requirements（当前事实模式的中文要求）。审计阶段只修复本次审计发现的问题，依据全局事实和已有材料确定统一值。生成阶段允许补充设定，不代表审计阶段可以通过新增无依据的值消除冲突；缺少确定依据的问题应保留在未解决问题清单中，不将【待填写】替换为猜测值。判断矛盾前，核对相关表述的对象、适用条件和时间范围。因对象、条件或阶段不同而产生的合理差异不属于矛盾；仅修复本次审计确认的问题，不进行与审计无关的润色。上一轮尚未解决的问题：${JSON.stringify(state.remaining_issues || [])}。
调用 repair-sections 前，主 Agent 应明确问题及其依据、受影响小节和统一修改结论。各子任务的指令须包含相关证据、需要修改的位置及统一结论，子任务按该结论修复，不独立选择另一套事实口径。小范围修改也可直接用原生 edit。子任务失败必须重新安排修复，不能当作完成。等待全部子任务结束后，重读修改位置与关联小节，确认修复结果及已知问题是否消除。
已插入的图片块、图注、提示词、引用、顺序和图片表格布局受写入前保护；普通文字可改，原表格和实质信息应保留，仅修复本次审计确认的问题。不要生成或替换图片，不使用命令或脚本绕过 edit。
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
        title: '一致性修复', preloadInput: true, instructions: '只修复主 Agent 指定的问题，遵循其修改结论、统一事实口径与证据，不作无关改写，不检查或调整总字数。',
      });
      for (const item of results) if (item.status === 'success') failed.delete(item.section_id);
      consistency.save({ ...state, failed_sections: [...failed] });
      return result({ results });
    },
  }, {
    name: 'complete-consistency-round', label: '提交本轮一致性审计结论', executionMode: 'sequential',
    description: '全部修复完成并核实后提交本轮结论。remaining_issues 为空表示本次目标内无已知未解决问题；有问题则列出小节、证据及原因，最多三轮。',
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

module.exports = { CONSISTENCY_TOOLS, refreshConsistencyInput, buildConsistencyPrompt, createContentGenerationConsistencyTools };
