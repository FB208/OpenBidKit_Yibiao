const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { originalImageReferences } = require('./originalPlanRestoration.cjs');
const { createContentGenerationImageTools, validateContentImageReferences } = require('./contentGenerationImageTools.cjs');
const { countHtmlWords, checkWordCount, createContentGenerationWordTools } = require('./contentGenerationWordTools.cjs');
const { createContentImageProtection } = require('./contentGenerationEditTools.cjs');
const { CONSISTENCY_TOOLS, buildConsistencyPrompt, createContentGenerationConsistencyTools } = require('./contentGenerationConsistencyTools.cjs');
const { TABLE_CLEANUP_TOOLS, buildTableCleanupPrompt, createContentGenerationTableTools } = require('./contentGenerationTableTools.cjs');
const { LAYOUT_TOOLS, buildLayoutPrompt, createContentGenerationLayoutTools } = require('./contentGenerationLayoutTools.cjs');

const CONTENT_GENERATION_AGENT_TASK_KEY = 'technical-plan-content-generation';
const RESULT_FILE = '正文生成结果.json';
const RESOURCE_DIR = path.join(__dirname, '../resources/content-generation');
const INPUT_FILES = {
  overview: '项目概述.md',
  decisions: '正文编排决策.json',
  rules: '受限HTML生成规范.md',
  imageTypes: '配图类型对照表.md',
  template: '正文模板.html',
  config: '所选模板配置.json',
  facts: '全局事实设定.md',
};
const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['sections'],
  properties: { sections: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['section_id', 'file', 'words'],
    properties: { section_id: { type: 'string' }, file: { type: 'string' }, words: { type: 'integer', minimum: 1 } },
  } } },
};

// 小节文件名由目录 ID 确定，避免中文标题重名或包含 Windows 路径字符。
function sectionFile(id) {
  return `正文/${encodeURIComponent(id)}.html`;
}

// 把生效字数配置直接告诉模型；不再按全文上限折算单节目标。
function wordInstructions(control, checkTotalWords) {
  const range = control.sectionWords > 0
    ? `建议约 ${control.sectionWords} 字，不设小节硬性上下限`
    : '不限制';
  return `全文最少字数：${control.minimumWords || '不限制'}；全文最多字数：${control.maximumWords || '不限制'}。\n每个 AI 小节：${range}。\n全文字数要求是整体目标，不是单节目标。${checkTotalWords ? '本轮全部目标生成完成后，由主 Agent 统一检查总字数并组织必要的调整；并发写作任务只负责本节，不独立承担全文目标。' : '本次仅统计目标小节字数，不依据全文上下限扩缩写本次小节；不得将全文目标分摊为本次各节的写作要求。'}字数统计不含 HTML 标签及配图提示词。`;
}

// 将当前事实模式翻译为统一中文要求，主会话与并发任务共用输入快照。
function globalFactsInstructions(mode) {
  const requirement = mode === 'placeholder'
    ? '事实缺失处理方式：保留正文中需要说明的事项；核对相关参考材料后仍无法确定的具体事实，以“【待填写】”标记。已有占位符保持原样，不自行补入具体值。'
    : mode === 'omit'
      ? '事实缺失处理方式：保留必要事项，并采用不依赖未知具体值的概括性表述。未经参考材料提供，不得补入具体人员、时间、地点、业绩、证书或规格型号。'
      : '事实缺失处理方式：核对相关参考材料后仍缺少必要信息时，允许结合项目背景补充设定。新增设定应符合项目语境，并在各小节中保持一致。';
  return `${requirement} 补充事实前，应先核对相关参考材料和全局事实设定。只有未找到明确依据时，才适用当前事实缺失处理方式；材料与全局事实冲突时，以全局事实为准。允许补充设定只适用于缺失信息，不得覆盖或改变全局事实。禁止生成没有实际依据的引用。`;
}

// 正文写作共用规则，事实要求由编排决策中的同一段中文说明提供。
function writingInstructions(hasKnowledgeBase) {
  return `根据项目背景、章节描述和编排重点编写投标正文。明确说明与本节相关的实施措施、执行条件、责任分工或交付成果。内容应准确、具体、可执行，使用正式、简洁的书面语言，避免宣传性表述、缺少具体内容的概括和重复表达。\n使用参考资料时，应将适用内容整理为当前项目的方案表述，不在正文中提及${hasKnowledgeBase ? '知识库、' : ''}历史文档或素材来源。涉及具体事实时，以全局事实设定为准。\n只输出受限 HTML 正文，不输出 Markdown、代码围栏、外层章节标题或解释。内部层次用普通段落、列表或无编号加粗引导语；有序列表仅用于步骤、流程和时间顺序。`;
}

