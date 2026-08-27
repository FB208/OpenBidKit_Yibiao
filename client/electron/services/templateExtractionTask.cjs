const {
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');

const TEMPLATE_FIELDS_OUTPUT_FILE = 'bid-template-fields.json';
const TEMPLATE_OUTLINE_INPUT_FILE = '已确认一级目录.json';

function createTemplateExtractionPrompt(sourcePaths = []) {
  const sourceList = sourcePaths.length
    ? sourcePaths.map((item) => `- ${item}`).join('\n')
    : '- 无';
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：根据用户已确认且处理模式为“模板填写”的一级目录，从招标 Word 原件抽取投标模版，识别模版中需要填写的位置，并写入 Word 内容控件和字段清单。本任务只提取和标记，不生成任何字段值，也不填写模版。

当前 Session 从一级目录生成任务分叉而来。此前生成的 outline.json 只是待用户选择的候选结果；${TEMPLATE_OUTLINE_INPUT_FILE} 只包含最终确认的“模板填写”目录，本任务必须只以该文件作为抽取范围依据，不得处理目录生成、人工填写、AI 生成或其他模式目录。

程序固定绑定的招标 Word 原件：
${sourceList}

必须按以下顺序执行：
1. 阅读 ${TEMPLATE_OUTLINE_INPUT_FILE}。
2. 只调用一次 openxml，action=list-blocks；再阅读生成的 招标原文结构.json。
3. 针对已确认的每个一级目录，在原文结构中找到真实章节位置和完整边界，只调用一次 openxml，action=extract-chapters。原文块 heading=true 时可提供 sourceTitle；heading=false 时必须提供标题所在的 startBlock 和下一同级章节或附件开始位置 endBlock，endBlock 不包含在本章内。不得把两个已选目录之间的其他表单，或最后一个已选目录之后的文档尾部一并抽入；多份原件时填写 source.path。
4. 调用一次 openxml，action=scan-template-fields；再阅读生成的 投标模版字段候选.json。
5. 候选必须全部来自已确认一级目录对应的章节。如果候选上下文明显属于未选择的表单或后续附件，说明抽章边界错误；不得把这些候选批量放入 ignored_candidate_ids 来掩盖范围错误，也不得继续应用字段。
6. 对候选逐项分类：真实待填位置放入 fields，只有扫描误判、固定说明文字或无需填写的位置才能放入 ignored_candidate_ids。所有候选必须且只能归入其中一类。
7. fields 每项只填写 candidate_id、name、fill_by，以及确有必要时的 instruction。fill_by 只能是 ai 或 manual；签字、盖章、签章、手印和必须放置人工材料的位置使用 manual。
8. 同一项内容需要填入多处时，多个候选必须使用完全相同的 name、fill_by 和 instruction，让后续程序能够按 name 合并；不同语义不得仅因标题近似而合并。
9. 最后调用 openxml，action=apply-template-fields，传入 fields 和 ignored_candidate_ids。每次调用彼此独立，不会记忆或合并前一次失败调用的参数；如果调用失败，必须根据 openxml 返回的重复、重叠、无效或遗漏候选重新核对 投标模版字段候选.json，并在当前会话重新提交包含全部候选的完整 fields 和 ignored_candidate_ids，直至成功。不得只增量补交错误中列出的候选，不得使用 * 等通配符，失败后不得结束任务。不要直接编辑 DOCX、不要生成字段值、不要修改 ${TEMPLATE_OUTLINE_INPUT_FILE}。
10. 成功后确认工作区已有 ${TEMPLATE_FIELDS_OUTPUT_FILE}，然后结束任务。`;
}

function buildOpenXmlToolOptions(workspaceStore, openXmlHelperService) {
  return {
    openXmlHelperService,
    listBusinessSources: () => workspaceStore.listTenderSourceDocxRelativePaths(),
    resolveAgentSources: (hint) => workspaceStore.resolveTenderSourceDocxPath(hint),
    bidTemplateSourcePath: workspaceStore.getBidTemplateSourcePath(),
    bidTemplateSourceRelativePath: workspaceStore.getBidTemplateSourceRelativePath(),
    bidTemplatePath: workspaceStore.getBidTemplatePath(),
    bidTemplateRelativePath: workspaceStore.getBidTemplateRelativePath(),
    bidTemplateFieldsPath: workspaceStore.getBidTemplateFieldsPath(),
    bidTemplateFieldsRelativePath: workspaceStore.getBidTemplateFieldsRelativePath(),
  };
}

async function runTemplateExtractionTask({
  agentService,
  workspaceStore,
  openXmlHelperService,
  taskId,
  outline,
  signal,
  onActivity,
  onCheckpoint,
}) {
  const sourcePaths = workspaceStore.listTenderSourceDocxRelativePaths();
  if (!sourcePaths.length) {
    return { status: 'skipped', field_count: 0 };
  }

  const result = await agentService.runTask({
    task_id: taskId,
    title: '投标模版提取',
    prompt: createTemplateExtractionPrompt(sourcePaths),
    output_file: TEMPLATE_FIELDS_OUTPUT_FILE,
    files: [{
      path: TEMPLATE_OUTLINE_INPUT_FILE,
      content: JSON.stringify({ outline }, null, 2),
    }],
    signal,
    persistent_task: {
      task_key: TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'template-extraction',
    initial_stage_index: 0,
    open_xml_tool: buildOpenXmlToolOptions(workspaceStore, openXmlHelperService),
    max_retries: 0,
    onActivity,
    onCheckpoint,
    validateOutput(candidate) {
      if (!workspaceStore.hasBidTemplate()) {
        throw new Error('投标模版和字段清单尚未同时生成');
      }
      let payload;
      try {
        payload = JSON.parse(String(candidate.output_content || '').trim());
      } catch (error) {
        throw new Error(`投标模版字段清单不是合法 JSON：${error?.message || String(error)}`);
      }
      if (payload?.version !== 1 || !Array.isArray(payload?.fields)) {
        throw new Error('投标模版字段清单结构无效');
      }
      return { field_count: payload.fields.length };
    },
  });

  const payload = JSON.parse(String(result.output_content || '').trim());
  agentService.updatePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
  return {
    status: 'success',
    task_id: result.task_id,
    session_id: result.session_id,
    field_count: payload.fields.length,
  };
}

module.exports = {
  TEMPLATE_FIELDS_OUTPUT_FILE,
  runTemplateExtractionTask,
};
