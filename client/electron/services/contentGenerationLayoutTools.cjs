const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const path = require('node:path');
const { SUBMISSION_FIX_TOOL, editContentSections, batchResponse } = require('./contentGenerationEditTools.cjs');
const { TASK_FILE_WRITING, taskFilePath, readTaskFile } = require('./contentGenerationTaskFiles.cjs');

// 补写由子任务完成；主 Agent 在本轮处理后收尾纠错，结果由统一提交检查验收。
const LAYOUT_TOOLS = [...NATIVE_AGENT_TOOLS, 'supplement-layout-sections', 'complete-layout-supplement', SUBMISSION_FIX_TOOL, 'report-failure'];

// 页码仅供理解问题，编辑位置以小节文件和图片/图组标识为准。
function buildLayoutPrompt(state) {
  return `正文生成、字数调整、一致性审计及可选的去表格阶段已结束，现在执行格式自检补写。
程序已按当前模板导出 Word，使用 docx-editor 实测页/栏留白，并排除了章节末尾与小段正常留白。本次共 ${state.jobs.length} 个小节、${state.jobs.reduce((sum, job) => sum + job.gaps.length, 0)} 处需要补写，完整任务见 程序清单/格式补写任务.json，按需读取；只处理其中的明确任务，不自行导出或分析 Word，不修改其他位置。
任务中每项 gaps 给出待插入文字的图片或图组（figure_ids、block_index、target_text），以及 preceding_text、页码、栏号、留白厘米数和建议新增字数。block_index 为检测时该小节顶层元素从零开始的下标，修改后会变化，优先按图片标识定位；页码和栏号不可作为 HTML 定位依据。
将尚未成功的小节 ID 写入 ${taskFilePath('layout')}，格式为 {"section_ids":["小节 ID"]}，再调用 supplement-layout-sections，工具会向子任务提供该节完整任务集合。${TASK_FILE_WRITING}各小节并发编辑，同一小节的全部位置由一个子任务处理。已完成 ${state.completed_section_ids.length} 个小节，再次提交时自动跳过。
补写紧接在目标图片或整个图片表格之前，使用连贯的普通段落，不把文字写进图片、图注或表格单元格，不修改图片、图组结构或布局。建议字数为排版估算值，尽量用一段连贯文字，避免拆成许多短段引入额外段间距。内容必须承接上下文，有实际信息，不用重复套话填空，不新增无依据的事实或承诺。
失败或中断任务先重读文件；若相应位置已有本次补写，核对后只补不足部分，禁止重复追加整份字数。等待全部并发任务结束，根据真实结果处理未完成项。本轮编辑后，如发现新增内容存在具体错误，读取对应小节，使用 edit 作必要修正，保留既有正文和图片。无需为收尾重新通读全部小节或进行新一轮审计。中断后保留已写入的修正，继续处理未解决的问题，不重复补写成功小节。本轮处理后，调用 complete-layout-supplement 并标记 task_complete=true，未完成项交由程序统一决定继续修复或接受遗留问题；纠错 edit 不标记任务完成。只执行这一轮补写，不再调整全文字数、不再审计、不重新配图；程序将重新导出复查。`;
}

// 汇总本轮尚未完成的补写目标，不重新判断程序复查已允许保留的留白。
function collectLayoutSubmissionIssues(state) {
  if (!state.submission) return [];
  const completed = new Set(state.completed_section_ids);
  return state.jobs.filter(job => !completed.has(job.section_id)).map(job => ({
    severity: 'quality', type: 'layout-supplement', section_id: job.section_id,
    file: job.file, fixable: false,
    message: `小节 ${job.section_id} 的指定格式补写尚未完成，请按已保存的补写任务处理并提交真实结果。`,
  }));
}

// 并发编辑只报告本节可用性，补写目标由主流程统一验收。
function createContentGenerationLayoutTools({ agentService, signal, layout, activity, inspectSection, onActivity }, { Type, workspaceDir }) {
  const response = (details, text = details) => ({ content: [{ type: 'text', text: JSON.stringify(text) }], details });
  return [{
    name: 'supplement-layout-sections', label: '并发补写排版留白', executionMode: 'sequential',
    description: `读取 ${taskFilePath('layout')} 中的小节 ID，格式为 {"section_ids":["小节 ID"]}，按程序检测的任务集合并发补写这些小节，保留所有图片和既有内容。已完成补写的小节自动跳过，不重复补写；小节不在本次格式补写任务中时报错。${TASK_FILE_WRITING}返回 total、success、skipped 和 unresolved（失败小节及原因）。`,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      const state = layout.get();
      // 补写任务在程序自检后才确定，执行时读取最终正文目标。
      const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
      const targets = new Map(decisions.targets.map(section => [section.id, section]));
      const { section_ids: ids } = readTaskFile(workspaceDir, 'layout');
      if (new Set(ids).size !== ids.length) throw new Error('任务文件中不能重复出现同一小节');
      // 已完成补写的小节跳过，避免重复追加文字。
      const jobs = ids.filter(id => !state.completed_section_ids.includes(id)).map(id => {
        const job = state.jobs.find(item => item.section_id === id);
        if (!job) throw new Error(`小节不在本次格式补写任务中：${id}`);
        return { section_id: id, instructions: `检测任务：${JSON.stringify(job)}。逐一定位 gaps 的图片/图组，在整个块之前补写 suggested_words 左右的连贯正文。block_index 是检测时下标，定位以 figure_ids 及邻近文字为准。若此前中断时已补写，保留已有补写，仅补不足部分，不重复追加。` };
      });
      const { results: edited, restored } = jobs.length ? await editContentSections({ jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, inspectSection, onActivity,
        title: '格式自检补写',
        instructions: '只在指定位置新增普通文字段落，承接前后语义，不新增无依据事实或承诺，不改图片、图注、图组、表格及其单元格，不删除或改写已有正文。不重新审计、不调整全文字数、不生成图片。优先一段连贯正文，不用标题、列表或大量短段填空。',
        onResult(item) {
          if (item.status !== 'success') return;
          const current = layout.get();
          layout.save({ ...current, completed_section_ids: [...current.completed_section_ids, item.section_id] });
        },
      }) : { results: [], restored: [] };
      const byId = new Map(edited.map(item => [item.section_id, item]));
      const results = ids.map(id => byId.get(id) || { section_id: id, status: 'skipped' });
      return response({ results, restored }, batchResponse(results, restored));
    },
  }, {
    name: 'complete-layout-supplement', label: '完成格式补写', executionMode: 'sequential',
    description: '本轮处理后提交真实补写结果，由程序统一验收；接受后重新导出复查，不因复查留白再次补写。',
    parameters: Type.Object({}),
    execute() {
      const state = layout.get();
      if (state?.status !== 'supplementing') throw new Error('当前不在格式补写阶段');
      if (activity.pending) throw new Error('请等待全部并发任务结束');
      // 保持补写阶段可编辑，统一提交检查接受后才进入导出复查。
      layout.save({ ...state, submission: {} });
      return response({ submitted: true });
    },
  }];
}

module.exports = { LAYOUT_TOOLS, buildLayoutPrompt, collectLayoutSubmissionIssues, createContentGenerationLayoutTools };