// 按本轮可配图目标分配布局组数；整数余数避免浮点误差改变同分顺序。
function buildImageLayoutQuota(sections, options) {
  const total = options.imageQuantity !== 'none' && (options.useAiImages || options.useHtmlImages || options.useMermaidImages)
    ? sections.filter(section => section.content_plan?.image_needed === true).length : 0;
  const layouts = ['single', 'imageText', 'threeImages', 'fourImages'];
  const weights = options.imageQuantity === 'heavy' ? [2, 2, 3, 3] : [4, 4, 2, 0];
  const groups = weights.map(weight => Math.floor(total * weight / 10));
  const remaining = total - groups.reduce((sum, count) => sum + count, 0);
  const order = weights.map((weight, index) => ({ index, remainder: total * weight % 10 }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of order.slice(0, remaining)) groups[index] += 1;
  return { total_groups: total, ...Object.fromEntries(layouts.map((layout, index) => [layout, groups[index]])) };
}

// 共用配图规则说明布局分工；全局名额只供主 Agent 分配，不交给各并发小节重复承担。
function imageInstructions(options) {
  const mode = {
    none: '无图：不安排配图、不留图片占位、不调用配图工具。',
    light: '少图：按本轮布局名额安排单张图片、图片表格和三列图片。',
    heavy: '多图：按本轮布局名额安排单张图片、图片表格、三列图片和四宫格。',
  }[options.imageQuantity];
  const aiPreference = options.imageQuantity !== 'none' && options.useAiImages
    ? '本轮批量生成的新增配图以 AI 生成为主，AI 图片目标占比为 60%。主 Agent 在并发写作前统筹本轮目标，不要求每个小节分别达到该比例；并发写作模型只执行本节分配，不独立承担占比目标。优先从正文中寻找适合实物、场景、效果、物理结构、工艺、操作等可视化表达的主题，再按配图类型对照表确定生成方式。需要准确表达流程、逻辑或数据时继续使用对照表规定的 HTML/Mermaid，不将这些图强行改为 AI 图片。占比按实际新增图片张数计算：单张图片和图片表格各 1 张，三列图片 3 张，四宫格 4 张；原方案图片不计入分子或分母，即使格式属性为 aiImage，也不视为本轮 AI 生图。60% 是整体规划目标，不是上限，不要求精确命中；保持布局名额，不额外加图凑比例。暂停重试沿用本轮安排，已完成的新图计入本轮统计；局部生成只统计本轮新增图片，单节修改不追补全文比例。'
    : '本轮不应用 AI 图片占比目标，按已开启的生成方式及配图类型对照表安排图片；无图时不新增配图。';
  return `${mode}\n允许使用的类型：AI 图片（aiImage）${options.useAiImages ? '允许' : '不允许'}；HTML 图片（htmlImage）${options.useHtmlImages ? '允许' : '不允许'}；Mermaid 图片（mermaid）${options.useMermaidImages ? '允许' : '不允许'}。无图要求优先于类型开关；有图模式下仅使用允许的类型，三类均不允许时不安排配图或占位。\nHTML 图片允许的类型：${options.htmlImageTypes}。\nimage_needed 表示本节是否进入新增配图范围：为 false 时不新增图片；为 true 时可承接主 Agent 分配的布局。image_suitability_score 为 0～10 分的配图适配评分，用于选择更合适的布局承接小节，不用于取消本轮名额。不要求每个入选小节恰好一组，不设每节图片张数上限。\n批量生成时，主 Agent 按 image_layout_quota 完成本轮新增布局分配；并发写作模型只执行本节写作要求中的布局、组数、表达目的和生成方式，不自行改变生成方式，不自行承担或重新分配全局名额，未分配布局时不新增配图。single 为单张图片，图片本身应能表达意图；imageText 为左图右文，右侧文字解释左侧图片，仅含一张图。两者可按说明文字的必要性互换，合计组数保持不变。threeImages 为三列图片，fourImages 为四宫格，分别按分配组数执行，不自行拆成单张。组内图片围绕共同主题表达不同信息，避免重复。布局名额仅用于本轮批量生成，后续单节修改按用户要求执行，不重新分配全文名额。图片类型开关定义允许使用的生成方式，AI 占比目标用于本轮整体配图规划，各小节及全文均无须覆盖全部已开启类型。\n${aiPreference}\n根据新增图片要表达的内容和结构查阅配图类型对照表.md。未找到对应类型时，优先采用用途、结构相近类型所对应的生成方式；仍无法归类时，使用 AI 生图。始终遵守用户的图片类型开关设置：对照表仅用于确定生成方式，不代表该方式已获允许；无图模式下不新增图片；对应生成方式被关闭时，不生成该图，也不因该方式被关闭而改用其他方式。上述规则仅用于新增图片；已有原图按提供的对应关系复用，不受无图、类型开关或新增布局名额限制。`;
}

// 将整理扩写规则和当前字数交给模型，不增加程序缩写或内容审计流程。
function restorationInstructions(control, existingTotalWords) {
  return `小节包含 restored_content 时，先完整核对对应底稿，再依据当前项目、章节职责和编排重点整理正文。输出应保留底稿中的实质信息，并转换为受限 HTML；不得以重新撰写的内容替代底稿中应保留的信息。没有底稿的小节按正常流程生成，不搬用其他小节材料。\n本次启动时全文已有正文共 ${existingTotalWords} 字，全文上限 ${control.maximumWords || '不限制'}；每小节目标 ${control.sectionWords || '不限制'} 字，本节还原字数见 restored_content.words。若本节还原字数已超过小节目标，或全文已有正文已超过全文上限，则本节只整理，不扩写，不为压字数删除实质内容；未超过时按现有要求适当扩写。仅对已设置的字数目标进行比较。全文字数上限用于判断全文已有内容是否超限，不作为单个小节的目标字数；未设置的小节目标或全文上限不参与相应判断。\n保留底稿中的实质信息、技术参数、措施和承诺；与全局事实设定冲突时，以全局事实设定为准，必要时读取并核对相关事实，无依据时不擅自改动。\n保留所有原表格的数据及含义，并保留本节原图片和引用顺序。表格编排和配图设置只指导新增内容：原表格不受 table.needed 限制，原图不受无图、image_needed、类型开关限制，也不占新增布局名额。原图按 restored_content.images 中的对应关系直接使用 asset_ref，不重新生成，不留待生图占位。原图 figure 必须保留 data-yb-generation="aiImage" 以及唯一、非空的 template data-yb-role="prompt"，模板写“复用原方案图片，不重新生成”并可补充图片说明。原图统一使用 data-yb-generation="aiImage" 作为受限 HTML 格式标记。原图身份及资源路径以 restored_content.images 为准；该标记不构成调用 AI 生图的指令。保留 img、图注及其他必需属性。`;
}

// 每轮新目标更新输入快照；暂停恢复不重写，已有小节 HTML 和图片始终保留。
function buildContentGenerationFiles({ outline, targets, plans, projectOverview, globalFacts, globalFactsMode, wordControl, generationOptions, hasOriginalPlan, restoredContents, existingTotalWords, requirement, template, knowledgeBaseService, documentIds, checkTotalWords = true }) {
  if (!template) throw new Error('请先在“长嘛样”选择有效的正文模板');
  const targetIds = new Set(targets.map(({ item }) => item.id));
  const sections = [];
  const restoredFiles = [];
  function visit(items, parents = []) {
    return items.map(item => {
      const node = { id: item.id, number: item.number, title: item.title, description: item.description || '', content_mode: item.content_mode };
      if (item.children?.length) node.children = visit(item.children, [...parents, item.title]);
      else if (item.content_mode === 'ai-generate') {
        node.content_plan = plans[item.id]?.plan;
        if (targetIds.has(item.id)) {
          const content = hasOriginalPlan && restoredContents[item.id];
          if (content) {
            const file = `已还原内容/${encodeURIComponent(item.id)}.md`;
            restoredFiles.push({ path: file, content });
            node.restored_content = {
              file, words: countReadableWords(content),
              images: [...new Set(originalImageReferences(content))].map(source_ref => ({
                source_ref,
                asset_ref: `原图/${crypto.createHash('sha256').update(source_ref).digest('hex')}${path.posix.extname(decodeURIComponent(new URL(source_ref).pathname))}`,
              })),
            };
          }
          sections.push({ ...node, chapter_path: [...parents, item.title].join(' > '), file: sectionFile(item.id) });
        }
      }
      return node;
    });
  }
  const tree = visit(outline);
  const files = [
    { path: INPUT_FILES.overview, content: projectOverview || '未提供项目概述。' },
    { path: INPUT_FILES.decisions, content: JSON.stringify({ outline: tree, targets: sections, has_knowledge_base: documentIds.length > 0, table_requirement: generationOptions.tableRequirement, word_requirements: wordInstructions(wordControl, checkTotalWords), word_control: { minimumWords: wordControl.minimumWords, maximumWords: wordControl.maximumWords, checkTotalWords }, image_layout_quota: buildImageLayoutQuota(sections, generationOptions), image_requirements: imageInstructions(generationOptions), ...(hasOriginalPlan ? { restoration_requirements: restorationInstructions(wordControl, existingTotalWords) } : {}), global_facts_mode: globalFactsMode, global_facts_requirements: globalFactsInstructions(globalFactsMode), user_requirement: requirement || '' }, null, 2) },
    { path: INPUT_FILES.rules, content: fs.readFileSync(path.join(RESOURCE_DIR, INPUT_FILES.rules), 'utf8') },
    { path: INPUT_FILES.imageTypes, content: fs.readFileSync(path.join(RESOURCE_DIR, INPUT_FILES.imageTypes), 'utf8') },
    // 与模板预览共用样张，只移除示例图片引用，保留图组结构和配图提示词。
    { path: INPUT_FILES.template, content: fs.readFileSync(path.join(RESOURCE_DIR, INPUT_FILES.template), 'utf8')
      .replace(/<img\b[^>]*>/gi, tag => tag.replace(/\s+(?:src|data-yb-asset-ref)="[^"]*"/gi, '')) },
    { path: INPUT_FILES.config, content: JSON.stringify(template, null, 2) },
    { path: INPUT_FILES.facts, content: globalFacts.map(group => `## ${group.title}\n${group.content}`).join('\n\n') || '未设定全局事实。' },
    ...restoredFiles,
  ];
  if (!documentIds.length) return files;
  const references = knowledgeBaseService.readReferences(documentIds, { includeMarkdown: true, includeItems: true });
  const index = [];
  for (const id of documentIds) {
    const reference = references.find(entry => entry.document.id === id);
    if (!reference?.markdown?.trim()) throw new Error(`选中的知识库缺少完整正文：${reference?.document?.file_name || id}`);
    const file = `知识库/${encodeURIComponent(id)}.md`;
    files.push({ path: file, content: reference.markdown });
    index.push({ document_id: id, file, document: reference.document, items: reference.items.map(item => ({ id: `${id}::${item.id}`, title: item.title, resume: item.resume })) });
  }
  files.push({ path: '知识库/索引.json', content: JSON.stringify(index, null, 2) });
  return files;
}

// 首次创建会话时复制原图；恢复沿用工作区副本，不依赖原文件再次读取。
function copyRestoredImages(workspaceDir, resolveOriginalImagePath) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, INPUT_FILES.decisions), 'utf8'));
  const copied = new Set();
  for (const section of decisions.targets) {
    for (const { source_ref, asset_ref } of section.restored_content?.images || []) {
      if (copied.has(asset_ref)) continue;
      const target = path.join(workspaceDir, asset_ref);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(resolveOriginalImagePath(source_ref), target);
      copied.add(asset_ref);
    }
  }
}

