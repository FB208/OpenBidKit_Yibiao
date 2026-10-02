const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const path = require('node:path');
const { load } = require('cheerio');
const { SUBMISSION_FIX_TOOL, editContentSections, batchResponse } = require('./contentGenerationEditTools.cjs');
const { TASK_FILE_WRITING, taskFilePath, readTaskFile } = require('./contentGenerationTaskFiles.cjs');

const TABLE_CLEANUP_TOOLS = [...NATIVE_AGENT_TOOLS, 'json-validation', 'ask-user', 'remove-section-tables', 'complete-table-cleanup', SUBMISSION_FIX_TOOL, 'report-failure'];

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
将需要转换的小节写入 ${taskFilePath('tables')}，格式为 {"sections":[{"section_id":"小节 ID","instructions":"本节表格的补充说明，没有时填空字符串"}]}，再调用 remove-section-tables，程序按小节并发分配转换任务；同一小节中的多个表格交给同一个子任务，不同时编辑同一个文件。${TASK_FILE_WRITING}
将每个数据表格转换为受限 HTML 段落或列表。转换后的文字应明确表达原表中各项数据与行、列表头的对应关系，并保留表题含义、数值、单位、条件、备注及承诺。仅改变表达形式，不删减信息或进行无关改写。
data-yb-preset 为 imageText、threeImages 或 fourImages 的表格属于图片布局，不参与去表格处理，保留其完整结构和内容；其他图片、图注、提示词和引用也不修改。此阶段允许改变原方案数据表格的表达形式，保留其全部信息，不受之前“保留原表格形式”的要求限制。
等待全部并发任务结束，根据当前文件和返回结果处理未完成项，本轮结束后提交真实结果。目前已提交 ${state.section_ids.length} 个小节，已完成 ${state.completed_section_ids.length} 个，尚未成功 ${state.section_ids.filter(id => !state.completed_section_ids.includes(id)).length} 个，小节 ID 见 程序清单/去表格进度.json；已完成的小节再次提交时自动跳过。
重读修改结果，核实表格转换情况和信息是否保留，然后调用 complete-table-cleanup，并在该调用上标记 task_complete=true；仍有表格时如实提交，由程序统一决定继续修复或接受遗留问题。没有数据表格也调用该工具结束。不要重新生成正文、配图、审计或检查字数范围，不自行转换 Word。`;
}

// 复用并发编辑与真实进度，完成工具仅提交请求，去表格质量由主流程统一验收。
function createContentGenerationTableTools({ agentService, signal, activity, inspectSection, onActivity, tableCleanup }, { Type, workspaceDir }) {
  // 工具提前注册，去表格阶段才读取程序保存的生效决策。
  const readDecisions = () => JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const result = (details, text = details) => ({ content: [{ type: 'text', text: JSON.stringify(text) }], details });
  function requireCleanup() {
    const state = tableCleanup.get();
    if (state?.status !== 'running') throw new Error('当前不在去表格阶段');
    if (activity.pending) throw new Error('请等待全部并发任务结束');
    return state;
  }
  return [{
    name: 'remove-section-tables', label: '并发去除数据表格', executionMode: 'sequential',
    description: `读取 ${taskFilePath('tables')} 中的小节，将各节全部数据表格转换为普通段落或列表，格式为 {"sections":[{"section_id":"本次目标小节 ID","instructions":"本节表格的补充说明，没有时填空字符串"}]}，保留原始信息和所有图片表格。已完成去表格的小节自动跳过，确需重新处理时该项加 "regenerate": true。${TASK_FILE_WRITING}各子任务用 Pi 原生 edit 修改自己的 HTML，未成功项返回主 Agent 统一处理。返回 total、success、skipped 和 unresolved（失败小节及原因）。`,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      const state = requireCleanup();
      const targets = new Map(readDecisions().targets.map(section => [section.id, section]));
      const { sections } = readTaskFile(workspaceDir, 'tables');
      const ids = sections.map(job => job.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能处理本次目标小节，任务文件中不能重复出现同一小节');
      // 已完成小节视为完成，重复提交同一任务文件不重复处理；regenerate 明确要求重新处理。
      const jobs = sections.filter(job => job.regenerate || !state.completed_section_ids.includes(job.section_id));
      const jobIds = jobs.map(job => job.section_id);
      tableCleanup.save({ ...state, section_ids: [...new Set([...state.section_ids, ...ids])], completed_section_ids: state.completed_section_ids.filter(id => !jobIds.includes(id)) });
      const { results: edited, restored } = jobs.length ? await editContentSections({
        jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, onActivity,
        title: '正文去表格', preserveDataTables: false,
        instructions: '把本节全部数据表格转换为受限 HTML 段落或列表，包括原方案表格。转换后的文字应明确表达各项数据与行、列表头的对应关系，保留表题含义、数值、单位、条件、备注及承诺。data-yb-preset 为 imageText、threeImages 或 fourImages 的图片表格保留完整结构和内容。仅改变表达形式，不删减信息、不作无关改写、不调整总字数。若重试时数据表格已经全部转换，核实信息完整后可在 read 上标记完成。',
        inspectSection,
        onResult(item) {
          // 产物有效且确实没有数据表格，才计入已完成去表格的小节。
          if (item.status !== 'success' || item.facts.has_data_tables) return;
          const current = tableCleanup.get();
          tableCleanup.save({ ...current, completed_section_ids: [...new Set([...current.completed_section_ids, item.section_id])] });
        },
      }) : { results: [], restored: [] };
      const byId = new Map(edited.map(item => [item.section_id, item]));
      const results = ids.map(id => byId.get(id) || { section_id: id, status: 'skipped' });
      return result({ results, restored }, batchResponse(results, restored));
    },
  }, {
    name: 'complete-table-cleanup', label: '完成去表格检查', executionMode: 'sequential',
    description: '本轮处理并核实信息保留后提交真实结果，由程序统一检查残留数据表格并决定下一步；不调整字数，图片表格允许保留。',
    parameters: Type.Object({}),
    async execute() {
      const state = requireCleanup();
      // 本轮先提交真实结果，质量验收接受后由主流程推进阶段。
      tableCleanup.save({ ...state, submission: {} });
      return result({ submitted: true });
    },
  }];
}

module.exports = { TABLE_CLEANUP_TOOLS, hasDataTables, buildTableCleanupPrompt, createContentGenerationTableTools };
