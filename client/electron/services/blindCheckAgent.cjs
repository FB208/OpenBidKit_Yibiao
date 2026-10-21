// 暗标 AI 复核：程序初筛之后，由一个持久 Agent 对照招标文件补漏、判定候选问题、逐条对照招标条款；
// 自动修复时续接同一个会话，处理程序修不了的问题。提示词、材料文件和业务工具都在这里，数据协议见 blindCheckReview.cjs。
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const {
  DISPOSITION_OUTPUT_FILE,
  DISPOSITION_SCHEMA,
  REVIEW_OUTPUT_FILE,
  REVIEW_SCHEMA,
  buildOpenItems,
  imageIdsOf,
  newProblemGroups,
  parseDumpParagraphs,
  validateDispositionOutput,
  validateReviewOutput,
} = require('./blindCheckReview.cjs');

const BLIND_CHECK_AGENT_TASK_KEY = 'blind-check-review';
const TENDER_FILE = '招标文件.md';
const PRESET_FILE = '格式要求.json';
const CHECK_RESULT_FILE = '程序检查结果.json';
const DUMP_FILE = '标书正文.txt';
const OPEN_ITEMS_FILE = '待处理问题.json';
const FIXED_DUMP_FILE = '修复后标书正文.txt';
const FIXED_CHECK_FILE = '修复后检查结果.json';
const RECHECK_FILE = '复查结果.json';
const IMAGE_DIR = '图片';
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
// 非候选组只给前若干条定位，够 Agent 了解问题即可；候选组给全部条目逐条判定。
const MAX_AGENT_ITEMS = 30;
const MAX_EDITS_PER_CALL = 30;
const VIEWABLE_IMAGES = new Set(['.png', '.jpg', '.jpeg']);

const IMAGE_TOOL = 'inspect-image';
const EDIT_TOOL = 'apply-edits';
const RECHECK_TOOL = 'recheck';

/**
 * Agent 活动转成任务日志。公共层的"正在自动修复"指提交结果没通过校验、退回 Agent 改自己的结果文件，
 * 这里写明改的是复核结果或处理结果，避免和第四步的自动修复混淆；不显示的活动返回空。
 */
function agentActivityText(event, output) {
  if (event.visible === false || !event.message) return '';
  if (event.source !== 'pi.retry') return event.message;
  const reason = String(event.message).split('：').slice(1).join('：');
  return `AI 正在按程序校验意见修改${output}${reason ? `：${reason}` : ''}`;
}

function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text }], details: value };
}

/** Word / WPS 保存时写进文档属性的页数；没有时返回 null。 */
function readDocumentPageCount(docxPath) {
  try {
    const xml = new AdmZip(docxPath).getEntry('docProps/app.xml')?.getData().toString('utf8') || '';
    const pages = Number(xml.match(/<Pages>(\d+)<\/Pages>/)?.[1]);
    return Number.isFinite(pages) && pages > 0 ? pages : null;
  } catch {
    return null;
  }
}

/** 程序检查结果交给 Agent 的形式：组编号、是否候选、修改方法和带段落编号的定位。 */
function groupsForAgent(groups) {
  return groups.map((group) => ({
    id: group.id,
    rule: group.ruleTitle,
    category: group.category,
    severity: group.severity,
    message: group.message,
    candidate: group.candidate,
    count: group.count,
    hint: (group.samples || []).map((sample) => sample.hint).find(Boolean) || '',
    items: (group.candidate ? group.items : (group.items || []).slice(0, MAX_AGENT_ITEMS)).map((item, index) => ({
      index,
      target: item.locator || '',
      where: item.where,
      text: item.text,
      detail: item.detail,
    })),
    ...(group.candidate ? {} : group.count > MAX_AGENT_ITEMS ? { more: group.count - MAX_AGENT_ITEMS } : {}),
  }));
}

function presetForAgent(input) {
  const source = input.presetSource;
  return {
    presetName: input.presetName,
    profile: input.profile,
    ...(source ? {
      source: {
        tenderName: source.tenderName,
        fields: Object.fromEntries(Object.entries(source.fields || {}).map(([key, item]) => [key, { value: item.value, evidence: item.evidence }])),
        manual: source.manual || [],
        unspecified: source.unspecified || [],
      },
    } : {}),
  };
}