// 输出边界只检查文件类型与有效正文，具体 HTML 结构按输入规范生成。
function checkSectionHtml(html) {
  const content = String(html).trim();
  if (!content.startsWith('<!-- yibiao:block -->') || content.includes('```') || !/<(?:p|ol|ul|table)\b/i.test(content) || !countHtmlWords(content)) {
    throw new Error('必须输出带 yibiao:block 分隔的有效受限 HTML 正文，不得输出 Markdown 或代码围栏');
  }
  return content;
}

// 读取实际小节文件，校验结果清单覆盖范围并重新统计字数。
function readContentGenerationResult(workspaceDir) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, INPUT_FILES.decisions), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(workspaceDir, RESULT_FILE), 'utf8'));
  const entries = new Map((manifest.sections || []).map(item => [item.section_id, item]));
  if (entries.size !== decisions.targets.length || manifest.sections.length !== decisions.targets.length) throw new Error('正文生成结果清单与本次目标小节不一致');
  const sections = decisions.targets.map(section => {
    if (entries.get(section.id)?.file !== section.file) throw new Error(`正文结果缺少小节或文件路径不匹配：${section.id}`);
    const html = checkSectionHtml(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
    validateContentImageReferences(workspaceDir, html);
    return { section_id: section.id, number: section.number, title: section.title, file: section.file, words: countHtmlWords(html) };
  });
  return { workspaceDir, sections };
}

