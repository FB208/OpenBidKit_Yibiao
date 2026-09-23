const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { editContentSections } = require('./contentGenerationEditTools.cjs');

const TABLE_CLEANUP_TOOLS = ['read', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', 'remove-section-tables', 'complete-table-cleanup', 'report-failure'];

// 图片表格属于配图布局，不参与数据表格清理。
function hasDataTables(html) {
  const $ = load(html, null, false);
  return $('table').toArray().some(node => !['imageText', 'threeImages', 'fourImages'].includes($(node).attr('data-yb-preset')));
}

// 同一正文主会话筛选目标并复查，子任务只改变表格的表达形式。
function buildTableCleanupPrompt(state) {
  if (state.status === 'completed') return '去表格已经完成。保留现有 HTML 和结果清单，读取正文生成结果.json并标记 task_complete=true，不再调整字数、审计或修改正文。';
  return `一致性审计已结束，用户选择“不要表格”，现在执行去表格后处理。
完整检查正文编排决策.json中本次 targets 对应的小节 HTML，筛选所有数据表格，包括原方案带入的数据表格。不要处理其他小节或孤儿文件。
调用 remove-section-tables，按小节并发分配转换任务；同一小节中的多个表格交给同一个子任务，不同时编辑同一个文件。
将每个数据表格转换为受限 HTML 段落或列表。转换后的文字应明确表达原表中各项数据与行、列表头的对应关系，并保留表题含义、数值、单位、条件、备注及承诺。仅改变表达形式，不删减信息或进行无关改写。
data-yb-preset 为 imageText、threeImages 或 fourImages 的表格属于图片布局，不参与去表格处理，保留其完整结构和内容；其他图片、图注、提示词和引用也不修改。此阶段允许改变原方案数据表格的表达形式，保留其全部信息，不受之前“保留原表格形式”的要求限制。
等待全部并发任务结束，失败或中断的子任务需要重读文件并重新安排。已完成小节：${JSON.stringify(state.completed_section_ids)}；尚未成功：${JSON.stringify(state.section_ids.filter(id => !state.completed_section_ids.includes(id)))}。
重读修改结果，确认数据表格全部转换且信息完整，然后调用 complete-table-cleanup，并在该调用上标记 task_complete=true。没有数据表格也调用该工具结束。不要重新生成正文、配图、审计或检查字数范围，不自行转换 Word。`;
}

// 复用并发编辑与持久状态，完成时检查遗漏，不把失败小节当作成功。
function createContentGenerationTableTools({ agentService, signal, activity, validateHtml, validateResult, onActivity, tableCleanup }, { Type, workspaceDir }) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  function requireCleanup() {
    const state = tableCleanup.get();
    if (state?.status !== 'running') throw new Error('当前不在去表格阶段');
    if (activity.pending) throw new Error('请等待全部并发任务结束');
    return state;
  }
  return [{
    name: 'remove-section-tables', label: '并发去除数据表格', executionMode: 'sequential',
    description: '将指定小节的全部数据表格转换为普通段落或列表，保留原始信息和所有图片表格。各子任务用 Pi 原生 edit 修改自己的 HTML，失败返回主 Agent 重试。',
    parameters: Type.Object({ sections: Type.Array(Type.Object({ section_id: Type.String(), instructions: Type.String() }), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      const state = requireCleanup();
      const ids = params.sections.map(job => job.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能处理本次目标小节，一批不能重复提交同一小节');
      tableCleanup.save({ ...state, section_ids: [...new Set([...state.section_ids, ...ids])], completed_section_ids: state.completed_section_ids.filter(id => !ids.includes(id)) });
      const results = await editContentSections({
        jobs: params.sections, targets, workspaceDir, agentService, signal, toolSignal, activity, onActivity,
        title: '正文去表格', preserveDataTables: false,
        instructions: '把本节全部数据表格转换为受限 HTML 段落或列表，包括原方案表格。转换后的文字应明确表达各项数据与行、列表头的对应关系，保留表题含义、数值、单位、条件、备注及承诺。data-yb-preset 为 imageText、threeImages 或 fourImages 的图片表格保留完整结构和内容。仅改变表达形式，不删减信息、不作无关改写、不调整总字数。若重试时数据表格已经全部转换，核实信息完整后可在 read 上标记完成。',
        validateHtml(root, html) {
          validateHtml(root, html);
          if (hasDataTables(html)) throw new Error('本节仍有数据表格，请继续转换；图片表格应保留');
        },
        onResult(item) {
          if (item.status !== 'success') return;
          const current = tableCleanup.get();
          tableCleanup.save({ ...current, completed_section_ids: [...new Set([...current.completed_section_ids, item.section_id])] });
        },
      });
      return result({ results });
    },
  }, {
    name: 'complete-table-cleanup', label: '完成去表格检查', executionMode: 'sequential',
    description: '全部转换完成并核实信息保留后调用。检查本次目标中是否遗漏数据表格，不调整字数；图片表格允许保留。',
    parameters: Type.Object({}),
    async execute() {
      const state = requireCleanup();
      const pending = state.section_ids.filter(id => !state.completed_section_ids.includes(id));
      if (pending.length) throw new Error(`以下小节尚未成功，请重新安排：${pending.join('、')}`);
      const remaining = decisions.targets.filter(section => hasDataTables(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8')));
      if (remaining.length) throw new Error(`以下小节仍有数据表格：${remaining.map(section => section.id).join('、')}`);
      validateResult();
      const next = { ...state, status: 'completed' };
      tableCleanup.save(next);
      return result(next);
    },
  }];
}

module.exports = { TABLE_CLEANUP_TOOLS, hasDataTables, buildTableCleanupPrompt, createContentGenerationTableTools };