/** 没有招标文件全文时，条款依据只能取自预设的出处：各字段依据和人工核对条款。 */
function presetReferenceText(input) {
  const source = input.presetSource;
  if (!source) return '';
  return [...Object.values(source.fields || {}).map((item) => item.evidence), ...(source.manual || [])].join('\n');
}

function reviewPrompt({ tender, pageCount, candidateCount }) {
  const tenderLine = tender
    ? `- ${TENDER_FILE}：招标文件全文（${tender.fileName}）。`
    : `- 本次没有招标文件全文（当前预设不是从招标文件生成的，或生成时还没有保存原文），招标要求只能以 ${PRESET_FILE} 里的条款依据和人工核对条款为准。`;
  return `你是暗标（技术标匿名评审）合规复核员。程序已经按格式预设逐条检查过这份投标文件，你的任务是对照招标要求做第二轮复核：补上程序查不出的问题，判定程序拿不准的候选问题，并逐条列出招标文件对技术暗标的要求是否满足。只阅读材料、只写复核结果，不修改标书。

当前工作目录里的材料：
${tenderLine}
- ${PRESET_FILE}：程序检查使用的格式预设；source 里是从招标文件提取的各项要求及原文依据、无法自动检查的条款（manual）。
- ${CHECK_RESULT_FILE}：程序查出的问题，按组列出，id 为 g 编号；candidate 为 true 的是候选问题（本次共 ${candidateCount} 组），程序只能初筛，需要你判定。items 是带段落编号（target）的定位，序号 index 从 0 起。
- ${DUMP_FILE}：待检标书逐段文本，每行以段落编号开头（p 正文段落，t 表格单元格，hdr/ftr 页眉页脚，fn/en 脚注尾注，tb 文本框）。开头列出分节、页码和页眉页脚（含程序对页眉页脚内容的判断），文末是图片清单（img 编号）。行内〔〕里是程序加的标注（标题级别、目录、域、文本框、分页分节等），不是标书原文。文件较长，请分段 read 或按关键词 grep。
- 文档属性记录的页数：${pageCount ? `${pageCount} 页（Word / WPS 最后一次保存时统计，可能与实际排版略有出入）` : '没有记录'}。

工作步骤：
1. 找出招标文件对技术暗标（施工组织设计、技术标）的全部要求：用 grep 搜"暗标""技术标""施工组织设计""页码""页数""页眉""字体""行距""模块""评分""否决"等关键词，读完相关章节，包括投标人须知前附表、正文要求、否决投标条款和评标办法里的评审模块或评分项。同一要求在两处表述不同时以前附表为准，并在说明里写明差异。
2. 读程序检查结果，了解程序已经确定的问题。
3. 通读标书正文，逐条对照要求。重点核查程序做不到的：
   - 身份信息：投标人名称、人员姓名、以往工程名称、业绩、荣誉、企业标准或编号、徽标等可识别投标人的内容；
   - 标书写的工程名称、建设内容是否与本次招标一致（写成别的工程会被视为出现以往工程名称）；
   - 工期、页数等招标文件规定了限值的数值，按限值方向判断：承诺优于限值（工期更短、页数更少）不算违规，只有超出限值才判不符合；招标文件明确要求必须等于某值时才要求相同；
   - 章节是否按招标文件的评审模块编排，是否要求各模块分别成文件、各自编页码。标书是一个文件、页码通篇连续或只在个别位置重新编号，就说明没有按模块分别成文件、各自编页码；
   - 页码、页数上限、目录、标题序号、空白页等结构要求；
   - 图片：先看图片清单里的名称和替代文字；需要看图片画面（例如图表标题、截图里的文字、徽标）时调用 ${IMAGE_TOOL}。
4. 对每个候选问题下结论（verdict）：problem 确实违反要求；not_problem 不违反（例如是招标人、监理等第三方单位，或是正常的技术表述）；uncertain 无法确定，需要人工确认。可以按整组判定（id 写 g 编号），也可以逐条判定（id 写"g编号#条目序号"，如 g5#2）；每个候选问题都要有结论。
5. 把结果写入 ${REVIEW_OUTPUT_FILE}，然后调用 json-validation 校验，只传 {"file_path":"${REVIEW_OUTPUT_FILE}"}。

${REVIEW_OUTPUT_FILE} 的结构：
{
  "summary": "一两句话总结复核结论",
  "clauses": [{ "id": "c1", "requirement": "要求概括", "basis": "招标文件原文摘录", "status": "pass|fail|unknown", "explanation": "判断依据", "issues": ["g3", "a1"] }],
  "candidates": [{ "id": "g5", "verdict": "problem|not_problem|uncertain", "reason": "理由" }],
  "issues": [{ "id": "a1", "title": "一句话结论", "severity": "high|medium|low", "category": "privacy|structure|page|paragraph|font|text|table|consistency|image", "basis": "招标文件原文摘录", "detail": "具体说明", "suggestion": "修改建议", "locations": [{ "target": "p59", "text": "标书原文摘录" }, { "target": "img3", "text": "图片里的文字", "image_part": "alt|content" }] }]
}

要求：
- clauses 覆盖招标文件对技术暗标的每一条要求（格式、匿名、页码页数、评审模块、制作工具或加密等），同一句里的多项要求可以合并为一条。status：pass 符合；fail 不符合；unknown 无法判断，只用于标书文件本身确实看不出来的事项（例如是否加密、在交易平台如何导入、打印后的视觉效果、需要看图片但无法查看），explanation 写明原因。分节、页码编号、章节编排、是否分成多个文件等能从标书结构直接看出的要求，按标书现状判 pass 或 fail，不要以"实际提交时可能另行处理"为由判 unknown。判为 fail 时 issues 列出对应的问题编号：程序已查出的写 g 编号，你补充的写 a 编号。
- basis 逐字摘录原文（10～120 字，不改写、不拼接）。
- issues 只写确实违反要求、且程序没有查出的问题，不重复程序检查结果里已有的问题。无法确定的事项（例如排版后的实际页数、看不到的页码样式）只在对应条款写 unknown 并说明原因，不要写成 issues。severity：可识别投标人身份、可能导致否决投标的为 high；明确违反格式或结构要求的为 medium；建议性质的为 low。
- ${PRESET_FILE} 里 source.manual 的每一条人工核对条款，都要在 clauses 里有对应的结论。
- locations.target 写段落编号或图片编号；text 从 ${DUMP_FILE} 该行逐字摘录 2～80 字原文，不含行首编号和〔〕标注；段落本身不足 2 个字时整段摘录。图片位置必须写 image_part：摘录的是图片名称或替代文字写 alt，图片画面里的文字或标志写 content（照实抄录），两者都有问题时分别列出。涉及多处时逐处列出（最多 30 处），同类问题合并为一条。全文性质的问题（例如没有按评审模块分别成文件）locations 写空数组。程序会核对摘录，核对不上的位置会标为未核实。
- 只依据材料下结论，不猜测；拿不准的写 unknown 或 uncertain，并说明需要人工确认什么。
- 不修改任何材料文件，不调用 ask-user。全部完成后，用不超过 100 字说明复核结论。`;
}