// Agent 批量提交写作任务；复用 scoped AI 队列实现真实并发和统一取消。
function createContentGenerationTools({ aiService, agentService, signal, onActivity, imageProtection, consistency, tableCleanup, onProgress = () => {} }, { Type, workspaceDir, setActiveTools }) {
  const activity = { pending: 0 };
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  const decisions = JSON.parse(read(INPUT_FILES.decisions));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const savedIds = new Set(decisions.targets.filter(section => fs.existsSync(path.join(workspaceDir, section.file))).map(section => section.id));
  const overview = read(INPUT_FILES.overview);
  const rules = read(INPUT_FILES.rules);
  const imageTypes = read(INPUT_FILES.imageTypes);
  const template = read(INPUT_FILES.template);
  const config = read(INPUT_FILES.config);
  const validateHtml = (root, html) => { checkSectionHtml(html); validateContentImageReferences(root, html); };
  return [{
    name: 'generate-sections', label: '批量生成正文小节',
    description: `一次提交多个目标小节并发生成受限 HTML，各节独立落盘。先按本轮布局名额统一分配，将本节布局、组数、每张图的表达目的、图片类型和生成方式写入 instructions；未分配布局时明确不新增配图。先检索相关${decisions.has_knowledge_base ? '知识库和' : ''}全局事实，把需要的参考原文摘录传入。失败小节可单独重试。`,
    executionMode: 'sequential',
    parameters: Type.Object({ sections: Type.Array(Type.Object({
      section_id: Type.String(), instructions: Type.String({ description: '本节写作要求，包含主 Agent 分配的布局、组数及每张图的表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid）；未分配布局时明确“不新增配图”。' }), references: Type.String({ description: `从${decisions.has_knowledge_base ? '知识库、' : ''}全局事实检索得到的相关原文摘录，注明来源；无相关资料时填空字符串。` }),
    }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    async execute(_callId, params, toolSignal, onUpdate) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      const ids = params.sections.map(section => section.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能提交本次目标小节，同一批不能重复提交相同小节');
      activity.pending += 1;
      try {
        const results = await Promise.all(params.sections.map(async job => {
          const section = targets.get(job.section_id);
          try {
            combinedSignal.throwIfAborted();
            const restoredContext = section.restored_content
              ? `\n\n本节已还原底稿（完整内容）：\n${read(section.restored_content.file)}\n\n全局事实设定（发生冲突时以此为准）：\n${read(INPUT_FILES.facts)}`
              : '';
            const html = checkSectionHtml(await aiService.chat({
              signal: combinedSignal, logTitle: `Agent HTML正文-${section.number}-${section.title}`,
              messages: [
                { role: 'system', content: `${writingInstructions(decisions.has_knowledge_base)}\n\n本次事实处理要求：\n${decisions.global_facts_requirements}\n\n${rules}\n\n配图类型对照表（据此确定新增图片的生成类型）：\n${imageTypes}\n\n本次配图要求：\n${decisions.image_requirements}${section.restored_content ? `\n\n本节还原处理要求（原表格、原图保留规则优先于新增限制）：\n${decisions.restoration_requirements}` : ''}` },
                { role: 'user', content: `项目概述：\n${overview}\n\n本节编排决策：\n${JSON.stringify(section, null, 2)}\n\n字数要求：\n${decisions.word_requirements}\n\n用户额外要求：\n${decisions.user_requirement}\n\n受限 HTML 模板：\n${template}\n\n所选模板配置：\n${config}\n\n本节写作要求：\n${job.instructions}\n\n参考资料与事实摘录：\n${job.references || '未提供'}\n\n按本节 content_plan 执行：table.needed=false 时不新增数据表格；仅按本节写作要求中主 Agent 分配的布局、组数、表达目的和生成方式新增图片，不自行改变生成方式，不自行分配全局名额或独立承担 AI 图片占比目标；未分配布局时不新增配图；无图、无允许类型或 image_needed=false 时不留新增配图块，并发正文写作阶段只生成新增图片的受限 HTML 结构，填写生成类型、用途说明、替代文本及必要图注，暂不填写图片资源引用。主 Agent 生成图片后补入工具返回的 asset_ref；已有原图直接使用提供的资源引用。你没有文件检索或图片生成工具，仅核对本次请求提供的材料；规范中要求主 Agent 读取文件、生成图片及提交结果清单的操作不由你执行，只返回本节 HTML，不虚构图片路径。${restoredContext}` },
              ],
            }));
            combinedSignal.throwIfAborted();
            const target = path.join(workspaceDir, section.file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(`${target}.tmp`, html, 'utf8');
            fs.renameSync(`${target}.tmp`, target);
            savedIds.add(section.id);
            const result = { section_id: section.id, file: section.file, words: countHtmlWords(html), status: 'success' };
            onProgress({ ...result, completed: savedIds.size, total: targets.size });
            onUpdate?.({ content: [{ type: 'text', text: `已保存 ${section.file}（${savedIds.size}/${targets.size}）` }], details: result });
            return result;
          } catch (error) {
            return { section_id: section.id, status: 'error', error: error.message };
          }
        }));
        combinedSignal.throwIfAborted();
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }], details: { results } };
      } finally { activity.pending -= 1; }
    },
  },
  ...createContentGenerationConsistencyTools({ agentService, signal, activity, onActivity, consistency, validateHtml, validateResult: () => readContentGenerationResult(workspaceDir) }, { Type, workspaceDir }),
  ...createContentGenerationTableTools({ agentService, signal, activity, onActivity, tableCleanup, validateHtml, validateResult: () => readContentGenerationResult(workspaceDir) }, { Type, workspaceDir }),
  ...createContentGenerationWordTools({ agentService, signal, activity, onActivity, imageProtection, validateHtml }, { Type, workspaceDir, setActiveTools }),
  ...createContentGenerationImageTools({ aiService, signal }, { Type, workspaceDir })];
}

// 单个持久 Agent 负责阅读、检索、批量调度及最终文件清单。
function buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan) {
  return `你负责本次投标文件受限 HTML 正文生成，使用一个持久会话完成任务。
1. 项目概述.md、正文编排决策.json、受限HTML生成规范.md 三个文件必须完整阅读；参考正文模板.html和所选模板配置.json。模板只是结构示例，不照抄示例正文，不要求每节套用全部元素。
2. ${hasKnowledgeBase ? '已选择知识库，可通过知识库/索引.json定位参考文档。编排中的 knowledge.item_ids 对应索引条目的 id；根据条目所属文档读取相关原文。索引标题和简介用于定位，具体内容以文档原文为准。知识库和' : ''}全局事实设定.md是参考项。生成正文时，涉及人员、时间、地点、参数、职责或承诺等具体事实，应检索并阅读相关设定；不涉及的内容无需逐项阅读。一致性审计阶段的阅读范围按审计指令执行。主 Agent 负责检索并提供参考摘录，并发正文模型核对请求中提供的材料；编辑子 Agent 按需读取工作区文件。具体事实以全局事实设定为准，并遵守正文编排决策.json中的 global_facts_requirements（当前事实模式的中文要求）。
3. 只生成正文编排决策.json中targets列出的AI生成叶子小节，其他目录作上下文；遵守写作重点、表格和配图标记、全文及每小节字数要求、用户额外要求。每节输出路径已给定，禁止修改输入文件和业务数据库。${hasOriginalPlan ? '本次使用已还原底稿：阅读 restoration_requirements，并在生成每节前完整阅读其 restored_content.file；工具会自动加入本节完整底稿、原图引用对应关系和全局事实。已超过生效字数要求的底稿只整理、不扩写；冲突以全局事实设定为准。保留原表格和原图，以下配图与表格限制仅用于新增内容；原图直接引用已复制文件，不重新生图。无底稿小节按正常流程生成。' : ''}
4. 先完整阅读配图类型对照表.md及 image_requirements（用户配图要求），读取 image_layout_quota（本轮新增布局名额）：total_groups 为总组数，single、imageText、threeImages、fourImages 分别为单张图片、图片表格、三列图片、四宫格的组数。结合本轮 targets 中 image_needed=true 小节的主题、写作重点和适配评分统一分配布局，并按 image_requirements 的本轮 AI 图片占比要求，在并发写作前规划每张图的表达目的、图片类型及生成方式；名额为零时不安排新增配图。可在合适小节安排多组，不要求逐节平均分配；单张图片与图片表格可互换，但合计组数不变，三列图片和四宫格保持各自组数。暂停、失败重试沿用本轮名额，已完成的布局计入完成数量，只补未完成部分，不重新分配一整轮。检索需要的参考资料后，调用 generate-sections，一次提交多个相互独立的小节以真正并发生成；工具会自动加入本节编排、项目概述、HTML规范、模板、配图类型对照表、字数及配图要求，你负责在各节 instructions 中写明布局、组数和每组表达目的，并逐图指定图片类型和生成方式（aiImage/htmlImage/mermaid），以及本节写作要求，并提供准确的参考摘录；未分配布局的小节明确写“不新增配图”。全局名额由你统筹，不得让每个并发任务自行分配或承担整轮名额。文本并发遵循用户现有模型配置，不要使用bash或脚本直接调用外部模型。
5. 配图前完整阅读配图类型对照表.md，并遵守正文编排决策.json 的 image_requirements（用户配图要求）。无图不安排图片或占位，不调用配图工具；有图时按已分配的布局及逐图确定的生成方式完成配图；生成方式遵守类型开关和对照表，布局本身不绑定 AI、HTML 或 Mermaid，无须覆盖全部已开启类型。在当前会话中完成所需图片：AI 图调用 generate-image，通过 images 列表一次提交已确定且相互独立的多张配图需求，不逐张等待后再提交下一张；每项提供批内唯一的 image_id、prompt、size 及所需可选参数，图组内每张图使用不同标识；单张也使用一项列表。size 必填，逐图读取对应 figure 的 data-yb-size，按 square=1:1、wide=3:2、tall=3:4、panorama=16:9 选择匹配的具体生图尺寸；当前金龙 gpt-image-2-1k 的 tall 使用已验证的 768x1024。不能把画框名称作为尺寸，不得省略 size 或整批统一使用默认方图；prompt 中保留相同的宽高比例和横向/竖向构图方向，不得在整理提示词时丢失。工具内部按现有生图并发设置执行，整批返回 results 后，按 image_id 将成功项的 asset_ref 回填到对应图片，仅重新提交失败项，不重复生成成功项；HTML/Mermaid 图使用 generate-image-sources，通过 images 列表一次提交已确定且相互独立的源码生成需求；每项提供唯一 image_id、kind（html/mermaid）及 prompt，prompt 写明图片类型、表达目的、准确内容和数据，不只给文件路径或要求并发模型自行检索。HTML 项必填 frame_size，与对应正文 figure 的 data-yb-size 一致。工具只生成并保存源码，不渲染、不回填正文；按 results 中的 image_id 对应图片，对成功项使用 source_file 调用对应 render 工具，仅重试失败项，不重复生成成功源码。调用 render-html-image 时沿用该项 frame_size。设计宽度1240px，square/wide/tall/panorama对应高度1240/827/1653/698px，尺寸包含程序统一设置的四周40px内边距；以 body 为画布，用 Flex/Grid 合理铺满内部区域，不额外包一层画布或重复添加外层边距。采用正式简洁的配色和清晰层次，不在底部留下大块空白，不靠无意义文字或空卡片填满；Mermaid 图使用批量工具返回的 .mmd 源文件调用 render-mermaid-image。源码保存在图片/目录，配图 HTML 可使用 CSS，不受正文受限 HTML 标签限制。将工具返回的 asset_ref 原样写入对应 img 的 data-yb-asset-ref，不填写 src，不虚构文件路径，不把配图源码嵌入小节正文。图组中每张图片均须生成。渲染错误或 HTML layout_issues 交回当前会话修改源码并重新转图；失败不得默认为成功或改换生成方式。
6. ${resuming ? '本次继续原会话。先检查正文/已完成文件，保留有效正文、图片和源码，复用已存在且符合内容的图片引用；只补齐未完成、失败或明确需要修正的小节及图片。' : '每个小节保存为正文/下的独立HTML文件。'} 工具返回每节文件、字数和错误；对失败小节修正要求后重试，可用read/edit检查和修正已有HTML。不要删除已完成的小节。
小节 id 是固定身份，number 才是显示编号。generate-sections 的 section_id、结果清单及文件名均使用 id；不得根据显示编号改写文件路径。
7. 所有并发生成任务及配图全部完成后，先核对本轮实际新增布局与名额一致、图组内容及图片引用完整，并按 image_requirements 核对本轮新增图片的生成方式分布；AI 占比是规划目标，不因比例偏差新增失败条件或额外加图。原方案图片及布局不占新增名额，也不计入 AI 占比。核对完成后，再调用 check-word-count 统一检查实际字数，不能一边生成一边按部分结果调整。完整检查后进入图片保护阶段：只用 edit 调整正文文字，write 仅可保存正文生成结果.json；不能再调用命令、正文生成或配图工具。已插入的所有图片块（包括原图、新图、图注及提示词）、图片顺序和图片表格布局不可修改；图文表格中的普通说明文字可以调整。工具因图片保护拒绝编辑时，本次修改未写入文件。重新读取目标文件，将编辑范围限定为允许修改的普通文字，并原样保留受保护的图片块、引用、顺序和布局后重试。word_control.checkTotalWords=false 时，本次仅统计目标小节字数，不依据全文上下限扩缩写本次小节；两个边界都未设置时不做字数调整。
检查完整且尚未达标时，以字数检查工具返回的 difference 判断调整方式，该值表示实际字数距离有效上下限的不足量或超出量，不是实际总字数。差额大于10000字时调用 adjust-sections；差额为1～10000字时由主 Agent 使用 read/edit 调整；差额为0且目标完整时，无须扩缩写。根据各节内容和篇幅分配本轮增减字数，各子任务只承担分配给本节的调整量。等待本轮全部任务结束后重新检查总字数，再依据最新差额安排下一轮。并发编辑期间你不得同时修改这些文件；等本轮所有任务结束后再调用 check-word-count。可以多轮调整，每轮按最新差额重新选择方式，直到进入要求范围，不设固定轮数。不删除原表格、原图、实质信息或承诺来凑字数；无法在保留要求下达标时明确调用 report-failure，不得伪报完成。不要再使用 generate-sections 重写整节进行字数调整。
8. 检查小节覆盖、字数及所有 img 的 data-yb-asset-ref 对应图片文件已存在，图片占位全部完成后将所有本次目标写入正文生成结果.json，格式为{"sections":[{"section_id":"小节ID","file":"正文/小节ID.html","words":实际正文统计字数}]}。该JSON已预置Schema并开启自动校验；用write/edit完成，无需重复独立JSON校验。正文内容仅保存于各小节 HTML 文件。结果清单只记录小节 ID、文件路径和实际字数。完成当前正文生成阶段的全部目标和检查后，在结果清单最后一次写入或更新操作上设置 task_complete=true。
9. 提交本阶段结果后，程序会在同一会话中发出一致性审计任务；等待下一阶段要求，不自行转换 Word。
以下写作规则仅适用于小节 HTML 文件，不适用于结果清单：\n${writingInstructions(hasKnowledgeBase)}`;
}

// 新一轮目标也复用正文 Session；仅暂停恢复时继承本轮字数调整、审计与去表格进度。
async function runContentGenerationAgent({ agentService, aiService, resume, hasKnowledgeBase, hasOriginalPlan, resolveOriginalImagePath, signal, buildFiles, onCheckpoint = () => {}, onActivity, onProgress, onConsistencyProgress = () => {}, onTableCleanupProgress = () => {}, onWorkspaceReady = () => {} }) {
  const reuseSession = agentService.hasPersistentTaskSession(CONTENT_GENERATION_AGENT_TASK_KEY);
  const resuming = Boolean(resume && reuseSession);
  const files = resuming ? [] : buildFiles();
  const savedState = resuming ? agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY).state : {};
  const protectionActive = savedState.word_adjustment_started === true;
  let consistencyState = savedState.consistency || null;
  const consistency = {
    get: () => consistencyState,
    save(state) {
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { consistency: state });
      consistencyState = state;
      onConsistencyProgress(state);
    },
  };
  let tableCleanupState = savedState.table_cleanup || null;
  const tableCleanup = {
    get: () => tableCleanupState,
    save(state) {
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { table_cleanup: state });
      tableCleanupState = state;
      onTableCleanupProgress(state);
    },
  };
  let imageProtection;
  // 审计之后按用户设置续接去表格；不再返回字数调整分支。
  function finishConsistency(workspaceDir) {
    const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, INPUT_FILES.decisions), 'utf8'));
    if (decisions.table_requirement !== 'none') return { complete: true };
    tableCleanup.save({ status: 'running', section_ids: [], completed_section_ids: [] });
    imageProtection.enter(TABLE_CLEANUP_TOOLS);
    return { stage: 'table-cleaning', prompt: buildTableCleanupPrompt(tableCleanupState) };
  }
  const runId = crypto.randomUUID();
  if (reuseSession) agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
    run_id: runId, status: 'running', agent_connection: 'running', error: null,
    ...(!resuming ? { phase: 'generating', word_adjustment_started: false, consistency: null, table_cleanup: null, layout_check: null } : {}),
  });
  const result = await agentService.runTask({
    task_id: runId, title: '投标文件正文生成', primary_session: true, summary_enabled: false,
    prompt: tableCleanupState ? buildTableCleanupPrompt(tableCleanupState) : consistencyState ? buildConsistencyPrompt(consistencyState, hasKnowledgeBase, hasOriginalPlan) : `${reuseSession && !resuming ? '本次为目录变更后的局部生成任务，在原会话中执行。重新读取已更新的输入文件，仅对当前 targets 执行生成、调整和修复；本轮完成状态根据当前目标重新确认，不沿用上一轮的完成结论。保留其他小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。\n' : ''}${buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan)}${protectionActive ? '\n本次恢复时已处于图片保护阶段，正文和配图已经就绪，只继续文字调整及结果清单保存，不重新生成正文或图片。' : ''}`, output_file: RESULT_FILE,
    files, signal,
    persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: reuseSession ? 'resume' : 'create' },
    initial_stage: tableCleanupState ? 'table-cleaning' : consistencyState ? 'auditing' : 'generating', max_retries: 1, timeout_ms: 30 * 60 * 1000,
    json_validation_schemas: { [RESULT_FILE]: RESULT_SCHEMA }, auto_validate_json: true,
    before_tool_call: context => {
      if (tableCleanupState?.status === 'completed' && ['edit', 'write', 'remove-section-tables'].includes(context.toolCall.name)) {
        throw new Error('去表格已经完成，请标记任务完成，不再修改正文');
      }
      if (!tableCleanupState && consistencyState && consistencyState.status !== 'running' && ['edit', 'write', 'repair-sections'].includes(context.toolCall.name)) {
        throw new Error('本轮审计结论已经提交，请标记任务完成并等待程序进入下一阶段');
      }
      imageProtection.beforeToolCall(context);
    },
    before_file_write: context => imageProtection.beforeWrite(context),
    create_tools: context => {
      if (hasOriginalPlan && !resuming) copyRestoredImages(context.workspaceDir, resolveOriginalImagePath);
      const decisions = JSON.parse(fs.readFileSync(path.join(context.workspaceDir, INPUT_FILES.decisions), 'utf8'));
      imageProtection = createContentImageProtection({
        workspaceDir: context.workspaceDir, files: decisions.targets.map(section => section.file),
        active: protectionActive || Boolean(consistencyState) || Boolean(tableCleanupState), ...(tableCleanupState ? { toolNames: TABLE_CLEANUP_TOOLS } : consistencyState ? { toolNames: CONSISTENCY_TOOLS } : {}), allowManifest: true, setActiveTools: context.setActiveTools,
        onEnter: () => agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { word_adjustment_started: true }),
      });
      onWorkspaceReady(context.workspaceDir);
      if (tableCleanupState) onTableCleanupProgress(tableCleanupState);
      else if (consistencyState) onConsistencyProgress(consistencyState);
      return createContentGenerationTools({ aiService, agentService, signal, onProgress, onActivity, imageProtection, consistency, tableCleanup }, context);
    },
    validateOutput: (_result, context) => readContentGenerationResult(context.workspace_dir),
    // 字数不达标时继续同一主会话，不使用旧调整阶段或固定重试轮数。
    continueTask: (_result, context) => {
      // 后处理分支必须先于字数检查，修复和去表格之后不再调整字数。
      if (tableCleanupState) {
        if (tableCleanupState.status === 'completed') return { complete: true };
        return { stage: 'table-cleaning', prompt: buildTableCleanupPrompt(tableCleanupState) };
      }
      if (consistencyState) {
        if (consistencyState.status === 'completed') return finishConsistency(context.workspace_dir);
        if (consistencyState.status === 'round-completed') {
          if (!consistencyState.remaining_issues.length || consistencyState.round >= 3) {
            consistency.save({ ...consistencyState, status: 'completed' });
            return finishConsistency(context.workspace_dir);
          }
          consistency.save({ ...consistencyState, round: consistencyState.round + 1, status: 'running', summary: '' });
        }
        return { stage: 'auditing', prompt: buildConsistencyPrompt(consistencyState, hasKnowledgeBase, hasOriginalPlan) };
      }
      const words = checkWordCount(context.workspace_dir);
      if (words.in_range) {
        consistency.save({ round: 1, status: 'running', remaining_issues: [], failed_sections: [], summary: '' });
        imageProtection.enter(CONSISTENCY_TOOLS);
        return { stage: 'auditing', prompt: buildConsistencyPrompt(consistencyState, hasKnowledgeBase, hasOriginalPlan) };
      }
      imageProtection.enter();
      return { stage: 'generating', prompt: `正文尚未满足总字数要求：${JSON.stringify(words)}。所有并发任务结束后复查；以检查结果 difference（距离有效字数范围的差额，不是实际总字数）决定调整方式：大于10000字调用 adjust-sections，为1～10000字时由主 Agent 用原生 edit 调整。继续调整并更新结果清单；不得改变输入要求或删除实质内容，确实无法满足时调用 report-failure。` };
    },
    onCheckpoint: checkpoint => onCheckpoint({ ...checkpoint, task_key: CONTENT_GENERATION_AGENT_TASK_KEY, run_id: runId }),
    onActivity,
  });
  signal.throwIfAborted();
  const output = readContentGenerationResult(result.workspace_dir);
  agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
    status: 'success', phase: 'completed', agent_connection: 'idle', error: null, completed_at: new Date().toISOString(),
  });
  return output;
}

