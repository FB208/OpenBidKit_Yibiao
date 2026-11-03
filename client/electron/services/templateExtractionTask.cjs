const Ajv = require('ajv');
const {
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { AGENT_BLOCKS_FILE, CONFIRM_TEMPLATE_FIELDS_ACTION, TEMPLATE_FIELD_CLASSIFICATION_SCHEMA } = require('./pi/piOpenXmlTool.cjs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const { CREDENTIAL_IMAGE_FIELD_KEYS, CREDENTIAL_IMAGE_FIELD_LABELS } = require('./credentialLibraryService.cjs');

const TEMPLATE_FIELDS_OUTPUT_FILE = 'bid-template-fields.json';
const TEMPLATE_FIELDS_VERSION = 2;
const TEMPLATE_OUTLINE_INPUT_FILE = '已确认模板目录.json';
const TEMPLATE_CLASSIFICATION_FILE = '投标模版字段分类.json';
// 原生工具由公共层统一开放；业务工具只开放 openxml 和报告失败。
const TEMPLATE_EXTRACTION_TOOLS = [...NATIVE_AGENT_TOOLS, 'openxml', 'report-failure'];
const ajv = new Ajv({ allErrors: true, strict: true });
const validateClassification = ajv.compile(TEMPLATE_FIELD_CLASSIFICATION_SCHEMA);

const CREDENTIAL_IMAGE_OWNER_LABELS = { profile: '企业资料', certificate: '资质证书', employee: '员工', project: '业绩', other: '其他资料' };

// 附件可推荐范围取自资信库实际支持的图片栏目，不在提示词中写死。
function formatCredentialImageCategories() {
  return Object.entries(CREDENTIAL_IMAGE_FIELD_KEYS)
    .map(([owner, keys]) => `${CREDENTIAL_IMAGE_OWNER_LABELS[owner] || owner}（${[...keys].map((key) => CREDENTIAL_IMAGE_FIELD_LABELS[key] || key).join('、')}）`)
    .join('；');
}

// 明确分类文件与工具生成产物的职责，以及本阶段完成条件。
function createTemplateExtractionPrompt(sourcePaths = [], { reextraction = false } = {}) {
  const sourceList = sourcePaths.length
    ? sourcePaths.map((item) => `- ${item}`).join('\n')
    : '- 无';
  const sessionNote = reextraction
    ? `当前 Session 从目录生成任务分叉而来，目录确认后又经过子目录生成和调整，工作区中的 outline.json 不代表本次抽取范围；${TEMPLATE_OUTLINE_INPUT_FILE} 的 items 是按当前目录重新确定、需要抽进投标模版的全部目录`
    : `当前 Session 从一级目录生成任务分叉而来。此前生成的 outline.json 只是待用户选择的候选结果；${TEMPLATE_OUTLINE_INPUT_FILE} 的 items 是最终确认、需要抽进投标模版的全部目录`;
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：根据用户已确认的目录，从招标 Word 原件抽取完整的投标模版，识别模版中需要填写的位置，并写入 Word 内容控件和字段清单。本任务只提取和标记，不生成任何字段值，也不填写模版。

目标：导出后每一章都是投标人可以直接提交的表单——需要投标人写入信息的地方都有填写位置；提示投标人怎么填的说明、示例写法和招标文件格式本身的文字（表单编号、格式名称、格式使用说明）在导出时不残留；其余原文保持不动。程序只负责定位和执行，哪里要填、什么要去掉、哪一段是标题都由你按含义判断，不依赖具体措辞。删掉有用的内容比留下多余文字更不能接受，拿不准时保留原文。

字段用途：后续由程序从企业资信库和招标文件信息自动填写 fill_by=ai 的字段，附件从资信库图片中选择；fill_by=manual 只用于签字、签名、手印、仅需盖章的位置和资信库中没有的附件材料，由用户人工处理。需要写本投标文件某部分所在页码的位置（如“该声明函见投标文件第__页”）也作为字段，fill_by=ai，填写时由程序生成页码。auto_fill=false 的目录由用户人工填写，程序写入字段时会把这些章节中的字段统一改为 manual（与自动填写章节同名的字段沿用程序填写），分类时仍按位置语义命名，fill_by 按常规规则填写即可。rule_page=true 的目录是规则和页码章节，其中按招标文件逐条列出的表格由规则和页码 Agent 按招标文件逐项编制行内容。

必须完成的产物：当前工作目录根目录中的 ${TEMPLATE_CLASSIFICATION_FILE}、bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE}。程序会为尚不存在的分类文件预建空文件；空文件不算完成，首次填充必须使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。已有内容修正可用 edit 或 write。必须使用上述精确文件名，不得改名、移到子目录或仅在回复中输出。分类文件由你填写，最终 Word 和字段清单必须由 openxml 的 apply-template-fields 生成，不得手工写入；审阅效果正文后调用 confirm-template-fields 确认，任务才会结束。

${sessionNote}（path 是从一级目录到本目录的标题链，auto_fill 表示字段是否自动填写，rule_page 表示规则和页码章节），本任务必须只以该文件作为抽取范围依据，每个目录都要抽取，不得遗漏或增加。

程序固定绑定的招标 Word 原件：
${sourceList}

必须按以下顺序执行：
1. 阅读 ${TEMPLATE_OUTLINE_INPUT_FILE}。
2. 工作区中的 ${AGENT_BLOCKS_FILE} 已由程序生成，确认目录前已经读过：每行一个非空原文块，格式为“块号 [标记] 文本”；[标题N] 表示可用 sourceTitle 定位的原文标题，空块已省略但块号保持原值。需要核对时按块号用 read 定点读取相关部分，不必重新通读；只有该文件缺失时才调用一次 openxml，action=list-blocks 重新生成。
3. 正常情况下只调用一次 openxml，action=extract-chapters，每个目录抽取一章，按 items 顺序排列，id 填该目录的 id，title 使用目录标题；程序会按 id 核对是否齐全并标记是否自动填写。目录带 source 时，直接以 source.start 作为 startBlock、source.end 作为 endBlock（不包含在本章内），有 source.source 时填入该章的 source；这些位置在确认目录时已由程序核对。目录没有 source 时，在原文结构中找到真实章节位置和完整边界：带 [标题N] 标记的原文标题可提供 sourceTitle；没有该标记时必须提供标题所在的 startBlock 和下一同级章节或附件开始位置 endBlock，endBlock 不包含在本章内；不得把两个已选目录之间的其他表单，或最后一个已选目录之后的文档尾部一并抽入；多份原件时填写 source。后续扫描若明确证明抽章边界错误，应修正相关边界后重新抽取并扫描。
4. 调用一次 openxml，action=scan-template-fields。工具结果返回程序按版式识别出的候选（candidates），并写出 投标模版正文.txt：
   - 投标模版正文.txt 是带定位号的完整模版正文，每行一个段落“定位号  文字”，〔c_…〕标出候选（下划线、占位符、标签后空位、空单元格、勾选项、附件位置等），␣ 表示连续空格中的一个空格，⇥ 表示制表符，⏎ 表示段内换行或分页（不占字符），〔不可标记〕的段落不能补充位置或去掉文字；每章标题行给出章节 id 和程序按目录标题认定的默认标题段。必须通读全文，按含义理解每张表单。
   - 候选的 context 中【▢…】标出准确位置，表格候选按网格列列出同行内容，【▢第N列】是当前单元格；suggested_name、suggested_fill_by 是程序的建议，可按语义修正；table_id、row_number、column_number 标明表格候选的行列。
   - kind=checkbox-group 是一组勾选项，options 为选项文字；kind=attachment-slot 是放置附件材料的位置；kind=attachment-note 是“后附/附：…复印件”一类说明，作为字段时程序会在其后插入附件位置。
5. 候选必须全部来自已确认目录对应的章节。如果候选上下文明显属于未选择的表单或后续附件，说明抽章边界错误；不得把这些候选批量放入 ignored_candidate_ids 来掩盖范围错误，也不得继续应用字段。
6. 写分类文件 ${TEMPLATE_CLASSIFICATION_FILE}：顶层包含 fields 和 ignored_candidate_ids 数组，以及可选的 positions、removals、headings 和 repeats 数组；内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。
   - 候选：每个候选必须且只能归入 fields 或 ignored_candidate_ids。真实待填位置放入 fields；扫描误判或无需填写的放入 ignored_candidate_ids。
   - positions：程序没有标出、但投标人需要写入信息的地方由你补充。op 取以下之一：
     insert：模版里没有空位或空位残缺（如标签后直接接单位、右括号或句号，日期只剩“年月日”），before、after 写插入点两侧紧邻的原文，至少写一个，使插入点在该段唯一；
     span：一段原文本身就是要替换成填写值的位置（如示例写法、整个括注都是在告诉投标人此处写什么、只有普通空格的空位），text 为这段原文，在该段不唯一时加 before/after 区分；
     choose：要求投标人从几个并列备选中只选一项，text 覆盖全部备选，options 逐项照抄原文中的备选；并列列举的多个事项不是择一；
     attachment：放置证件、证书等材料图片、但没有附件位置的地方（如单元格里只写着材料名称），at 为写着材料名称的段落，附件位置放在该段之后；只有标题、要求投标人自行附材料的章节（如“投标人认为需要提供的其他资料”）和格式备注中“证明材料附后”一类要求不补附件位置，这些材料由填写时的商务生成模板按条款逐项附上；
     table：规则和页码章节没有表格时新建表格的位置，at 为编制说明所在段落（表格替换该段），章节只有标题时 at 为标题段（表格插在其后）。
     id 自拟（如 p1、p2），不得与候选 id 相同；at 填段落的定位号；before、after、text 逐字照抄原文，␣ 表示一个空格，⇥ 表示制表符，⏎ 不占字符可以省略。已有候选覆盖的位置不要重复补，也不要在已有填写位置旁边再补同一项信息；要改变已有候选的处理方式（如把空单元格改为附件位），先把该候选放入 ignored_candidate_ids 再补充。每个补充位置都要作为字段写入 fields，不需要的从 positions 中删除。
   - removals：导出时去掉的原文，每项写 at 和 text（段内不唯一时加 before/after）。只去掉确定不属于投标内容的文字：已经有填写位置、填写后不应保留的填写说明和示例（如空位后的“（姓名）”），投标人不适用、填写后不应保留的备选说明，以及招标文件格式本身的编号、格式名称和格式使用说明（如表单编号、“××格式”、“以下为××格式”）。文件标题、致函对象、项目信息、承诺内容、表格注释等投标内容一律保留，拿不准时保留。去掉的文字不能与字段位置重叠；括注本身就是填写位置时用 span 作为字段，不要再去掉。
   - headings：每章导出时作为章节标题（加大纲级别和章节编号）的段落。投标模版正文的章节标题行给出了程序认定的默认标题段，正确时不用写；不对时写 {"chapter_id":"章节 id","at":"该章顶层段落的定位号"}，本章没有合适的标题段时 at 写 null，导出时按目录标题插入一段。标题段应是这张表单的名称（如“投标书”），不要把正文段落当作标题；标题段前的编号或格式文字需要去掉时写入 removals，不要把标题段整段去掉。
   - repeats：模版中按实际情况重复填写的条目（如有多个标的或多个承接企业时依次写的“1.…”“2.…”，示例写了几条不代表实际条数）。每项是一组条目，entries 按顺序写各条的段落范围 {"from":"首段定位号","to":"末段定位号"}（只有一段时省略 to），至少两条，各条的首末段落在同一层级。填写时按实际条数使用，没用到的条目导出时删除，所以这类条目不要写入 removals。表格中逐行重复的记录按清单表处理，不写 repeats。
7. fields 每项填写 candidate_id（候选或补充位置的 id）、name、subject、fill_by，以及确有必要时的 instruction 和附件的 parts：
   - 命名标准：每个字段名称必须能脱离原文单独使用，只看名称，结合资信库和招标文件就能确定唯一应填写的信息。名称由“主体 + 属性”构成，属性是要填写的具体信息。
   - subject 写该位置所描述对象（某个单位、人员、项目或文件等）的完整称谓，name 必须体现该主体。主体按就近优先判断：候选所在句子的主语和前文称谓、context 中【▢】前后的文字、group_title、table_title、chapter_name；同一表单内可沿用上文已确定的主体。suggested_name 只有属性、没有主体时不得直接采用。
   - 同一主体的同一属性全文使用相同的 name 和 subject；属性相同但主体不同时，name 必须能够区分；不同语义不得仅因标签相似而合并。
   - 一个位置要求填写多项信息时，name 写明全部属性，instruction 按原文的顺序和分隔方式规定填写格式。
   - 可重复行的清单表：同一列各行使用相同的列名作为 name，不加行号，subject 写每行记录代表的对象，程序按 table_id 和行号区分各行；键值型表格按单元格标签结合主体命名。repeats 标出的条目同样处理：各条中同一属性使用相同的 name，不加序号，subject 写每条代表的对象，程序按条区分。
   - 勾选项和择一按所选的事项命名，附件按材料命名，同样适用主体规则。
   - 日期的年、月、日分成几个空位时（如“____年__月__日”），整个日期作为一个字段：这几个候选放入 ignored_candidate_ids，用 span 补充一个位置，text 从年份前的空位起、到“日”字止（含中间的“年”“月”字样）。按日期本身命名，不加“（年）”等后缀；同一落款日期与其他位置同名。
   - 填写处前后紧接、属于所填内容本身的原文（如项目名称空位后的“项目”、单位名称空位后的“公司”），与填写处一起作为字段，使同一项信息在各处都填写完整内容、读起来通顺，不出现“项目项目”一类重复：有空位候选的，把候选放入 ignored_candidate_ids，用 span 补充一个位置，text 从空位起到这段文字止；没有空位的，用 span 覆盖这段文字，不要用 insert 插在它前面。
   - fill_by 只能是 ai、manual 或 rule。签字、签名、签章、手印、仅需盖章的位置使用 manual；可由资信库或招标文件提供的内容使用 ai，即使旁边标有盖章提示。
   - 规则和页码章节：按招标文件逐条列出的表格（如点对点应答表、偏离表、逐个评分项列页码的检索表），不论数据行是空白还是已印好内容（评分项、招标要求、序号等），各行待填的格子都按清单表规则命名、fill_by=rule，只有一行也一样，行的增减和取舍由规则和页码 Agent 按招标文件决定，同一表格中不属于逐条列出部分的行（如分项报价表首行的合计总价）照常分类；章节没有表格时，用 op=table 补充表格位置（fill_by=rule，name 写表格名称，instruction 抄写原编制说明全文）。章节其他位置照常分类，rule 只用于这两种位置。
   - 附件类候选（attachment-slot、作为字段的 attachment-note）：资信库中有对应图片栏目的材料使用 ai，其余使用 manual。资信库图片栏目：${formatCredentialImageCategories()}。
   - 一个附件位置只放一张图片。由多张图片组成的材料必须用 parts 拆分为多个连续位置，每张图片一个部分；招标文件写明数量的同类材料按数量拆分，部分名称后加“（第N份）”；未写明数量的只保留一个位置，不使用 parts。parts 至少两项，每项填写 name（可选 instruction），各部分名称不同；使用 parts 时 name 写材料总称，各部分沿用所在项的 subject。
   - attachment-note 之后已有对应附件位置（attachment-slot 或其他材料位置）时，放入 ignored_candidate_ids；否则作为附件字段。
8. 同一项内容需要填入多处时，多个候选必须使用完全相同的 name、subject、fill_by 和 instruction（拆分的附件按各部分名称判断）；同名候选的类型（文本、勾选项、择一、附件）必须一致。
9. 写完分类文件后、调用 apply-template-fields 前自检一次：把全部字段（含补充位置）按属性归组，逐组核对是否存在缺少主体的名称、主体不同却同名、主体相同却 name 或 subject 不一致的情况；同名字段还要核对各处原句：同一个值填入每一处后都应通顺，填写处前后紧接的文字会造成重复或缺字的，按第 7 步的规则调整位置。有问题先修正分类文件。
10. 调用 openxml，只传 {"action":"apply-template-fields","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}。工具会读取并校验文件中的完整分类，只检查能否执行（定位存在且唯一、位置不重叠、同名字段一致等）。调用失败时，优先根据错误用 edit 或 write 修正同一个分类文件，再提交文件路径；错误信息不足以直接修正时，才用 read 查看相关部分。文件必须始终保留完整分类，不得在调用参数里再次输出字段清单，不得只增量补交错误中列出的候选，不得使用 * 等通配符。不要直接编辑 DOCX、不要生成字段值、不要修改 ${TEMPLATE_OUTLINE_INPUT_FILE}，也不要把分类文件写到 ${TEMPLATE_FIELDS_OUTPUT_FILE}。
11. 应用成功后，通读工具写出的 投标模版效果.txt（定位号与模版正文相同），以审阅人的角度按导出后的样子逐章检查：
   - 标题段是不是这张表单的名称，有没有把正文段落当成标题；
   - 需要投标人写入的信息是否都有【】填写位置；
   - 同一项信息是否在同一处重复出现（如两个相邻的同一字段、补充的插入点紧挨已有空位）；
   - 同名字段填入同一个值后是否通顺，有没有“项目项目”一类重复的字；
   - 填写说明、示例写法和格式文字是否已经去掉，〔已去掉〕的文字是否都不属于投标内容；
   - 按实际条数重复的条目是否已用 repeats 标出（效果正文中带〔条目 …〕）。
   有问题时修改分类文件，重新调用 apply-template-fields 并再次审阅。确认无误后单独调用 openxml，只传 {"action":"confirm-template-fields"}；确认成功后程序自动结束任务，无需 task_complete，不再检查文件、重复应用或输出总结。确认前不得结束任务。`;
}

// 将模板工具绑定到当前业务工作区的原件和输出位置；抽章按已确认目录核对齐全并标记是否自动填写。
function buildOpenXmlToolOptions(workspaceStore, openXmlHelperService, onStep, items) {
  return {
    openXmlHelperService,
    onStep,
    templateChapters: items,
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
  items,
  signal,
  onActivity,
  onCheckpoint,
  onStep,
  reextraction = false,
}) {
  const sourcePaths = workspaceStore.listTenderSourceDocxRelativePaths();
  if (!sourcePaths.length) {
    return { status: 'skipped', field_count: 0 };
  }

  const result = await agentService.runTask({
    task_id: taskId,
    title: '投标模版提取',
    summary_enabled: false,
    // 模版和字段清单由工具校验并落盘、Agent 审阅效果正文并确认成功后结束，不依赖模型主动标记完成。
    is_final_tool_call: (call) => call.name === 'openxml' && call.arguments?.action === CONFIRM_TEMPLATE_FIELDS_ACTION,
    prompt: createTemplateExtractionPrompt(sourcePaths, { reextraction }),
    output_file: TEMPLATE_FIELDS_OUTPUT_FILE,
    prepare_output_files: [TEMPLATE_CLASSIFICATION_FILE],
    files: [{
      path: TEMPLATE_OUTLINE_INPUT_FILE,
      content: JSON.stringify({ items }, null, 2),
    }],
    signal,
    persistent_task: {
      task_key: TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'template-extraction',
    initial_stage_index: 0,
    active_tools: TEMPLATE_EXTRACTION_TOOLS,
    open_xml_tool: buildOpenXmlToolOptions(workspaceStore, openXmlHelperService, onStep, items),
    max_retries: 1,
    onActivity,
    onCheckpoint,
    buildRetryPrompt(request) {
      if (request.kind === 'execution') return null;
      return `请保留当前工作区已有结果，只修复本次提交报告中的问题。必须在当前工作目录根目录中将完整分类写入 ${TEMPLATE_CLASSIFICATION_FILE}，不得改名或另存到其他目录；空文件首次用 write 填充，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。已有内容用 edit 或 write 修复。全部分类写完后调用 openxml，参数为 {"action":"apply-template-fields","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}，由工具生成 bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE}，不得手工写入最终 Word 或字段清单；审阅 投标模版效果.txt 无误后调用 {"action":"confirm-template-fields"} 结束。`;
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