function fixPrompt() {
  return `程序已按用户勾选的修复项完成自动修复，修复副本就是现在要修改的文档。请接着处理剩下的问题：能用文字级修改解决的直接修改，不能修改的写明原因和人工处理方法。

本阶段的材料（当前工作目录）：
- ${OPEN_ITEMS_FILE}：需要你处理的问题，id 与检查阶段一致（g 为程序问题，a 为你补充的问题）。程序问题的 locations 是修复副本里的位置；候选问题附带你在检查阶段的判定（verdicts），判为 not_problem 的不用处理。
- ${FIXED_DUMP_FILE}：修复副本的逐段文本。段落编号与检查阶段可能不同（程序拆段、删空段后会变化），请按原文检索定位；行内〔〕里是标注，不是原文。locations 里 unverified 为 true 的是检查时核对不上的摘录，修改前先检索确认原文。
- ${FIXED_CHECK_FILE}：程序对修复副本的复查结果。

可用工具：
- ${EDIT_TOOL}：提交一批文字级修改（每批最多 ${MAX_EDITS_PER_CALL} 条），由程序在修复副本上执行，每条都写明对应的问题编号 issue。只支持三种修改：
  - replace：替换段落里的一处文字。find 必须逐字取自 ${FIXED_DUMP_FILE} 该段，并在段内只出现一次；replace 是替换后的文字，可为空（表示删去这几个字）。
  - delete_paragraph：删除整段，find 填该段完整原文。带分节符或分页符的段落、标题、目录、单元格里唯一的段落不能删。
  - clear_image_alt：清除图片的替代文字和标题，target 为图片编号。
  同一批修改都按提交时的段落编号定位。修改后程序会校验文档结构，并更新 ${FIXED_DUMP_FILE}；删段后编号会变，后续修改以更新后的文件为准。
- ${RECHECK_TOOL}：用同一份格式预设重新检查修复副本，写出 ${RECHECK_FILE}，并列出修改后新出现的问题。
- ${IMAGE_TOOL}：需要看图片画面时使用。

修改原则：
- 只改有问题的字词：删除或替换可识别身份的名称和以往工程名称，把写错的工程名称改为本次招标的工程名称或"本工程"，删除不应出现的整段文字，清除带身份信息的图片替代文字。
- 不改格式（格式由程序修复），不重写整段内容，不新增段落，不拆分文档。
- 以下情况不修改，留给人工：按评审模块拆分文件或重编页码，整段或整章内容与招标项目不符需要重写，图片画面里的文字或徽标，需要投标人确认的事实（人员、工期、数量等）。
- 修改后调用 ${RECHECK_TOOL}，确认没有新出现的问题；有就修正。

最后把每个待处理问题的处理结论写入 ${DISPOSITION_OUTPUT_FILE}，并调用 json-validation 校验，只传 {"file_path":"${DISPOSITION_OUTPUT_FILE}"}：
{
  "summary": "一两句话总结本次处理",
  "items": [{ "id": "a1", "action": "fixed|manual", "reason": "manual 时写为什么不能自动修改", "suggestion": "manual 时写人工具体怎么改（位置和做法）" }],
  "clauses": [{ "id": "c1", "status": "pass|fail|unknown", "explanation": "修复后的判断" }]
}
- items 必须包含 ${OPEN_ITEMS_FILE} 里的每个编号，每个只写一次。fixed 表示已通过 ${EDIT_TOOL} 改好，reason 和 suggestion 可留空。
- clauses 只写修复后状态有变化的条款，没有变化可以是空数组。
- 程序会用复查结果核对处理情况，没有真正改掉的问题会显示为待人工处理。
- 不调用 ask-user。全部完成后，用不超过 100 字说明本次处理结果。`;
}