// 正文完成后续接原主会话，主 Agent 分配补写，子 Agent 用已有 edit 能力直接修改各自文件。
async function runContentLayoutAgent({ agentService, signal, layout, onCheckpoint, onActivity }) {
  agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'running', phase: 'layout-checking', agent_connection: 'running' });
  await agentService.runTask({
    task_id: crypto.randomUUID(), title: '正文格式自检补写', primary_session: true, summary_enabled: false,
    persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: 'resume' },
    initial_stage: 'layout-checking', active_tools: LAYOUT_TOOLS, files: [],
    prompt: buildLayoutPrompt(layout.get()), output_file: RESULT_FILE,
    signal, max_retries: 1, timeout_ms: 30 * 60 * 1000,
    create_tools: context => createContentGenerationLayoutTools({
      agentService, signal, layout, onActivity,
      validateHtml(root, html) { checkSectionHtml(html); validateContentImageReferences(root, html); },
      validateResult: () => readContentGenerationResult(context.workspaceDir),
    }, context),
    validateOutput: (_result, context) => readContentGenerationResult(context.workspace_dir),
    continueTask: () => layout.get().status === 'rechecking' ? { complete: true }
      : { stage: 'layout-checking', prompt: buildLayoutPrompt(layout.get()) },
    onCheckpoint, onActivity,
  });
  signal.throwIfAborted();
  agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'success', phase: 'completed', agent_connection: 'idle' });
}

module.exports = { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, runContentLayoutAgent, readContentGenerationResult, checkSectionHtml };
