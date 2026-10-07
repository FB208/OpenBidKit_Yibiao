const Ajv = require('ajv');
const {
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { TEMPLATE_FIELD_CLASSIFICATION_SCHEMA } = require('./pi/piOpenXmlTool.cjs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');

const TEMPLATE_FIELDS_OUTPUT_FILE = 'bid-template-fields.json';
const TEMPLATE_FIELDS_VERSION = 2;
const TEMPLATE_OUTLINE_INPUT_FILE = '已确认一级目录.json';
const TEMPLATE_CLASSIFICATION_FILE = '投标模版字段分类.json';
// 原生工具由公共层统一开放；业务工具只开放 openxml 和报告失败。
const TEMPLATE_EXTRACTION_TOOLS = [...NATIVE_AGENT_TOOLS, 'openxml', 'report-failure'];
const ajv = new Ajv({ allErrors: true, strict: true });
const validateClassification = ajv.compile(TEMPLATE_FIELD_CLASSIFICATION_SCHEMA);

// 明确分类文件与工具生成产物的职责，以及本阶段完成条件。
function createTemplateExtractionPrompt(sourcePaths = []) {
  const sourceList = sourcePaths.length
    ? sourcePaths.map((item) => `- ${item}`).join('\n')
    : '- 无';
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：根据用户已确认且处理模式为“模板填写”的一级目录，从招标 Word 原件抽取投标模版，识别模版中需要填写的位置，并写入 Word 内容控件和字段清单。本任务只提取和标记，不生成任何字段值，也不填写模版。

字段用途：后续由程序从企业资信库和招标文件信息自动填写 fill_by=ai 的字段，附件从资信库图片中选择；fill_by=manual 只用于签字、签名、手印、仅需盖章的位置和资信库中没有的附件材料，由用户人工处理。

必须完成的产物：当前工作目录根目录中的 ${TEMPLATE_CLASSIFICATION_FILE}、bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE}。程序会为尚不存在的分类文件预建空文件；空文件不算完成，首次填充必须使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。已有内容修正可用 edit 或 write。必须使用上述精确文件名，不得改名、移到子目录或仅在回复中输出。分类文件由你填写，最终 Word 和字段清单必须由 openxml 的 apply-template-fields 生成，不得手工写入。全部产物有效后才允许结束任务。

当前 Session 从一级目录生成任务分叉而来。此前生成的 outline.json 只是待用户选择的候选结果；${TEMPLATE_OUTLINE_INPUT_FILE} 只包含最终确认的“模板填写”目录，本任务必须只以该文件作为抽取范围依据，不得处理目录生成、人工填写、AI 生成或其他模式目录。

程序固定绑定的招标 Word 原件：
${sourceList}

必须按以下顺序执行：
1. 阅读 ${TEMPLATE_OUTLINE_INPUT_FILE}。
2. 只调用一次 openxml，action=list-blocks；再用 read 一次读完生成的 招标原文结构.txt。该文件每行一个非空原文块，格式为“块号 [标记] 文本”；[标题N] 表示可用 sourceTitle 定位的原文标题，空块已省略但块号保持原值。
3. 针对已确认的每个一级目录，在原文结构中找到真实章节位置和完整边界，正常情况下只调用一次 openxml，action=extract-chapters。带 [标题N] 标记的原文标题可提供 sourceTitle；没有该标记时必须提供标题所在的 startBlock 和下一同级章节或附件开始位置 endBlock，endBlock 不包含在本章内。不得把两个已选目录之间的其他表单，或最后一个已选目录之后的文档尾部一并抽入；多份原件时填写 source.path。后续扫描若明确证明抽章边界错误，应修正相关边界后重新抽取并扫描。
4. 调用一次 openxml，action=scan-template-fields。工具结果直接返回 default_suggested_fill_by、contexts 和 candidates，正常情况下据此逐项分类，无需再次读取 投标模版字段候选.json；工具结果被截断或信息明显缺失时，可按章节、context_id 或 candidate_id 筛选该文件的相关部分，分批完成分类，无需重新读取整份候选。所有候选最终均须得到分类。候选说明：
   - context 中的【▢…】标出当前候选的准确位置，同一段落的多个候选以此区分；表格候选的 context 按网格列列出同行内容，【▢第N列】是当前单元格。
   - suggested_name 是程序按相邻标签给出的建议名称，可按语义修正；suggested_fill_by 是建议值，未提供时使用顶层默认值。
   - kind=checkbox-group 是一组勾选项，options 为选项文字；kind=attachment-slot 是放置附件材料的位置；kind=attachment-note 是“后附/附：…复印件”一类说明，作为字段时程序会在其后插入附件位置。
   - table_id、row_number、column_number 标明表格候选所在的表格和行列。
5. 候选必须全部来自已确认一级目录对应的章节。如果候选上下文明显属于未选择的表单或后续附件，说明抽章边界错误；不得把这些候选批量放入 ignored_candidate_ids 来掩盖范围错误，也不得继续应用字段。
6. 对候选逐项分类，并将完整结果写入 ${TEMPLATE_CLASSIFICATION_FILE}，顶层包含 fields 数组和 ignored_candidate_ids 数组；内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。真实待填位置放入 fields，只有扫描误判、固定说明文字或无需填写的位置才能放入 ignored_candidate_ids。所有候选必须且只能归入其中一类。
7. fields 每项只填写 candidate_id、name、fill_by，以及确有必要时的 instruction 和附件的 parts：
   - fill_by 只能是 ai 或 manual。签字、签名、签章、手印、仅需盖章的位置使用 manual；企业名称、代码、地址、人员信息、日期、编号、勾选项等可由企业信息库或招标文件提供的内容使用 ai，即使旁边标有“（公章）”“（盖章）”。
   - 附件类候选（attachment-slot、作为字段的 attachment-note）：资信库中常见的材料使用 ai，包括营业执照、开户许可证、基本存款账户信息、法定代表人或授权代表身份证人像面和国徽面、法定代表人授权委托书、信用报告与失信查询截图、纳税证明、财务审计报告、社保缴纳证明、资质证书、员工社保/身份证/劳动合同/学历证书/驾驶证/技能证书、业绩合同/中标通知书/验收证明/回款发票；投标保证金凭证、需另行办理的证明等资信库中没有的材料使用 manual。
   - 一个附件位置只放一张图片。由多张图片组成的材料必须用 parts 拆分为多个连续位置，例如身份证拆为“法定代表人身份证人像面”“法定代表人身份证国徽面”；招标文件写明数量的同类材料按数量拆分并编号，例如“类似业绩合同（第1份）”“类似业绩合同（第2份）”；未写明数量的只保留一个位置，不使用 parts。parts 至少两项，每项填写 name（可选 instruction），各部分名称不同；使用 parts 时 name 写材料总称。部分名称尽量与上面的资信库材料名称一致。
   - name 使用业务通用称谓。同一实体全文必须同名，例如“投标人名称”“投标单位”“企业名称”统一为“投标人名称”，法定代表人、被授权人的各项信息同理；不同语义不得仅因标题近似而合并。
   - 日期被拆成年、月、日多个候选时，按“日期（年）”“成立时间（月）”等方式命名。
   - 可重复行的清单表（如资料目录）同一列各行使用相同的列名作为 name，不加行号，程序按 table_id 和行号区分各行；键值型表格按单元格左侧标签命名。
   - 勾选项按所属项目命名（如“企业类型”）；附件位置按材料命名（如“营业执照”）。
   - attachment-note 之后已有对应附件位置（attachment-slot 或其他材料位置）时，放入 ignored_candidate_ids；否则作为附件字段。
8. 同一项内容需要填入多处时，多个候选必须使用完全相同的 name、fill_by 和 instruction（拆分的附件按各部分名称判断）；同名候选的类型（文本、勾选项、附件）必须一致。
9. 完成候选语义判断并用 write 或 edit 成功写入完整分类文件后，立即单独调用 openxml，只传 {"action":"apply-template-fields","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}。工具会读取并校验文件中的完整 fields 和 ignored_candidate_ids，应用前无需再做机械检查。调用失败时，优先根据错误用 edit 或 write 修正同一个分类文件，再提交文件路径；错误信息不足以直接修正时，才用 read 查看相关部分。文件必须始终保留完整分类，不得在调用参数里再次输出字段清单，不得只增量补交错误中列出的候选，不得使用 * 等通配符。不要直接编辑 DOCX、不要生成字段值、不要修改 ${TEMPLATE_OUTLINE_INPUT_FILE}，也不要把分类文件写到 ${TEMPLATE_FIELDS_OUTPUT_FILE}。
10. apply-template-fields 已内置分类校验、Word 校验及产物检查，成功后程序自动结束任务，无需 task_complete。失败时继续修复，不得结束任务；成功后不再检查文件、重复应用字段或输出总结。`;
}

// 将模板工具绑定到当前业务工作区的原件和输出位置。
function buildOpenXmlToolOptions(workspaceStore, openXmlHelperService, onStep) {
  return {
    openXmlHelperService,
    onStep,
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

// 提取模板并报告分类、Word 和字段清单的提交问题，修复预算由 Runtime 统一管理。
async function runTemplateExtractionTask({
  agentService,
  workspaceStore,
  openXmlHelperService,
  taskId,
  outline,
  signal,
  onActivity,
  onCheckpoint,
  onStep,
}) {
  const sourcePaths = workspaceStore.listTenderSourceDocxRelativePaths();
  if (!sourcePaths.length) {
    return { status: 'skipped', field_count: 0 };
  }

  const result = await agentService.runTask({
    task_id: taskId,
    title: '投标模版提取',
    summary_enabled: false,
    // 模版和字段清单由工具校验并落盘成功后结束，不依赖模型主动标记完成。
    is_final_tool_call: (call) => call.name === 'openxml' && call.arguments?.action === 'apply-template-fields',
    prompt: createTemplateExtractionPrompt(sourcePaths),
    output_file: TEMPLATE_FIELDS_OUTPUT_FILE,
    prepare_output_files: [TEMPLATE_CLASSIFICATION_FILE],
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
    active_tools: TEMPLATE_EXTRACTION_TOOLS,
    open_xml_tool: buildOpenXmlToolOptions(workspaceStore, openXmlHelperService, onStep),
    max_retries: 1,
    onActivity,
    onCheckpoint,
    buildRetryPrompt(request) {
      if (request.kind === 'execution') return null;
      return `请保留当前工作区已有结果，只修复本次提交报告中的问题。必须在当前工作目录根目录中将完整分类写入 ${TEMPLATE_CLASSIFICATION_FILE}，不得改名或另存到其他目录；空文件首次用 write 填充，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。已有内容用 edit 或 write 修复。全部分类写完后调用 openxml，参数为 {"action":"apply-template-fields","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}，由工具生成 bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE}，不得手工写入最终 Word 或字段清单。分类及全部正式产物有效后才能结束。`;
    },
    async validateOutput(candidate, meta) {
      const issues = [];
      const classificationContent = String(await meta.readFile(TEMPLATE_CLASSIFICATION_FILE) || '').trim();
      if (!classificationContent) {
        issues.push({ severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE,
          message: `${TEMPLATE_CLASSIFICATION_FILE} 未生成或内容为空，请写入完整分类 JSON` });
      } else {
        let classification;
        try {
          classification = JSON.parse(classificationContent);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          issues.push({ severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE,
            message: `${TEMPLATE_CLASSIFICATION_FILE} 不是合法 JSON：${error.message}` });
        }
        if (classification !== undefined && !validateClassification(classification)) {
          issues.push(...validateClassification.errors.map(item => ({
            severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE, path: item.instancePath || '/',
            message: `${TEMPLATE_CLASSIFICATION_FILE} 结构无效：${item.instancePath || '/'} ${item.message}`,
          })));
        }
      }
      if (!workspaceStore.hasBidTemplate()) {
        issues.push({ severity: 'blocking', file: 'bid-template.docx',
          message: `bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE} 尚未同时生成，请通过 openxml 的 apply-template-fields 生成` });
      }
      let payload;
      const outputContent = String(candidate.output_content || '').trim();
      if (!outputContent) {
        issues.push({ severity: 'blocking', file: TEMPLATE_FIELDS_OUTPUT_FILE,
          message: `${TEMPLATE_FIELDS_OUTPUT_FILE} 未生成或内容为空，请通过 openxml 的 apply-template-fields 生成` });
      } else {
        try {
          payload = JSON.parse(outputContent);

        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          issues.push({ severity: 'blocking', file: TEMPLATE_FIELDS_OUTPUT_FILE,
            message: `${TEMPLATE_FIELDS_OUTPUT_FILE} 不是合法 JSON：${error.message}` });
        }
        if (payload !== undefined) {
          if (payload?.version !== TEMPLATE_FIELDS_VERSION) issues.push({ severity: 'blocking', file: TEMPLATE_FIELDS_OUTPUT_FILE,
            path: '/version', message: `${TEMPLATE_FIELDS_OUTPUT_FILE} 的 version 必须为 ${TEMPLATE_FIELDS_VERSION}` });
          if (!Array.isArray(payload?.fields)) issues.push({ severity: 'blocking', file: TEMPLATE_FIELDS_OUTPUT_FILE,
            path: '/fields', message: `${TEMPLATE_FIELDS_OUTPUT_FILE} 的 fields 必须为数组` });
        }
      }
      return { value: issues.length ? null : { field_count: payload.fields.length }, issues };
    },
  });

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
    field_count: result.validation_result.field_count,
  };
}

module.exports = {
  TEMPLATE_FIELDS_OUTPUT_FILE,
  runTemplateExtractionTask,
};
