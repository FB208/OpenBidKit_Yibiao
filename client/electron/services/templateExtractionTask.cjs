const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const {
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const {
  AGENT_BLOCKS_FILE,
  AGENT_FIELD_CANDIDATES_FILE,
  AGENT_TEMPLATE_PREVIEW_FILE,
  AGENT_TEMPLATE_TEXT_FILE,
  APPLY_TEMPLATE_FIELDS_ACTION,
  CONFIRM_TEMPLATE_FIELDS_ACTION,
  EXTRACT_CHAPTERS_ACTION,
  LIST_BLOCKS_ACTION,
  TEMPLATE_FIELD_CLASSIFICATION_SCHEMA,
  applyTemplateClassification,
  extractTemplateChapters,
  readTenderBlockOutline,
  scanTemplateFields,
} = require('./pi/piOpenXmlTool.cjs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const { CREDENTIAL_IMAGE_FIELD_KEYS, CREDENTIAL_IMAGE_FIELD_LABELS } = require('./credentialLibraryService.cjs');

const TEMPLATE_FIELDS_OUTPUT_FILE = 'bid-template-fields.json';
const TEMPLATE_FIELDS_VERSION = 2;
const TEMPLATE_OUTLINE_INPUT_FILE = '已确认模板目录.json';
const TEMPLATE_CLASSIFICATION_FILE = '投标模版字段分类.json';
const GROUP_TEMPLATE_TEXT_FILE = '本组模版正文.txt';
const RESPONSE_REQUIREMENTS_FILE = '响应文件要求.md';
const PROJECT_OVERVIEW_FILE = '项目概述.md';
const LOCATE_NOTE_FILE = '抽章说明.md';
const GROUP_OUTPUT_DIR = 'bid-template-groups';
// 每组的目标候选数：按目录顺序把相邻章节装进一组，一章不拆；组数不超过文本模型并发上限。
const GROUP_CANDIDATE_TARGET = 35;
const TEMPLATE_STEP_TOTAL = 3;
// 原生工具由公共层统一开放；业务工具只开放 openxml 和报告失败。
const TEMPLATE_AGENT_TOOLS = [...NATIVE_AGENT_TOOLS, 'openxml', 'report-failure'];
const ajv = new Ajv({ allErrors: true, strict: true });
const validateClassification = ajv.compile(TEMPLATE_FIELD_CLASSIFICATION_SCHEMA);

const CREDENTIAL_IMAGE_OWNER_LABELS = { profile: '企业资料', certificate: '资质证书', employee: '员工', project: '业绩', other: '其他资料' };
const WORK_RULE = '请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。';

// 附件可推荐范围取自资信库实际支持的图片栏目，不在提示词中写死。
function formatCredentialImageCategories() {
  return Object.entries(CREDENTIAL_IMAGE_FIELD_KEYS)
    .map(([owner, keys]) => `${CREDENTIAL_IMAGE_OWNER_LABELS[owner] || owner}（${[...keys].map((key) => CREDENTIAL_IMAGE_FIELD_LABELS[key] || key).join('、')}）`)
    .join('；');
}

// ---------------------------------------------------------------------------
// 提示词：单 Agent 和分组共用同一份分类规则，只在负责范围和产物上不同；统稿清单沿用同一命名标准。
// ---------------------------------------------------------------------------

function createGoalText() {
  return `目标：导出后每一章都是投标人可以直接提交的表单——需要投标人写入信息的地方都有填写位置；提示投标人怎么填的说明、示例写法和招标文件格式本身的文字（表单编号、格式名称、格式使用说明）在导出时不残留；其余原文保持不动。程序只负责定位和执行，哪里要填、什么要去掉、哪一段是标题都由你按含义判断，不依赖具体措辞。删掉有用的内容比留下多余文字更不能接受，拿不准时保留原文。

字段用途：后续由程序从企业资信库和招标文件信息自动填写 fill_by=ai 的字段，附件从资信库图片中选择；fill_by=manual 只用于签字、签名、手印、仅需盖章的位置和资信库中没有的附件材料，由用户人工处理。需要写本投标文件某部分所在页码的位置（如“该声明函见投标文件第__页”）也作为字段，fill_by=ai，填写时由程序生成页码。auto_fill=false 的目录由用户人工填写，程序写入字段时会把这些章节中的字段统一改为 manual（与自动填写章节同名的字段沿用程序填写），分类时仍按位置语义命名，fill_by 按常规规则填写即可。rule_page=true 的目录是规则和页码章节，其中按招标文件逐条列出的表格由规则和页码 Agent 按招标文件逐项编制行内容。`;
}

function createMaterialsText({ files, grouped }) {
  const names = new Set(files.map((item) => item.path));
  return [
    `- ${TEMPLATE_OUTLINE_INPUT_FILE}：用户已确认、需要抽进投标模版的全部目录（path 是从一级目录到本目录的标题链，auto_fill 表示字段是否自动填写，rule_page 表示规则和页码章节）。`,
    `- ${AGENT_TEMPLATE_TEXT_FILE}：程序已按这些目录抽章并扫描出的完整模版正文${grouped ? '，供理解上下文' : ''}。`,
    ...(grouped ? [`- ${GROUP_TEMPLATE_TEXT_FILE}：本组章节的模版正文。`] : []),
    `- ${AGENT_FIELD_CANDIDATES_FILE}：程序按版式识别出的${grouped ? '本组' : '全部'}候选。`,
    ...(names.has(RESPONSE_REQUIREMENTS_FILE) ? [`- ${RESPONSE_REQUIREMENTS_FILE}：招标文件对响应文件的要求，判断要附哪些材料、哪些是格式说明时参考。`] : []),
    ...(names.has(PROJECT_OVERVIEW_FILE) ? [`- ${PROJECT_OVERVIEW_FILE}：项目概述，理解背景和术语时参考。`] : []),
  ].join('\n');
}

function createTemplateTextGuide() {
  return `模版正文和候选的读法：
   - 模版正文每行一个段落“定位号  文字”，〔c_…〕标出候选（下划线、占位符、标签后空位、空单元格、勾选项、附件位置等），␣ 表示连续空格中的一个空格，⇥ 表示制表符，⏎ 表示段内换行或分页（不占字符），〔不可标记〕的段落不能补充位置或去掉文字；每章标题行给出章节 id 和程序按目录标题认定的默认标题段。必须通读负责的全部章节，按含义理解每张表单。
   - 候选的 context 中【▢…】标出准确位置，表格候选按网格列列出同行内容，【▢第N列】是当前单元格；suggested_name、suggested_fill_by 是程序的建议，可按语义修正；table_id、row_number、column_number 标明表格候选的行列；chapter_id 是所在章节。
   - kind=checkbox-group 是一组勾选项，options 为选项文字；kind=attachment-slot 是放置附件材料的位置；kind=attachment-note 是“后附/附：…复印件”一类说明，作为字段时程序会在其后插入附件位置。`;
}

function createBoundaryRule() {
  return `候选必须全部来自已确认目录对应的章节。如果候选上下文明显属于未选择的表单或后续附件，说明抽章边界错误：在分类文件的 boundary_issues 中写明章节 id 和问题，这些候选放入 ignored_candidate_ids，其余照常分类，程序会修正边界后重新分类；不得不写 boundary_issues 就把这些候选批量忽略来掩盖范围错误。`;
}

// 分类文件的结构、补充位置、去掉的原文、标题段、条目和字段命名规则；序号由调用方给出。
function createClassificationRules(first) {
  const n = (offset) => first + offset;
  return `${n(0)}. 写分类文件 ${TEMPLATE_CLASSIFICATION_FILE}：顶层包含 fields 和 ignored_candidate_ids 数组，以及可选的 positions、removals、headings、repeats 和 boundary_issues 数组；内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。
   - 候选：每个候选必须且只能归入某个字段的 candidate_ids 或 ignored_candidate_ids。真实待填位置写进字段；扫描误判或无需填写的放入 ignored_candidate_ids。
   - positions：程序没有标出、但投标人需要写入信息的地方由你补充。op 取以下之一：
     insert：模版里没有空位或空位残缺（如标签后直接接单位、右括号或句号，日期只剩“年月日”），before、after 写插入点两侧紧邻的原文，至少写一个，使插入点在该段唯一；
     span：一段原文本身就是要替换成填写值的位置（如示例写法、整个括注都是在告诉投标人此处写什么、只有普通空格的空位），text 为这段原文，在该段不唯一时加 before/after 区分；
     choose：要求投标人从几个并列备选中只选一项，text 覆盖全部备选，options 逐项照抄原文中的备选；并列列举的多个事项不是择一；
     attachment：放置证件、证书等材料图片、但没有附件位置的地方（如单元格里只写着材料名称），at 为写着材料名称的段落，附件位置放在该段之后；只有标题、要求投标人自行附材料的章节（如“投标人认为需要提供的其他资料”）和格式备注中“证明材料附后”一类要求不补附件位置，这些材料由填写时的商务生成模板按条款逐项附上；
     table：规则和页码章节没有表格时新建表格的位置，at 为编制说明所在段落（表格替换该段），章节只有标题时 at 为标题段（表格插在其后）。
     id 自拟（如 p1、p2），不得与候选 id 相同；at 填段落的定位号；before、after、text 照抄原文文字，其中连续的空格（␣）或下划线（_、＿）不论多少个都只写一个，程序按整段空白或整段下划线匹配，不要数个数；⇥ 表示制表符，⏎ 不占字符可以省略。已有候选覆盖的位置不要重复补，也不要在已有填写位置旁边再补同一项信息；要改变已有候选的处理方式（如把空单元格改为附件位），先把该候选放入 ignored_candidate_ids 再补充。每个补充位置都要写进某个字段的 candidate_ids，不需要的从 positions 中删除。
   - removals：导出时去掉的原文，每项写 at 和 text（段内不唯一时加 before/after）。只去掉确定不属于投标内容的文字：已经有填写位置、填写后不应保留的填写说明和示例（如空位后的“（姓名）”），投标人不适用、填写后不应保留的备选说明，以及招标文件格式本身的编号、格式名称和格式使用说明（如表单编号、“××格式”、“以下为××格式”）。文件标题、致函对象、项目信息、承诺内容、表格注释等投标内容一律保留，拿不准时保留。去掉的文字不能与字段位置重叠；括注本身就是填写位置时用 span 作为字段，不要再去掉。
   - headings：每章导出时作为章节标题（加大纲级别和章节编号）的段落。投标模版正文的章节标题行给出了程序认定的默认标题段，正确时不用写；不对时写 {"chapter_id":"章节 id","at":"该章顶层段落的定位号"}，本章没有合适的标题段时 at 写 null，导出时按目录标题插入一段。标题段应是这张表单的名称（如“投标书”），不要把正文段落当作标题；标题段前的编号或格式文字需要去掉时写入 removals，不要把标题段整段去掉。
   - repeats：模版中按实际情况重复填写的条目（如有多个标的或多个承接企业时依次写的“1.…”“2.…”，示例写了几条不代表实际条数）。每项是一组条目，entries 按顺序写各条的段落范围 {"from":"首段定位号","to":"末段定位号"}（只有一段时省略 to），至少两条，各条的首末段落在同一层级。填写时按实际条数使用，没用到的条目导出时删除，所以这类条目不要写入 removals。表格中逐行重复的记录按清单表处理，不写 repeats。
${n(1)}. fields 每项是一个字段，填写 name、subject、fill_by 和 candidate_ids（该字段全部位置的候选或补充位置 id），以及确有必要时的 instruction 和附件的 parts；同一字段只写一项，字段名在分类文件中唯一：
   - 命名标准：每个字段名称必须能脱离原文单独使用，只看名称，结合资信库和招标文件就能确定唯一应填写的信息。名称由“主体 + 属性”构成，属性是要填写的具体信息。
   - subject 写该位置所描述对象（某个单位、人员、项目或文件等）的完整称谓，name 必须体现该主体。主体按就近优先判断：候选所在句子的主语和前文称谓、context 中【▢】前后的文字、group_title、table_title、chapter_name；同一表单内可沿用上文已确定的主体。suggested_name 只有属性、没有主体时不得直接采用。
   - 同一主体的同一属性全文使用同一个字段；属性相同但主体不同时，name 必须能够区分；不同语义不得仅因标签相似而合并。
   - 一个位置要求填写多项信息时，name 写明全部属性，instruction 按原文的顺序和分隔方式规定填写格式。
   - 可重复行的清单表：同一列各行是同一个字段，name 用列名，不加行号，subject 写每行记录代表的对象，程序按 table_id 和行号区分各行；键值型表格按单元格标签结合主体命名。repeats 标出的条目同样处理：各条中同一属性是同一个字段，不加序号，subject 写每条代表的对象，程序按条区分。
   - 勾选项和择一按所选的事项命名，附件按材料命名，同样适用主体规则。
   - 日期的年、月、日分成几个空位时（如“____年__月__日”），整个日期作为一个字段：这几个候选放入 ignored_candidate_ids，用 span 补充一个位置，text 从年份前的空位起、到“日”字止（含中间的“年”“月”字样，如“␣年␣月␣日”或“_年_月_日”）。按日期本身命名，不加“（年）”等后缀；同一落款日期与其他位置同名。
   - 填写处前后紧接、属于所填内容本身的原文（如项目名称空位后的“项目”、单位名称空位后的“公司”），与填写处一起作为字段，使同一项信息在各处都填写完整内容、读起来通顺，不出现“项目项目”一类重复：有空位候选的，把候选放入 ignored_candidate_ids，用 span 补充一个位置，text 从空位起到这段文字止（如“␣项目”“_公司”）；没有空位的，用 span 覆盖这段文字，不要用 insert 插在它前面。
   - fill_by 只能是 ai、manual 或 rule。签字、签名、签章、手印、仅需盖章的位置使用 manual；可由资信库或招标文件提供的内容使用 ai，即使旁边标有盖章提示。
   - 规则和页码章节：按招标文件逐条列出的表格（如点对点应答表、偏离表、逐个评分项列页码的检索表），不论数据行是空白还是已印好内容（评分项、招标要求、序号等），各行待填的格子都按清单表规则命名、fill_by=rule，只有一行也一样，行的增减和取舍由规则和页码 Agent 按招标文件决定，同一表格中不属于逐条列出部分的行（如分项报价表首行的合计总价）照常分类；章节没有表格时，用 op=table 补充表格位置（fill_by=rule，name 写表格名称，instruction 抄写原编制说明全文）。章节其他位置照常分类，rule 只用于这两种位置。
   - 附件类候选（attachment-slot、作为字段的 attachment-note）：资信库中有对应图片栏目的材料使用 ai，其余使用 manual。资信库图片栏目：${formatCredentialImageCategories()}。
   - 一个附件位置只放一张图片。由多张图片组成的材料必须用 parts 拆分为多个连续位置，每张图片一个部分；招标文件写明数量的同类材料按数量拆分，部分名称后加“（第N份）”；未写明数量的只保留一个位置，不使用 parts。parts 至少两项，每项填写 name（可选 instruction），各部分名称不同；使用 parts 时 name 写材料总称，各部分沿用所在项的 subject。
   - attachment-note 之后已有对应附件位置（attachment-slot 或其他材料位置）时，放入 ignored_candidate_ids；否则作为附件字段。
${n(2)}. 同一项内容需要填入多处时，把这些位置都写进该字段的 candidate_ids，不要拆成同名的多项；同一字段各位置的类型（文本、勾选项、择一、附件）必须一致，拆分的附件按各部分名称判断。
${n(3)}. 写完分类文件后、调用 apply-template-fields 前自检一次：逐个字段核对是否存在缺少主体的名称、主体不同却合成一个字段、同一主体同一属性却拆成不同名称的情况；每个字段还要核对各处原句：同一个值填入每一处后都应通顺，填写处前后紧接的文字会造成重复或缺字的，按第 ${n(1)} 步的规则调整位置。有问题先修正分类文件。`;
}

function createApplyRule(index, scoped) {
  return `${index}. 调用 openxml，只传 {"action":"${APPLY_TEMPLATE_FIELDS_ACTION}","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}。工具会读取并校验文件中的${scoped ? '本组' : '完整'}分类，只检查能否执行（定位存在且唯一、位置不重叠、同名字段一致等）。调用失败时，优先根据错误用 edit 或 write 修正同一个分类文件，再提交文件路径；错误信息不足以直接修正时，才用 read 查看相关部分。文件必须始终保留${scoped ? '本组的' : ''}完整分类，不得在调用参数里再次输出字段清单，不得只增量补交错误中列出的候选，不得使用 * 等通配符。不要直接编辑 DOCX、不要生成字段值、不要修改 ${TEMPLATE_OUTLINE_INPUT_FILE}，也不要把分类文件写到 ${TEMPLATE_FIELDS_OUTPUT_FILE}。`;
}

function createReviewRule(index, focus = '') {
  return `${index}. 应用成功后，通读工具写出的 ${AGENT_TEMPLATE_PREVIEW_FILE}（定位号与模版正文相同），以审阅人的角度按导出后的样子逐章检查${focus}：
   - 标题段是不是这张表单的名称，有没有把正文段落当成标题；
   - 需要投标人写入的信息是否都有【】填写位置；
   - 同一项信息是否在同一处重复出现（如两个相邻的同一字段、补充的插入点紧挨已有空位）；
   - 同名字段填入同一个值后是否通顺，有没有“项目项目”一类重复的字；
   - 填写说明、示例写法和格式文字是否已经去掉，〔已去掉〕的文字是否都不属于投标内容；
   - 按实际条数重复的条目是否已用 repeats 标出（效果正文中带〔条目 …〕）。
   有问题时修改分类文件，重新调用 apply-template-fields 并再次审阅。确认无误后单独调用 openxml，只传 {"action":"${CONFIRM_TEMPLATE_FIELDS_ACTION}"}；确认成功后程序自动结束任务，无需 task_complete，不再检查文件、重复应用或输出总结。确认前不得结束任务。`;
}

function formatChapterList(chapters) {
  return chapters.map((item) => `- ${item.title}（id：${item.id}${item.auto_fill === false ? '，人工填写' : ''}${item.rule_page ? '，规则和页码' : ''}）`).join('\n');
}

/** 单个 Agent 处理全部章节：分类、写入 Word、审阅并确认，与分组前的做法一致。 */
function createSinglePrompt({ files, templateText, candidateJson }) {
  return `${WORK_RULE}

任务：程序已按用户确认的目录从招标 Word 原件抽取投标模版并扫描出候选。你识别模版中需要填写的位置，写分类文件，由工具写入 Word 内容控件和字段清单。本任务只分类和标记，不生成任何字段值，也不填写模版。

${createGoalText()}

工作区材料：
${createMaterialsText({ files, grouped: false })}

必须完成的产物：当前工作目录根目录中的 ${TEMPLATE_CLASSIFICATION_FILE}、bid-template.docx 和 ${TEMPLATE_FIELDS_OUTPUT_FILE}。程序已预建空的分类文件；空文件不算完成，首次填充必须使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。必须使用上述精确文件名，不得改名、移到子目录或仅在回复中输出。分类文件由你填写，最终 Word 和字段清单必须由 openxml 的 apply-template-fields 生成，不得手工写入；审阅效果正文后调用 confirm-template-fields 确认，任务才会结束。

必须按以下顺序执行：
1. 通读本提示词末尾的投标模版正文和候选（与工作区 ${AGENT_TEMPLATE_TEXT_FILE}、${AGENT_FIELD_CANDIDATES_FILE} 相同，不必再读），按含义理解每张表单。
   ${createTemplateTextGuide()}
2. ${createBoundaryRule()}
${createClassificationRules(3)}
${createApplyRule(7, false)}
${createReviewRule(8)}

投标模版正文：
${templateText}

候选：
${candidateJson}`;
}

/** 分组子会话：只为本组章节分类，按本组范围试应用并审阅本组效果正文后确认，最终写入由统稿完成。 */
function createGroupPrompt({ files, group, groupCount, chapterCount, templateText, candidateJson }) {
  return `${WORK_RULE}

任务：程序已按用户确认的目录从招标 Word 原件抽取投标模版并扫描出候选。模版共 ${chapterCount} 章，按章节分给 ${groupCount} 个分组同时处理，你负责第 ${group.index}/${groupCount} 组，只为以下章节识别需要填写的位置并写分类文件：
${formatChapterList(group.chapters)}
其他章节由别的分组负责，不要为它们分类、补充位置、去掉文字或指定标题段；完整的 ${AGENT_TEMPLATE_TEXT_FILE} 只供你理解上下文和其他章节对同一主体的称谓。各组完成后由统稿统一跨章的字段命名并写入 Word，字段名照常按命名标准写。本任务只分类和标记，不生成任何字段值，也不填写模版。

${createGoalText()}

工作区材料：
${createMaterialsText({ files, grouped: true })}

必须完成的产物：当前工作目录根目录中只含本组章节的 ${TEMPLATE_CLASSIFICATION_FILE}。程序已预建空文件；空文件不算完成，首次填充必须使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。apply-template-fields 只按本组章节校验分类并写出本组的 ${AGENT_TEMPLATE_PREVIEW_FILE}，不生成最终 Word；审阅后调用 confirm-template-fields 确认，任务才会结束。

必须按以下顺序执行：
1. 通读本提示词末尾的本组模版正文和本组候选（与工作区 ${GROUP_TEMPLATE_TEXT_FILE}、${AGENT_FIELD_CANDIDATES_FILE} 相同，不必再读），按含义理解每张表单。
   ${createTemplateTextGuide()}
2. ${createBoundaryRule()}
${createClassificationRules(3)}
${createApplyRule(7, true)}
${createReviewRule(8)}

本组模版正文：
${templateText}

本组候选：
${candidateJson}`;
}

/**
 * 统稿清单：各组看不到彼此的命名，由模型按命名标准给出跨章合并和改名的清单，程序据此修改分类并写入 Word。
 * 各组已审阅本组章节的补充位置、去掉的原文、标题段和条目，统稿只处理字段命名。
 */
function createNamingPrompt({ groupCount, chapterCount, fieldListJson, conflicts, templateText }) {
  const hasConflicts = conflicts.length > 0;
  const conflictText = hasConflicts
    ? `\n以下字段名在不同分组中的类型、主体、填写方式、说明或附件拆分不同，程序已把后出现的改名为“原名〔第N组〕”。每个带“〔第N组〕”的字段都必须写进统稿清单，处理后不得保留组号：与原名字段是同一信息的，改回原名（程序会把同名字段合成一个），需要统一主体或说明时一并写出；不是同一信息的，改用能区分的名称。结合模版正文的原句判断，仍拿不准就不合成，改用能区分的名称：\n${conflicts.map((item) => `- ${item.name}：${item.renamed.join('、')}`).join('\n')}\n`
    : '';
  return `任务：统一投标模版字段的跨章命名。模版共 ${chapterCount} 章，已按章节分成 ${groupCount} 组分别分类，各组看不到彼此的命名。下面是程序合并后的字段清单，每行一个字段，含名称、主体、填写方式、说明、类型、所在章节、位置数和原句。你只输出一份统稿清单，由程序据此修改分类并写入 Word；不生成任何字段值。

字段用途：后续由程序从企业资信库和招标文件信息自动填写 fill_by=ai 的字段；fill_by=manual 只用于签字、签名、手印、仅需盖章的位置和资信库中没有的附件材料；fill_by=rule 是规则和页码章节中按招标文件逐条编制的表格。

字段命名标准（与各组相同）：
   - 每个字段名称必须能脱离原文单独使用，只看名称，结合资信库和招标文件就能确定唯一应填写的信息。名称由“主体 + 属性”构成，subject 写所描述对象的完整称谓，name 必须体现该主体。
   - 同一主体的同一属性全文使用同一个字段；属性相同但主体不同时，name 必须能够区分；不同语义不得仅因标签相似而合并。
   - 同一字段各位置的类型（文本、勾选项、择一、附件）必须一致；同一落款日期全文同名。
${conflictText}
要做的：按命名标准找出跨章的不一致——同一主体同一属性却用了不同名称或不同主体称谓（如同一投标人一处叫“投标人”一处叫“供应商”）、不同信息却合成了一个字段${hasConflicts ? '，以及上面列出的冲突' : ''}。${hasConflicts ? '其他字段' : ''}拿不准是不是同一信息时，结合末尾模版正文中的原句判断，仍拿不准就保持原样、不写进清单${hasConflicts ? '；上面列出的冲突不能保持原样' : ''}。

输出：只输出一个 JSON 对象，不要其他文字：
{"changes":[{"from":["清单中的字段名"],"name":"处理后的名称","subject":"处理后的主体","fill_by":"ai","instruction":"处理后的说明"}]}
   - 每项把 from 中的字段合成一个字段；from 只有一个名称时就是改名或改主体、填写方式、说明。from 照抄清单中的字段名，每个字段名最多出现在一项中。
   - name 必填；subject、fill_by、instruction 省略时沿用原字段的写法（合成时取第一个有值的），需要改时写出处理后的取值。
   - 不需要改的字段不要写。处理后同名的字段由程序合成为一个字段，所以只有同一信息才能用同一名称，不同信息的名称必须能区分；填写方式不同的字段要合成时，写在同一项的 from 中并写明 fill_by。
   - 类型不同或附件拆分（parts）不同的字段不要合成，也不要改成同一名称。

字段清单：
${fieldListJson}

模版正文（拿不准时核对原句用）：
${templateText}`;
}

/** 条目缺原文位置或分类发现边界错误时，由 Agent 按原文结构定位并抽章。 */
function createLocatePrompt({ issues, files }) {
  const issueText = issues.length
    ? `\n上次抽取后，分类时发现以下章节的边界有误：\n${issues.map((item) => `- ${item.chapter_id}：${item.problem}`).join('\n')}\n请在原文结构中核对这些章节的真实范围，修正边界后按全部目录重新抽取；其他章节沿用原来的位置。\n`
    : '';
  return `${WORK_RULE}

任务：根据用户已确认的目录，从招标 Word 原件抽取投标模版章节。本任务只抽章，不识别字段，抽章成功后程序继续识别和分类。
${issueText}
工作区材料：
- ${TEMPLATE_OUTLINE_INPUT_FILE}：需要抽进投标模版的全部目录（path 是从一级目录到本目录的标题链），本任务必须只以该文件作为抽取范围依据，每个目录都要抽取，不得遗漏或增加。
- ${AGENT_BLOCKS_FILE}：程序生成的招标原文结构，每行一个非空原文块，格式为“块号 [标记] 文本”；[标题N] 表示可用 sourceTitle 定位的原文标题，空块已省略但块号保持原值。按块号用 read 定点读取需要核对的部分；只有该文件缺失时才调用一次 openxml，action=${LIST_BLOCKS_ACTION} 重新生成。
${files.some((item) => item.path === RESPONSE_REQUIREMENTS_FILE) ? `- ${RESPONSE_REQUIREMENTS_FILE}：招标文件对响应文件的要求。\n` : ''}
调用一次 openxml，action=${EXTRACT_CHAPTERS_ACTION}，每个目录抽取一章，按 items 顺序排列，id 填该目录的 id，title 使用目录标题；程序会按 id 核对是否齐全并标记是否自动填写。目录带 source 时，以 source.start 作为 startBlock、source.end 作为 endBlock（不包含在本章内），有 source.source 时填入该章的 source。目录没有 source 时，在原文结构中找到真实章节位置和完整边界：带 [标题N] 标记的原文标题可提供 sourceTitle；没有该标记时必须提供标题所在的 startBlock 和下一同级章节或附件开始位置 endBlock，endBlock 不包含在本章内；不得把两个已选目录之间的其他表单，或最后一个已选目录之后的文档尾部一并抽入；多份原件时填写 source。抽章成功后程序自动结束任务。`;
}

// ---------------------------------------------------------------------------
// 程序步骤：抽章、分组、合并和字段清单。
// ---------------------------------------------------------------------------

/** 已确认目录全部带 Word 原文位置时可直接按位置抽章。 */
function hasAllSources(items) {
  return items.every((item) => Number.isFinite(Number(item.source?.start)) && Number.isFinite(Number(item.source?.end)));
}

function chaptersFromItems(items) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    startBlock: Number(item.source.start),
    endBlock: Number(item.source.end),
    ...(item.source.source ? { source: item.source.source } : {}),
  }));
}