/** 看图工具：把图片交给已开启多模态的文本模型描述画面；没开多模态或是矢量图时直接说明，由 Agent 判为需人工查看。 */
function createImageTool({ Type, workspaceDir, aiService, getDocxPath, getImages, signal }) {
  return {
    name: IMAGE_TOOL,
    label: '查看图片',
    description: '查看标书里一张图片的画面：抄录图中文字，说明是否彩色、有无徽标、印章、人名、单位名称、工程名称、网址电话等。参数 image 为图片编号（img3），question 可选，写需要重点确认的内容。',
    executionMode: 'sequential',
    parameters: Type.Object({
      image: Type.String({ minLength: 1, description: '图片编号，如 img3' }),
      question: Type.Optional(Type.String({ description: '需要重点确认的内容' })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, toolSignal) {
      const image = getImages().find((item) => item.id === params.image);
      if (!image) throw new Error(`找不到图片 ${params.image}，请按图片清单里的编号查看`);
      if (!image.part) throw new Error(`${image.id} 是文本框或图形，不是图片文件，其中的文字已在标书正文里`);
      if (!aiService.getConfig().multimodal_enabled) {
        throw new Error('当前文本模型没有开启多模态，无法查看图片画面。与图片画面有关的条款判为 unknown，并说明需要人工查看图片');
      }
      const ext = path.extname(image.part).toLowerCase();
      if (!VIEWABLE_IMAGES.has(ext)) throw new Error(`${image.id} 是 ${ext.slice(1).toUpperCase()} 格式，无法查看画面，请判为需要人工查看`);
      const data = new AdmZip(getDocxPath()).getEntry(image.part)?.getData();
      if (!data) throw new Error(`${image.id} 的图片文件读取失败`);
      const filePath = path.join(workspaceDir, IMAGE_DIR, `${image.id}${ext}`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data);
      const question = String(params.question || '').trim();
      const answer = await aiService.chat({
        messages: [
          { role: 'system', content: '你是投标文件暗标审查助手，只如实描述图片里能看到的内容，不推测。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: `请完整抄录图片中的全部文字（标题、图例、表头、单元格等），并说明图片是否有彩色、是否有徽标、印章、人名、单位名称、工程名称、网址、电话等可识别身份的信息。${question ? `另外请重点确认：${question}` : ''}` },
              { type: 'local_image', path: filePath },
            ],
          },
        ],
        logTitle: '暗标图片复核',
        signal: toolSignal || signal,
      });
      return toolResult(`${image.id}（${image.part}）：\n${String(answer || '').trim()}`);
    },
  };
}

/**
 * 暗标 AI 复核（检查阶段）：新建持久会话，写入招标文件、预设、程序检查结果和标书结构，
 * 由 Agent 输出复核结果；提交时核对引用的原文，不通过退回原会话修复。
 */
async function runBlindCheckReviewAgent({ agentService, aiService, openXmlHelperService, input, groups, tender, taskId, signal, onActivity }) {
  const dump = await openXmlHelperService.runBlindCheckDump({
    source: input.source,
    profile: input.profile,
    sensitive_words: input.sensitiveWords,
    image_facts: [],
  }, { signal });
  const paragraphs = parseDumpParagraphs(dump.text);
  const candidateCount = groups.filter((group) => group.candidate).length;
  const files = [
    { path: PRESET_FILE, content: JSON.stringify(presetForAgent(input), null, 1) },
    { path: CHECK_RESULT_FILE, content: JSON.stringify(groupsForAgent(groups), null, 1) },
    { path: DUMP_FILE, content: dump.text },
    ...(tender ? [{ path: TENDER_FILE, content: tender.content }] : []),
  ];
  const result = await agentService.runTask({
    task_id: taskId,
    title: '暗标 AI 复核',
    prompt: reviewPrompt({ tender, pageCount: readDocumentPageCount(input.sourcePath), candidateCount }),
    files,
    output_file: REVIEW_OUTPUT_FILE,
    prepare_output_files: [REVIEW_OUTPUT_FILE],
    signal,
    persistent_task: { task_key: BLIND_CHECK_AGENT_TASK_KEY, mode: 'create' },
    initial_stage: 'blind-check-review',
    json_validation_schemas: { [REVIEW_OUTPUT_FILE]: REVIEW_SCHEMA },
    active_tools: [...NATIVE_AGENT_TOOLS, 'json-validation', 'report-failure', IMAGE_TOOL],
    create_tools: ({ Type, workspaceDir }) => [createImageTool({
      Type, workspaceDir, aiService, signal,
      getDocxPath: () => input.sourcePath,
      getImages: () => dump.images,
    })],
    max_retries: 1,
    timeout_ms: AGENT_TIMEOUT_MS,
    validateOutput: (candidate) => validateReviewOutput(candidate.output_content, {
      groups,
      paragraphs,
      imageIds: imageIdsOf(dump.images),
      hasTender: Boolean(tender),
      referenceText: tender ? tender.content : presetReferenceText(input),
      manualItems: input.presetSource?.manual || [],
    }),
    onActivity,
  });
  agentService.updatePersistentTask(BLIND_CHECK_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'review-completed',
    agent_connection: 'idle',
    error: null,
    input_signature: input.signature,
    review_images: dump.images,
  });
  return { review: result.validation_result, images: dump.images };
}

