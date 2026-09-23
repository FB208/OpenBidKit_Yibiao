const fs = require('node:fs');
const path = require('node:path');
const { editContentSections } = require('./contentGenerationEditTools.cjs');

const LAYOUT_TOOLS = ['read', 'find', 'ls', 'supplement-layout-sections', 'complete-layout-supplement', 'report-failure'];

// 页码仅供理解问题，编辑位置以小节文件和图片/图组标识为准。
function buildLayoutPrompt(state) {
  return `正文生成、字数调整、一致性审计及可选的去表格阶段已结束，现在执行格式自检补写。
程序已按当前模板导出 Word，使用 docx-editor 实测页/栏留白，并排除了章节末尾与小段正常留白。只处理以下明确任务，不自行导出或分析 Word，不修改其他位置。
${JSON.stringify(state.jobs)}
每项 gaps 给出待插入文字的图片或图组（figure_ids、block_index、target_text），以及 preceding_text、页码、栏号、留白厘米数和建议新增字数。block_index 为检测时该小节顶层元素从零开始的下标，修改后会变化，优先按图片标识定位；页码和栏号不可作为 HTML 定位依据。
调用 supplement-layout-sections 一次提交所有尚未成功的小节 ID，工具会提供该节完整任务集合。各小节并发编辑，同一小节的全部位置由一个子任务处理，不逐个小节等待。已完成小节：${JSON.stringify(state.completed_section_ids)}。
补写紧接在目标图片或整个图片表格之前，使用连贯的普通段落，不把文字写进图片、图注或表格单元格，不修改图片、图组结构或布局。建议字数为排版估算值，尽量用一段连贯文字，避免拆成许多短段引入额外段间距。内容必须承接上下文，有实际信息，不用重复套话填空，不新增无依据的事实或承诺。
失败或中断任务先重读文件；若相应位置已有本次补写，核对后只补不足部分，禁止重复追加整份字数。等待全部并发任务结束，只重新提交未成功的小节，然后调用 complete-layout-supplement 并标记 task_complete=true。只执行这一轮补写，不再调整全文字数、不再审计、不重新配图；程序将重新导出复查。`;
}

// 并发编辑沿用原生 edit 与图片写入前保护，不另造文本替换工具。
function createContentGenerationLayoutTools({ agentService, signal, layout, validateHtml, validateResult, onActivity }, { Type, workspaceDir }) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const activity = { pending: 0 };
  const response = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  return [{
    name: 'supplement-layout-sections', label: '并发补写排版留白', executionMode: 'sequential',
    description: '按程序检测的任务集合并发补写指定小节，只处理尚未成功的任务，保留所有图片和既有内容。',
    parameters: Type.Object({ section_ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      const state = layout.get();
      const jobs = params.section_ids.map(id => {
        const job = state.jobs.find(item => item.section_id === id);
        if (!job || state.completed_section_ids.includes(id)) throw new Error(`小节不在本次未完成的格式补写任务中：${id}`);
        return { section_id: id, instructions: `检测任务：${JSON.stringify(job)}。逐一定位 gaps 的图片/图组，在整个块之前补写 suggested_words 左右的连贯正文。block_index 是检测时下标，定位以 figure_ids 及邻近文字为准。若此前中断时已补写，保留已有补写，仅补不足部分，不重复追加。` };
      });
      const results = await editContentSections({ jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, validateHtml, onActivity,
        title: '格式自检补写',
        instructions: '只在指定位置新增普通文字段落，承接前后语义，不新增无依据事实或承诺，不改图片、图注、图组、表格及其单元格，不删除或改写已有正文。不重新审计、不调整全文字数、不生成图片。优先一段连贯正文，不用标题、列表或大量短段填空。',
        onResult(item) {
          if (item.status !== 'success') return;
          const current = layout.get();
          layout.save({ ...current, completed_section_ids: [...current.completed_section_ids, item.section_id] });
        },
      });
      return response({ results });
    },
  }, {
    name: 'complete-layout-supplement', label: '完成格式补写', executionMode: 'sequential',
    description: '所有指定补写任务成功后提交，由程序重新导出复查，不再次补写。',
    parameters: Type.Object({}),
    execute() {
      const state = layout.get();
      if (activity.pending || state.jobs.some(job => !state.completed_section_ids.includes(job.section_id))) throw new Error('仍有未完成的格式补写任务，请重试失败任务');
      validateResult();
      layout.save({ ...state, status: 'rechecking' });
      return response({ completed: true });
    },
  }];
}

module.exports = { LAYOUT_TOOLS, buildLayoutPrompt, createContentGenerationLayoutTools };