/**
 * 按目录顺序把相邻章节装进分组，一章不拆：组数取候选总数按目标数折算、章节数和并发上限中的最小值，
 * 每章至少按 1 计（没有候选的章节也要审阅标题段），装到接近平均负载时另起一组。
 */
function splitTemplateGroups(items, candidates, maxGroups) {
  const weights = new Map(items.map((item) => [item.id, 1]));
  for (const candidate of candidates) {
    if (weights.has(candidate.chapter_id)) weights.set(candidate.chapter_id, weights.get(candidate.chapter_id) + 1);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  const groupCount = Math.max(1, Math.min(Math.floor(maxGroups) || 1, items.length, Math.ceil(total / GROUP_CANDIDATE_TARGET)));
  if (groupCount === 1) return [items];
  const target = total / groupCount;
  const groups = [];
  let current = [];
  let load = 0;
  for (const item of items) {
    const weight = weights.get(item.id);
    // 加入本章后超出平均负载的部分多于还差的部分时，本章放到下一组。
    if (current.length && groups.length < groupCount - 1 && load + weight - target > target - load) {
      groups.push(current);
      current = [];
      load = 0;
    }
    current.push(item);
    load += weight;
  }
  groups.push(current);
  return groups;
}

/** 按章节标题行切分模版正文：开头说明、各章文字，以及段落定位号所在章节。 */
function splitTemplateText(templateText) {
  const header = [];
  const chapters = new Map();
  const locatorChapters = new Map();
  let current = null;
  for (const line of String(templateText || '').split('\n')) {
    const heading = line.match(/^【章节 ([^：】]+)：/);
    if (heading) {
      current = heading[1];
      chapters.set(current, [line]);
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    chapters.get(current).push(line);
    const locator = line.match(/^(\S+) {2}/);
    if (locator) locatorChapters.set(locator[1], current);
  }
  return { header: header.join('\n'), chapters, locatorChapters };
}

function sliceTemplateText(parts, chapterIds) {
  return [parts.header, ...chapterIds.map((id) => (parts.chapters.get(id) || []).join('\n'))].join('\n');
}

function sliceCandidates(candidateData, chapterIds) {
  const scope = new Set(chapterIds);
  const candidates = candidateData.candidates.filter((item) => scope.has(item.chapter_id));
  const contextIds = new Set(candidates.map((item) => item.context_id).filter(Boolean));
  return {
    ...candidateData,
    contexts: (candidateData.contexts || []).filter((item) => contextIds.has(item.context_id)),
    candidates,
  };
}

const CANDIDATE_KIND_LABELS = {
  'checkbox-group': '勾选',
  'attachment-slot': '附件',
  'attachment-note': '附件',
};
const POSITION_KIND_LABELS = { choose: '择一', attachment: '附件', table: '规则表' };

/** 一个位置的类型：候选按版式类型，补充位置按 op；同一字段各位置的类型须一致。 */
function locationKind(candidate, position) {
  return candidate ? CANDIDATE_KIND_LABELS[candidate.kind] || '文字' : POSITION_KIND_LABELS[position?.op] || '文字';
}

function fieldIdentity(field, kind) {
  return JSON.stringify([kind, field.subject, field.fill_by, field.instruction || '', field.parts || []]);
}

/**
 * 合并各组分类：补充位置 id 加组前缀；同名字段与已有某种写法的类型、主体、填写方式、说明和附件拆分都相同时
 * 并入该写法（不论来自哪一组，组内按章各写的同名同属性多项也在此合成），都不同时把后出现的改名为“原名〔第N组〕”
 * 并列为冲突，由统稿处理；改名保证合并后字段名不重复。各组已按本组校验，组内同一字段各位置类型一致，
 * 字段类型取第一个位置。
 */
function mergeGroupClassifications(fragments, candidateData) {
  const candidates = new Map(candidateData.candidates.map((item) => [item.candidate_id, item]));
  const fields = [];
  const variants = new Map();
  const conflicts = new Map();
  const merged = { fields, ignored_candidate_ids: [], positions: [], removals: [], headings: [], repeats: [] };
  for (const { index, classification } of fragments) {
    const prefix = `g${index}-`;
    const groupPositions = new Map((classification.positions || []).map((item) => [item.id, item]));
    const mapId = (id) => (groupPositions.has(id) ? `${prefix}${id}` : id);
    merged.positions.push(...(classification.positions || []).map((item) => ({ ...item, id: `${prefix}${item.id}` })));
    merged.ignored_candidate_ids.push(...(classification.ignored_candidate_ids || []).map(mapId));
    merged.removals.push(...(classification.removals || []));
    merged.headings.push(...(classification.headings || []));
    merged.repeats.push(...(classification.repeats || []));
    for (const field of classification.fields || []) {
      const next = { ...field, candidate_ids: field.candidate_ids.map(mapId) };
      const [firstId] = field.candidate_ids;
      const identity = fieldIdentity(next, locationKind(candidates.get(firstId), groupPositions.get(firstId)));
      if (!variants.has(field.name)) variants.set(field.name, []);
      const list = variants.get(field.name);
      const same = list.find((item) => item.identity === identity);
      if (same) {
        same.field.candidate_ids.push(...next.candidate_ids);
        continue;
      }
      let name = field.name;
      if (list.length) {
        const taken = new Set(list.map((item) => item.field.name));
        name = `${field.name}〔第${index}组〕`;
        for (let n = 2; taken.has(name); n += 1) name = `${field.name}〔第${index}组之${n}〕`;
        if (!conflicts.has(field.name)) conflicts.set(field.name, []);
        conflicts.get(field.name).push(name);
      }
      const entry = { ...next, name };
      list.push({ identity, field: entry });
      fields.push(entry);
    }
  }
  return {
    classification: merged,
    conflicts: [...conflicts.entries()].map(([name, renamed]) => ({ name, renamed })),
  };
}

/** 统稿用的紧凑字段清单：每个字段名一项，带类型、所在章节、位置数和最多两条原句。 */
function buildFieldList(classification, candidateData, textParts, items) {
  const candidates = new Map(candidateData.candidates.map((item) => [item.candidate_id, item]));
  const positions = new Map(classification.positions.map((item) => [item.id, item]));
  const titles = new Map(items.map((item) => [item.id, item.title]));
  return classification.fields.map((field) => {
    const kinds = new Set();
    const chapters = new Set();
    const contexts = [];
    for (const id of field.candidate_ids) {
      const candidate = candidates.get(id);
      const position = positions.get(id);
      const chapterId = candidate?.chapter_id || (position ? textParts.locatorChapters.get(position.at) : '');
      if (chapterId) chapters.add(titles.get(chapterId) || chapterId);
      kinds.add(locationKind(candidate, position));
      const context = candidate?.context || (position ? `补充位置 ${position.at}：${position.text || [position.before, position.after].filter(Boolean).join('…')}` : '');
      if (context && contexts.length < 2 && !contexts.includes(context)) contexts.push(context);
    }
    return {
      name: field.name,
      subject: field.subject,
      fill_by: field.fill_by,
      ...(field.instruction ? { instruction: field.instruction } : {}),
      ...(field.parts ? { parts: field.parts.map((part) => part.name) } : {}),
      kind: [...kinds].join('、'),
      chapters: [...chapters],
      count: field.candidate_ids.length,
      contexts,
    };
  });
}

const FILL_BY_VALUES = new Set(['ai', 'manual', 'rule']);

/**
 * 按统稿清单修改合并后的分类：from 中的字段依次并到第一个字段，再写入处理后的名称、主体、填写方式和说明；
 * 处理后同名的字段由程序合成，主体和说明取统稿写明的值，没写时沿用先出现的字段。
 * 只检查能否执行（字段存在、不重复引用、没有残留组号、合成的类型、附件拆分和填写方式一致、取值有效），
 * 是不是同一信息由模型判断。
 */
function applyNamingPlan(classification, plan, fieldList) {
  const errors = [];
  if (!Array.isArray(plan?.changes)) {
    return { classification, errors: ['统稿清单顶层必须是 {"changes":[...]}'] };
  }
  const kinds = new Map(fieldList.map((item) => [item.name, item.kind]));
  const fields = classification.fields.map((item) => ({ ...item, candidate_ids: [...item.candidate_ids] }));
  const byName = new Map(fields.map((item) => [item.name, item]));
  const kindOf = new Map(fields.map((item) => [item, kinds.get(item.name)]));
  const written = new Map();
  const referenced = new Set();
  const removed = new Set();
  plan.changes.forEach((change, index) => {
    const label = `第 ${index + 1} 项`;
    const from = Array.isArray(change?.from) ? change.from.map((name) => String(name || '').trim()) : [];
    const name = String(change?.name || '').trim();
    if (!from.length) errors.push(`${label}缺少 from`);
    if (!name) errors.push(`${label}缺少 name`);
    const sources = [];
    for (const item of from) {
      if (referenced.has(item)) errors.push(`${label}：字段“${item}”在多项中出现`);
      else if (!byName.has(item)) errors.push(`${label}：清单中没有字段“${item}”`);
      else sources.push(byName.get(item));
      referenced.add(item);
    }
    if (!sources.length || !name) return;
    if (new Set(sources.map((item) => kindOf.get(item))).size > 1) {
      errors.push(`${label}：${from.join('、')} 的类型不同，不能合成`);
    }
    if (new Set(sources.map((item) => JSON.stringify(item.parts || null))).size > 1) {
      errors.push(`${label}：${from.join('、')} 的附件拆分不同，不能合成`);
    }
    const pick = (key) => (change[key] !== undefined ? String(change[key]).trim() : sources.find((item) => item[key])?.[key]);
    const fillBy = pick('fill_by');
    if (change.fill_by === undefined && new Set(sources.map((item) => item.fill_by)).size > 1) {
      errors.push(`${label}：${from.join('、')} 的填写方式不同，请写明 fill_by`);
    } else if (!FILL_BY_VALUES.has(fillBy)) {
      errors.push(`${label}：fill_by 只能是 ai、manual 或 rule`);
    }
    const [target, ...rest] = sources;
    for (const item of rest) {
      target.candidate_ids.push(...item.candidate_ids);
      removed.add(item);
    }
    target.name = name;
    target.subject = pick('subject') || target.subject;
    target.fill_by = fillBy;
    const instruction = pick('instruction');
    if (instruction) target.instruction = instruction;
    else delete target.instruction;
    written.set(target, { subject: change.subject !== undefined, instruction: change.instruction !== undefined });
  });
  // 处理后同名即同一字段（命名标准下名称唯一确定应填写的信息），由程序合成；类型、附件拆分或填写方式不同则不能合成。
  const next = [];
  const byFinalName = new Map();
  const reported = new Set();
  for (const item of fields) {
    if (removed.has(item)) continue;
    const same = byFinalName.get(item.name);
    if (!same) {
      byFinalName.set(item.name, item);
      next.push(item);
      continue;
    }
    const mismatch = kindOf.get(same) !== kindOf.get(item) || JSON.stringify(same.parts || null) !== JSON.stringify(item.parts || null)
      ? '类型或附件拆分不同，不能合成，请改用能区分的名称'
      : same.fill_by !== item.fill_by ? '填写方式不同，请写在同一项的 from 中并写明 fill_by' : '';
    if (mismatch) {
      if (!reported.has(item.name)) errors.push(`处理后有多个字段都叫“${item.name}”，但${mismatch}`);
      reported.add(item.name);
      next.push(item);
      continue;
    }
    same.candidate_ids.push(...item.candidate_ids);
    for (const key of ['subject', 'instruction']) {
      if (!written.get(item)?.[key] || written.get(same)?.[key]) continue;
      if (item[key]) same[key] = item[key];
      else if (key === 'instruction') delete same.instruction;
    }
  }
  const grouped = next.filter((item) => /〔第\d+组(之\d+)?〕$/.test(item.name)).map((item) => item.name);
  if (grouped.length) errors.push(`这些字段仍带组号，必须处理：${[...new Set(grouped)].join('、')}`);
  return { classification: { ...classification, fields: next }, errors };
}

function createMaterialFiles(workspaceStore, items) {
  const plan = workspaceStore.loadTechnicalPlan() || {};
  const responseRequirements = String(plan.bidAnalysisTasks?.responseFileRequirements?.content || '').trim();
  const overview = String(plan.projectOverview || '').trim();
  return [
    { path: TEMPLATE_OUTLINE_INPUT_FILE, content: JSON.stringify({ items }, null, 2) },
    ...(responseRequirements ? [{ path: RESPONSE_REQUIREMENTS_FILE, content: responseRequirements }] : []),
    ...(overview ? [{ path: PROJECT_OVERVIEW_FILE, content: overview }] : []),
  ];
}

// 工具绑定当前业务工作区的原件和输出位置；分组时产物写到该组的临时目录，只校验本组章节。
function buildOpenXmlToolOptions({ workspaceStore, openXmlHelperService, items, actions, scope }) {
  return {
    openXmlHelperService,
    templateChapters: items,
    actions,
    listBusinessSources: () => workspaceStore.listTenderSourceDocxRelativePaths(),
    resolveAgentSources: (hint) => workspaceStore.resolveTenderSourceDocxPath(hint),
    bidTemplateSourcePath: workspaceStore.getBidTemplateSourcePath(),
    bidTemplateSourceRelativePath: workspaceStore.getBidTemplateSourceRelativePath(),
    bidTemplatePath: scope?.templatePath || workspaceStore.getBidTemplatePath(),
    bidTemplateRelativePath: scope?.templateRelativePath || workspaceStore.getBidTemplateRelativePath(),
    bidTemplateFieldsPath: scope?.fieldsPath || workspaceStore.getBidTemplateFieldsPath(),
    bidTemplateFieldsRelativePath: scope?.fieldsRelativePath || workspaceStore.getBidTemplateFieldsRelativePath(),
    ...(scope ? { scopeChapterIds: scope.chapterIds, onConfirmed: scope.onConfirmed } : {}),
  };
}

function groupOutputPaths(workspaceStore, index) {
  const relativeDir = path.posix.join(path.posix.dirname(workspaceStore.getBidTemplateRelativePath()), GROUP_OUTPUT_DIR, `g${index}`);
  const absoluteDir = path.join(path.dirname(workspaceStore.getBidTemplatePath()), GROUP_OUTPUT_DIR, `g${index}`);
  return {
    templateRelativePath: path.posix.join(relativeDir, 'bid-template.docx'),
    fieldsRelativePath: path.posix.join(relativeDir, 'bid-template-fields.json'),
    templatePath: path.join(absoluteDir, 'bid-template.docx'),
    fieldsPath: path.join(absoluteDir, 'bid-template-fields.json'),
  };
}

function parseClassification(content) {
  const issues = [];
  const text = String(content || '').trim();
  if (!text) {
    issues.push({ severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE, message: `${TEMPLATE_CLASSIFICATION_FILE} 未生成或内容为空，请写入完整分类 JSON` });
    return { issues };
  }
  let classification;
  try {
    classification = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    issues.push({ severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE, message: `${TEMPLATE_CLASSIFICATION_FILE} 不是合法 JSON：${error.message}` });
    return { issues };
  }
  if (!validateClassification(classification)) {
    issues.push(...validateClassification.errors.map((item) => ({
      severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE, path: item.instancePath || '/',
      message: `${TEMPLATE_CLASSIFICATION_FILE} 结构无效：${item.instancePath || '/'} ${item.message}`,
    })));
  }
  return { classification, issues };
}

function createRetryPrompt(scoped) {
  return (request) => {
    if (request.kind === 'execution') return null;
    return `请保留当前工作区已有结果，只修复本次提交报告中的问题。必须在当前工作目录根目录中将${scoped ? '本组的' : ''}完整分类写入 ${TEMPLATE_CLASSIFICATION_FILE}，不得改名或另存到其他目录；已有内容用 edit 或 write 修复。全部分类写完后调用 openxml，参数为 {"action":"${APPLY_TEMPLATE_FIELDS_ACTION}","fields_file":"${TEMPLATE_CLASSIFICATION_FILE}"}，${scoped ? '' : '由工具生成 bid-template.docx 和 bid-template-fields.json，不得手工写入最终 Word 或字段清单；'}审阅 ${AGENT_TEMPLATE_PREVIEW_FILE} 无误后调用 {"action":"${CONFIRM_TEMPLATE_FIELDS_ACTION}"} 结束。`;
  };
}

// 只分一组时写入最终 Word 的会话：持久任务，校验分类、Word 和字段清单都已生成。
async function runWritingAgent({ agentService, workspaceStore, openXmlHelperService, items, taskId, title, prompt, files, signal, onActivity, onCheckpoint }) {
  const result = await agentService.runTask({
    task_id: taskId,
    title,
    summary_enabled: false,
    // 模版和字段清单由工具校验并落盘、Agent 审阅效果正文并确认成功后结束，不依赖模型主动标记完成。
    is_final_tool_call: (call) => call.name === 'openxml' && call.arguments?.action === CONFIRM_TEMPLATE_FIELDS_ACTION,
    prompt,
    output_file: TEMPLATE_FIELDS_OUTPUT_FILE,
    prepare_output_files: [TEMPLATE_CLASSIFICATION_FILE],
    files,
    signal,
    persistent_task: {
      task_key: TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
      mode: 'create',
    },
    initial_stage: 'template-extraction',
    initial_stage_index: 0,
    active_tools: TEMPLATE_AGENT_TOOLS,
    open_xml_tool: buildOpenXmlToolOptions({
      workspaceStore,
      openXmlHelperService,
      items,
      actions: [APPLY_TEMPLATE_FIELDS_ACTION, CONFIRM_TEMPLATE_FIELDS_ACTION],
    }),
    max_retries: 1,
    onActivity,
    onCheckpoint,
    buildRetryPrompt: createRetryPrompt(false),
    async validateOutput(candidate, meta) {
      const { classification, issues } = parseClassification(await meta.readFile(TEMPLATE_CLASSIFICATION_FILE));
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
      return {
        value: issues.length ? null : { field_count: payload.fields.length, boundary_issues: classification.boundary_issues || [] },
        issues,
      };
    },
  });
  return {
    task_id: result.task_id,
    session_id: result.session_id,
    field_count: result.validation_result.field_count,
    boundary_issues: result.validation_result.boundary_issues,
  };
}

// 分组子会话：临时会话，产物写到本组临时目录；确认后的分类文件即本组结果。
async function runGroupAgent({ agentService, workspaceStore, openXmlHelperService, items, taskId, group, groupCount, prompt, files, signal, onActivity }) {
  let confirmedContent = null;
  const paths = groupOutputPaths(workspaceStore, group.index);
  const result = await agentService.runTask({
    task_id: `${taskId}-g${group.index}`,
    title: `投标模版分类（第 ${group.index}/${groupCount} 组）`,
    primary_session: false,
    // 任一组失败即整体失败、取消其他组，与单个 Agent 提取失败的处理一致。
    failure_handled_by_parent: true,
    summary_enabled: false,
    is_final_tool_call: (call) => call.name === 'openxml' && call.arguments?.action === CONFIRM_TEMPLATE_FIELDS_ACTION,
    prompt,
    output_file: TEMPLATE_CLASSIFICATION_FILE,
    prepare_output_files: [TEMPLATE_CLASSIFICATION_FILE],
    files,
    signal,
    active_tools: TEMPLATE_AGENT_TOOLS,
    open_xml_tool: buildOpenXmlToolOptions({
      workspaceStore,
      openXmlHelperService,
      items,
      actions: [APPLY_TEMPLATE_FIELDS_ACTION, CONFIRM_TEMPLATE_FIELDS_ACTION],
      scope: {
        ...paths,
        chapterIds: group.chapters.map((item) => item.id),
        onConfirmed: (content) => { confirmedContent = content; },
      },
    }),
    max_retries: 1,
    onActivity,
    buildRetryPrompt: createRetryPrompt(true),
    async validateOutput(candidate) {
      const { classification, issues } = parseClassification(candidate.output_content);
      if (!issues.length && confirmedContent !== candidate.output_content) {
        issues.push({ severity: 'blocking', file: TEMPLATE_CLASSIFICATION_FILE,
          message: `${TEMPLATE_CLASSIFICATION_FILE} 尚未按当前内容应用并确认，请调用 apply-template-fields，审阅 ${AGENT_TEMPLATE_PREVIEW_FILE} 后调用 confirm-template-fields` });
      }
      return { value: issues.length ? null : classification, issues };
    },
  });
  return { index: group.index, classification: result.validation_result };
}

/**
 * 多组时的统稿：一次请求得到统稿清单，程序按清单修改合并后的分类；清单不能执行时把错误交回模型修正一次，
 * 仍不能执行时重新请求一轮（同样带一次修正）。
 */
async function runNamingStep({ aiService, classification, fieldList, conflicts, groupCount, chapterCount, templateText, signal }) {
  const prompt = createNamingPrompt({
    groupCount,
    chapterCount,
    fieldListJson: fieldList.map((item) => JSON.stringify(item)).join('\n'),
    conflicts,
    templateText,
  });
  let applied = null;
  await aiService.collectJsonResponse({
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    logTitle: '投标模版统稿',
    progressLabel: '投标模版统稿',
    failureMessage: '统一投标模版跨章字段命名失败',
    max_retries: 1,
    signal,
    validator(plan) {
      const result = applyNamingPlan(classification, plan, fieldList);
      if (result.errors.length) throw new Error(result.errors.join('\n'));
      applied = result.classification;
    },
    repairMessagesBuilder: ({ invalidContent, issues }) => [
      { role: 'user', content: prompt },
      { role: 'assistant', content: String(invalidContent || '') },
      { role: 'user', content: `上面的统稿清单不能执行：\n${issues.join('\n')}\n请修正后重新输出完整的统稿清单 JSON，不要其他文字。` },
    ],
  });
  return applied;
}

/** 条目缺原文位置或分类发现边界错误时，由临时 Agent 定位并抽章；成功以章节范围文件存在为准。 */
async function runLocateAgent({ agentService, workspaceStore, openXmlHelperService, items, taskId, files, issues, signal, onActivity }) {
  const blocks = await readTenderBlockOutline({
    openXmlHelperService,
    sources: workspaceStore.listTenderSourceDocxRelativePaths(),
    signal,
  });
  const locateFiles = [...files, { path: AGENT_BLOCKS_FILE, content: blocks.text }];
  const chaptersPath = chapterRangesPath(workspaceStore);
  await agentService.runTask({
    task_id: `${taskId}-locate`,
    title: '投标模版抽章',
    primary_session: false,
    failure_handled_by_parent: true,
    summary_enabled: false,
    is_final_tool_call: (call) => call.name === 'openxml' && call.arguments?.action === EXTRACT_CHAPTERS_ACTION,
    prompt: createLocatePrompt({ issues, files: locateFiles }),
    output_file: LOCATE_NOTE_FILE,
    files: locateFiles,
    signal,
    active_tools: TEMPLATE_AGENT_TOOLS,
    open_xml_tool: buildOpenXmlToolOptions({
      workspaceStore,
      openXmlHelperService,
      items,
      actions: [LIST_BLOCKS_ACTION, EXTRACT_CHAPTERS_ACTION],
    }),
    max_retries: 1,
    onActivity,
    buildRetryPrompt: (request) => (request.kind === 'execution'
      ? null
      : `投标模版章节尚未抽取成功。请按 ${TEMPLATE_OUTLINE_INPUT_FILE} 的全部目录调用 openxml 的 ${EXTRACT_CHAPTERS_ACTION}，成功后任务自动结束。`),
    validateOutput() {
      const issueList = fs.existsSync(chaptersPath) ? [] : [{ severity: 'blocking', file: 'bid-template-source.docx',
        message: `投标模版章节尚未抽取，请调用 openxml 的 ${EXTRACT_CHAPTERS_ACTION}` }];
      return { value: issueList.length ? null : true, issues: issueList };
    },
  });
}

function chapterRangesPath(workspaceStore) {
  const parsed = path.parse(workspaceStore.getBidTemplateSourcePath());
  return path.join(parsed.dir, `${parsed.name}.chapters.json`);
}

// ---------------------------------------------------------------------------
// 任务入口
// ---------------------------------------------------------------------------

/**
 * 按已确认目录提取投标模版：程序抽章扫描（缺原文位置时由 Agent 定位抽章），按章节分组并发分类，
 * 多组时合并后由统稿清单统一跨章命名、程序写入 Word；候选少时只分一组，由一个 Agent 分类并写入。
 * 分类发现抽章边界错误时修正边界并重新分类一次。
 */
async function runTemplateExtractionTask({
  agentService,
  aiService,
  workspaceStore,
  openXmlHelperService,
  taskId,
  items,
  signal,
  onActivity,
  onCheckpoint,
  onStep,
}) {
  const sourcePaths = workspaceStore.listTenderSourceDocxRelativePaths();
  if (!sourcePaths.length) {
    return { status: 'skipped', field_count: 0 };
  }
  const step = (index, message) => {
    try { onStep?.({ step: index, total: TEMPLATE_STEP_TOTAL, message }); } catch {}
  };
  const materials = createMaterialFiles(workspaceStore, items);
  const maxGroups = Math.max(1, Number(aiService?.getTextQueueStatus?.()?.limit) || 1);
  const common = { agentService, workspaceStore, openXmlHelperService, items, taskId, signal, onActivity };
  const groupRoot = path.join(path.dirname(workspaceStore.getBidTemplatePath()), GROUP_OUTPUT_DIR);
  let boundaryIssues = [];
  let result;
  let writtenByAgent = false;

  try {
    for (let round = 0; round < 2; round += 1) {
      step(1, round ? '修正章节边界并重新识别待填位置' : '抽取章节并识别待填位置');
      // 旧产物会让抽章和写入校验误判完成，每轮先清掉。
      workspaceStore.clearBidTemplate();
      if (!boundaryIssues.length && hasAllSources(items)) {
        await extractTemplateChapters({
          openXmlHelperService,
          businessSources: sourcePaths,
          resolveAgentSources: (hint) => workspaceStore.resolveTenderSourceDocxPath(hint),
          templateChapters: items,
          chapters: chaptersFromItems(items),
          output: workspaceStore.getBidTemplateSourceRelativePath(),
          signal,
        });
      } else {
        await runLocateAgent({ ...common, files: materials, issues: boundaryIssues });
      }
      const { candidateData, templateText } = await scanTemplateFields({
        openXmlHelperService,
        input: workspaceStore.getBidTemplateSourceRelativePath(),
        signal,
      });
      const textParts = splitTemplateText(templateText);
      const groups = splitTemplateGroups(items, candidateData.candidates, maxGroups)
        .map((chapters, index) => ({ index: index + 1, chapters }));
      const fullFiles = [
        ...materials,
        { path: AGENT_TEMPLATE_TEXT_FILE, content: templateText },
        { path: AGENT_FIELD_CANDIDATES_FILE, content: `${JSON.stringify(candidateData, null, 2)}\n` },
      ];

      if (groups.length === 1) {
        step(2, `识别到 ${candidateData.candidates.length} 个待填位置，正在分类`);
        result = await runWritingAgent({
          ...common,
          title: '投标模版提取',
          prompt: createSinglePrompt({ files: fullFiles, templateText, candidateJson: JSON.stringify(candidateData) }),
          files: fullFiles,
          onCheckpoint,
        });
        writtenByAgent = true;
        boundaryIssues = round === 0 ? result.boundary_issues : [];
        if (boundaryIssues.length) continue;
        break;
      }

      step(2, `识别到 ${candidateData.candidates.length} 个待填位置，分 ${groups.length} 组并发分类`);
      // 多组时统稿由程序完成，不建持久 Session；清掉上次提取留下的会话，避免被当作本次结果。
      agentService.deletePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
      const controller = new AbortController();
      const groupSignal = AbortSignal.any([signal, controller.signal].filter(Boolean));
      let firstError = null;
      let finished = 0;
      const settled = await Promise.allSettled(groups.map(async (group) => {
        const chapterIds = group.chapters.map((item) => item.id);
        const groupText = sliceTemplateText(textParts, chapterIds);
        const groupCandidates = sliceCandidates(candidateData, chapterIds);
        const files = [
          ...materials,
          { path: AGENT_TEMPLATE_TEXT_FILE, content: templateText },
          { path: GROUP_TEMPLATE_TEXT_FILE, content: groupText },
          { path: AGENT_FIELD_CANDIDATES_FILE, content: `${JSON.stringify(groupCandidates, null, 2)}\n` },
        ];
        try {
          const fragment = await runGroupAgent({
            ...common,
            signal: groupSignal,
            group,
            groupCount: groups.length,
            files,
            prompt: createGroupPrompt({
              files,
              group,
              groupCount: groups.length,
              chapterCount: items.length,
              templateText: groupText,
              candidateJson: JSON.stringify(groupCandidates),
            }),
          });
          finished += 1;
          step(2, `分组分类：已完成 ${finished}/${groups.length} 组`);
          return fragment;
        } catch (error) {
          if (!firstError && !groupSignal.aborted) {
            firstError = new Error(`第 ${group.index} 组分类失败：${error?.message || String(error)}`);
            if (error?.code) firstError.code = error.code;
            controller.abort(firstError);
          }
          throw error;
        }
      }));
      fs.rmSync(groupRoot, { recursive: true, force: true });
      const rejected = settled.find((item) => item.status === 'rejected');
      if (rejected) throw firstError || rejected.reason;
      const fragments = settled.map((item) => item.value);

      const issues = fragments.flatMap((item) => item.classification.boundary_issues || []);
      if (issues.length && round === 0) {
        boundaryIssues = issues;
        continue;
      }
      if (issues.length) onActivity?.({ message: `修正边界后仍有章节边界问题，按当前抽章继续：${issues.map((item) => item.problem).join('；')}` });

      step(3, '统一跨章字段命名');
      const { classification, conflicts } = mergeGroupClassifications(fragments, candidateData);
      const fieldList = buildFieldList(classification, candidateData, textParts, items);
      const finalClassification = await runNamingStep({
        aiService,
        classification,
        fieldList,
        conflicts,
        groupCount: groups.length,
        chapterCount: items.length,
        templateText,
        signal,
      });
      step(3, '写入投标模版');
      await applyTemplateClassification({
        openXmlHelperService,
        selections: finalClassification,
        input: workspaceStore.getBidTemplateSourceRelativePath(),
        output: workspaceStore.getBidTemplateRelativePath(),
        fieldsOutput: workspaceStore.getBidTemplateFieldsRelativePath(),
        signal,
      });
      if (!workspaceStore.hasBidTemplate()) throw new Error('助手没有同时写出投标模版和字段清单');
      const payload = JSON.parse(fs.readFileSync(workspaceStore.getBidTemplateFieldsPath(), 'utf8'));
      result = { field_count: Array.isArray(payload?.fields) ? payload.fields.length : 0 };
      break;
    }
  } finally {
    fs.rmSync(groupRoot, { recursive: true, force: true });
  }

  // 只有一组时由持久 Session 写入，标记其完成；多组时没有持久 Session。
  if (writtenByAgent) {
    agentService.updatePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY, {
      status: 'success',
      phase: 'completed',
      agent_connection: 'idle',
      error: null,
      completed_at: new Date().toISOString(),
    });
  }
  return {
    status: 'success',
    task_id: result.task_id,
    session_id: result.session_id,
    field_count: result.field_count,
  };
}

module.exports = {
  TEMPLATE_FIELDS_OUTPUT_FILE,
  runTemplateExtractionTask,
  // 供定向检查使用的纯函数。
  splitTemplateGroups,
  splitTemplateText,
  sliceTemplateText,
  sliceCandidates,
  mergeGroupClassifications,
  buildFieldList,
  applyNamingPlan,
  chaptersFromItems,
  hasAllSources,
};