/** 续接复核会话的前提：会话还在，且是用当前检查条件复核的。 */
function canResumeReviewAgent(agentService, signature) {
  if (!agentService.hasPersistentTaskSession(BLIND_CHECK_AGENT_TASK_KEY)) return false;
  return agentService.loadPersistentTask(BLIND_CHECK_AGENT_TASK_KEY)?.state?.input_signature === signature;
}

/**
 * 暗标 AI 修复（修复阶段）：续接检查阶段的会话，Agent 通过编辑工具在修复副本上做文字级修改，
 * 并对每个待处理问题给出结论。提交时程序重新检查修复副本：出现新问题退回修正，处理状态以复查为准。
 */
async function runBlindCheckFixAgent({ agentService, aiService, openXmlHelperService, input, checkGroups, review, afterGroups, fixedDump, fixedSource, headingFallback = true, imageFacts, mapReport, fixableRules, taskId, signal, onActivity }) {
  const openItems = buildOpenItems({ checkGroups, review, afterGroups, fixRules: input.fixRules, fixableRules });
  if (!openItems.length) return { skipped: true, reason: '程序修复后没有需要 AI 处理的问题' };
  const persistent = agentService.loadPersistentTask(BLIND_CHECK_AGENT_TASK_KEY);
  const reviewImages = persistent?.state?.review_images || [];
  agentService.updatePersistentTask(BLIND_CHECK_AGENT_TASK_KEY, {
    run_id: taskId,
    status: 'running',
    phase: 'blind-check-fix',
    agent_connection: 'running',
    error: null,
  });

  let dump = fixedDump;
  const edits = [];
  const workspaceDir = persistent.paths.workspaceDir;
  // 修复副本的结构文本由编辑工具随修改更新，不作为受保护的输入文件。
  fs.writeFileSync(path.join(workspaceDir, FIXED_DUMP_FILE), dump.text, 'utf8');
  fs.writeFileSync(path.join(workspaceDir, FIXED_CHECK_FILE), JSON.stringify(groupsForAgent(afterGroups), null, 1), 'utf8');
  fs.rmSync(path.join(workspaceDir, RECHECK_FILE), { force: true });

  const inspectFixed = async (toolSignal) => mapReport(await openXmlHelperService.runBlindCheck({
    source: fixedSource,
    profile: input.profile,
    sensitive_words: input.sensitiveWords,
    image_facts: imageFacts,
    heading_fallback: headingFallback,
  }, { signal: toolSignal || signal }));

  const createTools = ({ Type, workspaceDir: dir }) => [
    createImageTool({ Type, workspaceDir: dir, aiService, signal, getDocxPath: () => input.outputPath, getImages: () => dump.images }),
    {
      name: EDIT_TOOL,
      label: '修改修复副本',
      description: `在修复副本上执行一批文字级修改（最多 ${MAX_EDITS_PER_CALL} 条）：replace 替换段内一处文字，delete_paragraph 删除整段，clear_image_alt 清除图片替代文字。返回每条修改的执行结果，并更新 ${FIXED_DUMP_FILE}。`,
      executionMode: 'sequential',
      parameters: Type.Object({
        edits: Type.Array(Type.Object({
          issue: Type.String({ minLength: 1, description: '对应的问题编号（g 或 a 编号）' }),
          op: Type.Union([Type.Literal('replace'), Type.Literal('delete_paragraph'), Type.Literal('clear_image_alt')]),
          target: Type.String({ minLength: 1, description: '段落编号或图片编号' }),
          find: Type.Optional(Type.String({ description: 'replace 时为段内要替换的原文；delete_paragraph 时为该段完整原文' })),
          replace: Type.Optional(Type.String({ description: 'replace 时替换后的文字，可为空' })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_EDITS_PER_CALL }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, toolSignal) {
        const result = await openXmlHelperService.runBlindCheckEdit({
          source: fixedSource,
          original: input.source,
          profile: input.profile,
          sensitive_words: input.sensitiveWords,
          image_facts: [],
          heading_fallback: headingFallback,
          edits: params.edits.map((edit) => ({ op: edit.op, target: edit.target, find: edit.find || '', replace: edit.replace || '' })),
        }, { signal: toolSignal || signal });
        for (const outcome of result.results || []) {
          if (!outcome.ok) continue;
          const edit = params.edits[outcome.index];
          edits.push({ issue: edit.issue, op: edit.op, target: edit.target, before: outcome.before || '', after: outcome.after || '' });
        }
        dump = result.dump;
        fs.writeFileSync(path.join(dir, FIXED_DUMP_FILE), dump.text, 'utf8');
        return toolResult({
          applied: result.applied,
          results: (result.results || []).map((item) => ({ index: item.index, issue: params.edits[item.index]?.issue, ok: item.ok, message: item.message, before: item.before, after: item.after })),
          note: result.applied ? `${FIXED_DUMP_FILE} 已更新，删段后段落编号会变化，后续修改以新文件为准` : '本批没有生效的修改',
        });
      },
    },
    {
      name: RECHECK_TOOL,
      label: '复查修复副本',
      description: `用同一份格式预设重新检查修复副本，结果写入 ${RECHECK_FILE}，返回各风险数量和修改后新出现的问题。`,
      executionMode: 'sequential',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, _params, toolSignal) {
        const report = await inspectFixed(toolSignal);
        fs.writeFileSync(path.join(dir, RECHECK_FILE), JSON.stringify(groupsForAgent(report.groups), null, 1), 'utf8');
        const added = newProblemGroups(afterGroups, report.groups);
        return toolResult({
          summary: report.summary,
          newProblems: added.map((group) => ({ message: group.message, count: group.count, samples: group.samples.map((sample) => `${sample.where}：${sample.text}`) })),
          note: added.length ? '以上是修改后新出现的问题，请修正' : '没有新出现的问题',
        });
      },
    },
  ];

  let finalReport = null;
  let result;
  try {
    result = await agentService.runTask({
      task_id: taskId,
      title: '暗标 AI 修复',
      prompt: fixPrompt(),
      files: [{ path: OPEN_ITEMS_FILE, content: JSON.stringify(openItems, null, 1) }],
      output_file: DISPOSITION_OUTPUT_FILE,
      prepare_output_files: [DISPOSITION_OUTPUT_FILE],
      signal,
      persistent_task: { task_key: BLIND_CHECK_AGENT_TASK_KEY, mode: 'resume' },
      initial_stage: 'blind-check-fix',
      json_validation_schemas: { [DISPOSITION_OUTPUT_FILE]: DISPOSITION_SCHEMA },
      active_tools: [...NATIVE_AGENT_TOOLS, 'json-validation', 'report-failure', IMAGE_TOOL, EDIT_TOOL, RECHECK_TOOL],
      create_tools: createTools,
      max_retries: 1,
      timeout_ms: AGENT_TIMEOUT_MS,
      async validateOutput(candidate) {
        const checked = validateDispositionOutput(candidate.output_content, { openItems, clauses: review.clauses });
        if (!checked.value) return checked;
        finalReport = await inspectFixed();
        const added = newProblemGroups(afterGroups, finalReport.groups);
        const issues = added.map((group) => ({
          severity: 'blocking',
          message: `修改后新出现：${group.message}（${group.count} 处，如 ${group.samples.map((sample) => sample.where).slice(0, 3).join('、')}），请修正对应修改`,
        }));
        return { value: issues.length ? null : checked.value, issues };
      },
      onActivity,
    });
  } catch (error) {
    // 失败前执行的修改已经写进副本：带出修改记录和检查时的图片信息，修复任务按副本实际状态对账。
    error.partial = { edits, reviewImages };
    throw error;
  }
  agentService.updatePersistentTask(BLIND_CHECK_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'fix-completed',
    agent_connection: 'idle',
    error: null,
  });
  return {
    skipped: false,
    disposition: result.validation_result,
    edits,
    finalReport,
    finalDump: dump,
    reviewImages,
  };
}

module.exports = {
  BLIND_CHECK_AGENT_TASK_KEY,
  agentActivityText,
  canResumeReviewAgent,
  runBlindCheckFixAgent,
  runBlindCheckReviewAgent,
};
