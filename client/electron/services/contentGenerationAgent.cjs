const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { findHtmlStructureIssues, assertHtmlStructure, closeOpenTemplates } = require('../utils/htmlStructure.cjs');
const { originalImageReferences } = require('./originalPlanRestoration.cjs');
const { createContentGenerationImageTools, validateContentImageReferences } = require('./contentGenerationImageTools.cjs');
const { AI_IMAGE_STYLES } = require('./aiImageStyles.cjs');
const { WORD_ADJUST_TOOL, WORD_ADJUST_TOOLS, countHtmlWords, planWordAdjustment, createWordAdjustState, buildWordAdjustPrompt, createContentGenerationWordTools } = require('./contentGenerationWordTools.cjs');
const { TASK_FILE_WRITING, taskFilePath, taskFileSchemas, readTaskFile, writeListFile, clearTaskArtifacts, compactResults } = require('./contentGenerationTaskFiles.cjs');
const { SUBMISSION_FIX_TOOL, SUBMISSION_FIX_PARALLEL_THRESHOLD, imageStructure, createContentImageProtection, createSubmissionFixTool } = require('./contentGenerationEditTools.cjs');
const { warmPromptPrefix, sharedPrefixMessages } = require('../utils/promptPrefixCache.cjs');
const { createAiBatchGuard, isBatchCancelled } = require('../utils/aiBatchGuard.cjs');
const { CONSISTENCY_TOOLS, LEDGER_FILE, LEDGER_JSON, extractConsistencyLedger, buildConsistencyPrompt, collectConsistencySubmissionIssues, createContentGenerationConsistencyTools } = require('./contentGenerationConsistencyTools.cjs');
const { TABLE_CLEANUP_TOOL, TABLE_CLEANUP_TOOLS, hasDataTables, buildTableCleanupPrompt, createContentGenerationTableTools } = require('./contentGenerationTableTools.cjs');
const { LAYOUT_TOOL, LAYOUT_TOOLS, buildLayoutPrompt, createContentGenerationLayoutTools } = require('./contentGenerationLayoutTools.cjs');

const CONTENT_GENERATION_AGENT_TASK_KEY = 'technical-plan-content-generation';
// 阶段要求已在原会话发出后，续跑和同阶段续接只发送这一句，由 Agent 依据会话历史和工作区继续。
const CONTINUE_PROMPT = '继续之前的任务';
const RESULT_FILE = '正文生成结果.json';
const RESOURCE_DIR = path.join(__dirname, '../resources/content-generation');
const INPUT_FILES = {
  overview: '项目概述.md',
  decisions: '正文编排决策.json',
  outline: '正文完整目录.json',
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
const resultAjv = new Ajv({ allErrors: true, strict: true });
const validateResultManifest = resultAjv.compile(RESULT_SCHEMA);
// 受保护文件分组：已有小节正文（本轮目标除外）、复制的原方案图片和程序生成的一致性台账。
const BASELINE_GROUPS = { sections: 'content-sections', originalImages: 'original-images', ledger: 'consistency-ledger' };

// 程序写入台账后刷新登记，Agent 改动的台账在提交校验前还原。
const protectLedger = (baseline, workspaceDir) => baseline?.setGroup(BASELINE_GROUPS.ledger,
  [LEDGER_JSON, LEDGER_FILE].filter(file => fs.existsSync(path.join(workspaceDir, file))));

// Runtime 在发出阶段要求前记录 prompted_stage；与当前阶段一致说明该阶段要求已在会话中。
function wasStagePrompted(state, stage) {
  return Boolean(stage) && state?.prompted_stage === stage;
}

// 工作区内已有的全部小节正文，供新一轮开始时登记保护。
function listSectionFiles(workspaceDir) {
  const dir = path.join(workspaceDir, '正文');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.html')).map(name => `正文/${name}`) : [];
}

// 小节文件名由目录 ID 确定，避免中文标题重名或包含 Windows 路径字符。
function sectionFile(id) {
  return `正文/${encodeURIComponent(id)}.html`;
}

// 每个写作模型只承担本节目标；全文字数由主会话统一统计。
function wordInstructions(control, checkTotalWords) {
  return `全文最少字数：${control.minimumWords || '不限制'}；全文最多字数：${control.maximumWords || '不限制'}。\n每节按 content_plan.target_words 指定的目标字数安排篇幅，0 表示不设目标；尽量接近目标，不为凑字数重复表达或删除必要信息。目标已经在编排阶段分配，不再自行分摊全文目标，也不让单个小节承担全文目标。${checkTotalWords ? '本轮全部目标生成完成后，由主 Agent 统一检查总字数。' : '本次仅统计目标小节字数，不承担全文字数达标。'}字数统计不含 HTML 标签及配图提示词。`;
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
  return `根据项目背景、章节描述和编排重点编写投标正文。明确说明与本节相关的实施措施、执行条件、责任分工或交付成果。内容应准确、具体、可执行，使用正式、简洁的书面语言，避免宣传性表述、缺少具体内容的概括和重复表达。\n使用参考资料时，应将适用内容整理为当前项目的方案表述，不在正文中提及${hasKnowledgeBase ? '知识库、' : ''}历史文档或素材来源。全局事实设定用于统一项目事实口径，不是本节必须逐项覆盖的写作清单。本节内容范围以标题、章节描述和编排重点为准。仅在说明本节内容确有需要时使用相关事实，不为覆盖全局事实增加无关段落，也不在各节重复罗列项目概况、人员、设备或制度。写作内容和全局事实不冲突即可，不要求完全引用全局事实。全局事实未明确的信息，按本次事实缺失处理要求执行。\n只输出受限 HTML 正文，不输出 Markdown、代码围栏、外层章节标题或解释。除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。篇幅较长时也要先保证 HTML 结构完整。内部层次用普通段落、列表或无编号加粗引导语；有序列表仅用于步骤、流程和时间顺序。\n正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\\(...\\)、\\[...\\] 及 \\frac、\\text、\\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。`;
}

// 按本轮可配图目标分配布局组数；整数余数避免浮点误差改变同分顺序。
function buildImageLayoutQuota(sections, options) {
  const total = options.imageQuantity > 0 && (options.useAiImages || options.useHtmlImages || options.useMermaidImages)
    ? sections.filter(section => section.content_plan?.image_needed === true).length : 0;
  const layouts = ['single', 'imageText', 'threeImages', 'fourImages'];
  const weights = options.imageQuantity >= 60 ? [4, 3, 2, 1]
    : options.imageQuantity >= 40 ? [5, 3, 2, 0]
      : options.imageQuantity >= 20 ? [8, 2, 0, 0] : [10, 0, 0, 0];
  const groups = weights.map(weight => Math.floor(total * weight / 10));
  const remaining = total - groups.reduce((sum, count) => sum + count, 0);
  const order = weights.map((weight, index) => ({ index, remainder: total * weight % 10 }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of order.slice(0, remaining)) groups[index] += 1;
  return { total_groups: total, ...Object.fromEntries(layouts.map((layout, index) => [layout, groups[index]])) };
}

// 共用配图规则说明布局分工；全局名额只供主 Agent 分配，不交给各并发小节重复承担。
function imageInstructions(options) {
  const mode = options.imageQuantity > 0
    ? '配图：按本轮布局名额安排各类图片，名额为零的布局不使用。'
    : '无图：不安排配图、不留图片占位、不调用配图工具。';
  const aiPreference = options.imageQuantity > 0 && options.useAiImages
    ? '本轮批量生成的新增配图以 AI 生成为主，AI 图片目标占比为 60%。主 Agent 在并发写作前统筹本轮目标，不要求每个小节分别达到该比例；并发写作模型只执行本节分配，不独立承担占比目标。优先从正文中寻找适合实物、场景、效果、物理结构、工艺、操作等可视化表达的主题，再按配图类型对照表确定生成方式。需要准确表达流程、逻辑或数据时继续使用对照表规定的 HTML/Mermaid，不将这些图强行改为 AI 图片。占比按实际新增图片张数计算：单张图片和图片表格各 1 张，三列图片 3 张，四宫格 4 张；原方案图片不计入分子或分母，即使格式属性为 aiImage，也不视为本轮 AI 生图。60% 是整体规划目标，不是上限，不要求精确命中；保持布局名额，不额外加图凑比例。暂停重试沿用本轮安排，已完成的新图计入本轮统计；局部生成只统计本轮新增图片，单节修改不追补全文比例。'
    : '本轮不应用 AI 图片占比目标，按已开启的生成方式及配图类型对照表安排图片；无图时不新增配图。';
  // 画面差异化只约束 AI 图片画什么、怎么画，不改变数量、占比和布局名额。
  const aiDiversity = options.imageQuantity > 0 && options.useAiImages
    ? `\nAI 图片画面差异化：每张新增 AI 图片确定画面类型（配图类型对照表中的 AI 类型）、主体、视角景别（特写、中景、全景、鸟瞰、轴测、剖切等）和画面形式。画面形式可选：${Object.values(AI_IMAGE_STYLES).map(({ label, usage }) => `${label}（${usage}）`).join('、')}。全文 AI 图片在画面类型、主体、视角景别和画面形式上分散，避免多数图片都表现人员在工位或现场作业；管理、值守、协同类内容可改为表现设备实物、系统构成、空间全貌、作业对象细节或成果状态，相邻小节不重复相同组合。图组内的 AI 图片围绕共同主题，至少在主体或视角景别上明显不同；按步骤拆分时同时变换景别和主体，例如作业全景、部件特写、终端或仪表特写、完成状态，不能同一场景同一构图只换动作。同一图组使用同一画面形式，全文按内容选用多种画面形式。AI 图片提示词按主体、可见元素、视角景别与构图、环境光线正向描述画面，写出区分本图的具体视觉元素；不虚构的范围是数值、型号、品牌、单位名称和可读文字，设备外形、材质、空间、光线等示意性细节应具体描述，不堆叠否定约束。`
    : '';
  return `${mode}\n允许使用的类型：AI 图片（aiImage）${options.useAiImages ? '允许' : '不允许'}；HTML 图片（htmlImage）${options.useHtmlImages ? '允许' : '不允许'}；Mermaid 图片（mermaid）${options.useMermaidImages ? '允许' : '不允许'}。无图要求优先于类型开关；有图模式下仅使用允许的类型，三类均不允许时不安排配图或占位。\nHTML 图片允许的类型：${options.htmlImageTypes}。\nimage_needed 表示本节是否进入新增配图范围：为 false 时不新增图片；为 true 时可承接主 Agent 分配的布局。image_suitability_score 为 0～10 分的配图适配评分，用于选择更合适的布局承接小节，不用于取消本轮名额。不要求每个入选小节恰好一组，不设每节图片张数上限。\n批量生成时，主 Agent 按 image_layout_quota 完成本轮新增布局分配；并发写作模型只执行本节配图安排中的布局、组数、表达目的和生成方式，不自行改变生成方式，不自行承担或重新分配全局名额，未分配布局时不新增配图。single 为单张图片，图片本身应能表达意图；imageText 为左图右文，右侧文字解释左侧图片，仅含一张图。两者分别按分配组数执行，不互换名额。threeImages 为三列图片，fourImages 为四宫格，分别按分配组数执行，不自行拆成单张。组内图片围绕共同主题表达不同信息，避免重复。布局名额仅用于本轮批量生成，后续单节修改按用户要求执行，不重新分配全文名额。图片类型开关定义允许使用的生成方式，AI 占比目标用于本轮整体配图规划，各小节及全文均无须覆盖全部已开启类型。\n${aiPreference}${aiDiversity}\n根据新增图片要表达的内容和结构查阅配图类型对照表.md。未找到对应类型时，优先采用用途、结构相近类型所对应的生成方式；仍无法归类时，使用 AI 生图。始终遵守用户的图片类型开关设置：对照表仅用于确定生成方式，不代表该方式已获允许；无图模式下不新增图片；对应生成方式被关闭时，不生成该图，也不因该方式被关闭而改用其他方式。上述规则仅用于新增图片；已有原图按提供的对应关系复用，不受无图、类型开关或新增布局名额限制。`;
}

// 将整理扩写规则和当前字数交给模型，不增加程序缩写或内容审计流程。
function restorationInstructions(control, existingTotalWords) {
  return `小节包含 restored_content 时，先完整核对对应底稿，再依据当前项目、章节职责和编排重点整理正文。输出应保留底稿中的实质信息，并转换为受限 HTML；不得以重新撰写的内容替代底稿中应保留的信息。没有底稿的小节按正常流程生成，不搬用其他小节材料。\n本次启动时全文已有正文共 ${existingTotalWords} 字，全文上限 ${control.maximumWords || '不限制'}；每小节目标见本节 content_plan.target_words，0 表示不限制；本节还原字数见 restored_content.words。若本节还原字数已超过小节目标，或全文已有正文已超过全文上限，则本节只整理，不扩写，不为压字数删除实质内容；未超过时按现有要求适当扩写。仅对已设置的字数目标进行比较。全文字数上限用于判断全文已有内容是否超限，不作为单个小节的目标字数；未设置的小节目标或全文上限不参与相应判断。\n保留底稿中的实质信息、技术参数、措施和承诺；与全局事实设定冲突时，以全局事实设定为准，必要时读取并核对相关事实，无依据时不擅自改动。\n保留所有原表格的数据及含义，并保留本节原图片和引用顺序。表格编排和配图设置只指导新增内容：原表格不受 table.needed 限制，原图不受无图、image_needed、类型开关限制，也不占新增布局名额。原图按 restored_content.images 中的对应关系直接使用 asset_ref，不重新生成，不留待生图占位。原图 figure 必须保留 data-yb-generation="aiImage" 以及唯一、非空的 template data-yb-role="prompt"，模板写“复用原方案图片，不重新生成”并可补充图片说明。原图统一使用 data-yb-generation="aiImage" 作为受限 HTML 格式标记。原图身份及资源路径以 restored_content.images 为准；该标记不构成调用 AI 生图的指令。保留 img、图注及其他必需属性。`;
}

// 每轮新目标更新输入快照；暂停恢复不重写，已有小节 HTML 和图片始终保留。
function buildContentGenerationFiles({ outline, targets, plans, sectionStates = {}, projectOverview, globalFacts, globalFactsMode, wordControl, generationOptions, hasOriginalPlan, restoredContents, existingTotalWords, requirement, template, knowledgeBaseService, documentIds, checkTotalWords = true }) {
  if (!template) throw new Error('请先在“长嘛样”选择有效的正文模板');
  const targetIds = new Set(targets.map(({ item }) => item.id));
  const sections = [];
  const completedSections = [];
  let totalAiSections = 0;
  const restoredFiles = [];
  function visit(items, parents = []) {
    return items.map(item => {
      const node = { id: item.id, number: item.number, title: item.title, description: item.description || '', content_mode: item.content_mode };
      if (item.children?.length) node.children = visit(item.children, [...parents, item.title]);
      else if (item.content_mode === 'ai-generate') {
        totalAiSections++;
        if (targetIds.has(item.id)) {
          const section = { ...node, content_plan: plans[item.id]?.plan, chapter_path: [...parents, item.title].join(' > '), file: sectionFile(item.id) };
          const content = hasOriginalPlan && restoredContents[item.id];
          if (content) {
            const file = `已还原内容/${encodeURIComponent(item.id)}.md`;
            restoredFiles.push({ path: file, content });
            section.restored_content = {
              file, words: countReadableWords(content),
              images: [...new Set(originalImageReferences(content))].map(source_ref => ({
                source_ref,
                asset_ref: `原图/${crypto.createHash('sha256').update(source_ref).digest('hex')}${path.posix.extname(decodeURIComponent(new URL(source_ref).pathname))}`,
              })),
            };
          }
          sections.push(section);
        } else {
          node.content_plan = plans[item.id]?.plan;
          if (sectionStates[item.id]?.status === 'success') {
            completedSections.push({ id: item.id, number: item.number, title: item.title, file: sectionFile(item.id) });
          }
        }
      }
      return node;
    });
  }
  const tree = visit(outline);
  // 只汇总已保存的编排，不重新分配字数、表格或图片；完成列表是本轮启动前的快照。
  const executionSummary = {
    total_ai_sections: totalAiSections,
    target_sections: sections.length,
    completed_before_run: completedSections.length,
    target_words: sections.reduce((sum, section) => sum + (section.content_plan?.target_words || 0), 0),
    unspecified_word_target_sections: sections.filter(section => !section.content_plan?.target_words).length,
    image_candidate_ids: sections.filter(section => section.content_plan?.image_needed === true).map(section => section.id),
    table_section_ids: sections.filter(section => section.content_plan?.table?.needed === true).map(section => section.id),
  };
  const referenceFiles = {
    ...INPUT_FILES,
    ...(documentIds.length ? { knowledge_index: '知识库/索引.json' } : {}),
  };
  // 大小固定的要求和统计在前，随小节数增长的列表在后，便于分页读取时先取得全部要求。
  const files = [
    { path: INPUT_FILES.outline, content: JSON.stringify({ outline: tree }, null, 2) },
    { path: INPUT_FILES.overview, content: projectOverview || '未提供项目概述。' },
    { path: INPUT_FILES.decisions, content: JSON.stringify({ execution_summary: executionSummary, image_layout_quota: buildImageLayoutQuota(sections, generationOptions), table_requirement: generationOptions.tableRequirement, word_requirements: wordInstructions(wordControl, checkTotalWords), word_control: { minimumWords: wordControl.minimumWords, maximumWords: wordControl.maximumWords, checkTotalWords }, image_requirements: imageInstructions(generationOptions), ...(hasOriginalPlan ? { restoration_requirements: restorationInstructions(wordControl, existingTotalWords) } : {}), global_facts_mode: globalFactsMode, global_facts_requirements: globalFactsInstructions(globalFactsMode), user_requirement: requirement || '', has_knowledge_base: documentIds.length > 0, reference_files: referenceFiles, completed_sections: completedSections, targets: sections }, null, 2) },
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

// 提示词只内嵌大小固定的要求与统计数；目标、配图候选及表格 ID 等列表留在执行清单中按需读取。
function buildRunSummary({ targets: _targets, completed_sections: _completed, execution_summary: summary, ...requirements }) {
  const { image_candidate_ids: candidates = [], table_section_ids: tables = [], ...counts } = summary;
  return { execution_summary: { ...counts, image_candidate_sections: candidates.length, table_sections: tables.length }, ...requirements };
}

// 首次创建会话时复制原图；恢复沿用工作区副本，不依赖原文件再次读取。返回复制的工作区路径，供登记保护。
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
  return [...copied];
}

// 结构问题的统一修正说明，与写作规则中的结构要求一致。
const STRUCTURE_RULE = '除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。';
// 图片保护开始后不能再重新生成正文，只按结构规则修正。
const structureFixRule = protectionActive => `${STRUCTURE_RULE}${protectionActive ? '' : '出现异常结束标记的小节多为写作输出中断，在生成任务文件中给该节加 "regenerate": true 重新生成。'}`;

// 输出边界只检查文件类型与有效正文，具体 HTML 结构按输入规范生成。
function checkSectionHtml(html) {
  const content = String(html).trim();
  if (!content.startsWith('<!-- yibiao:block -->') || content.includes('```') || !/<(?:p|ol|ul|table)\b/i.test(content) || !countHtmlWords(content)) {
    throw new Error('必须输出带 yibiao:block 分隔的有效受限 HTML 正文，不得输出 Markdown 或代码围栏');
  }
  return content;
}

// 检查本节实际产物；返回可用性问题和事实，不在这里决定质量验收或修复轮数。
function inspectSectionArtifact(workspaceDir, section, { recordedImages = null, checkStructure = true } = {}) {
  const base = { section_id: section.id, number: section.number, title: section.title, file: section.file };
  const target = path.join(workspaceDir, section.file);
  if (!fs.existsSync(target)) return {
    section: { ...base, words: 0 },
    issues: [{ ...base, type: 'missing', severity: 'blocking', message: '小节 HTML 文件不存在', fixable: false }],
    facts: { has_data_tables: false },
  };
  const html = fs.readFileSync(target, 'utf8');
  const words = countHtmlWords(html);
  const issues = [];
  try { checkSectionHtml(html); }
  catch (error) { issues.push({ ...base, type: 'content', severity: 'blocking', message: error.message, fixable: Boolean(words) }); }
  try { validateContentImageReferences(workspaceDir, html); }
  catch (error) {
    if (error.code) throw error;
    issues.push({ ...base, type: 'image-ref', severity: 'blocking', message: error.message, fixable: false });
  }
  if (checkStructure) {
    for (const message of findHtmlStructureIssues(html)) {
      issues.push({ ...base, type: 'structure', severity: 'blocking', message, fixable: true });
    }
  }
  if (recordedImages && imageStructure(html) !== recordedImages.structure) {
    issues.push({ ...base, type: 'image-block', severity: 'blocking', message: '图片块、图注、提示词、图片引用、数量、顺序或图片表格布局与图片保护开始时不一致',
      original_image_blocks: recordedImages.blocks, fixable: true });
  }
  return { section: { ...base, words }, issues, facts: { has_data_tables: hasDataTables(html) } };
}

// 按当前阶段规则报告残留表格，已接受的小节仅豁免这一项质量要求。
function collectTableSubmissionIssues(inspections, acceptedSectionIds = []) {
  const accepted = new Set(acceptedSectionIds);
  return inspections.filter(item => item.facts.has_data_tables && !accepted.has(item.section.section_id)).map(item => ({
    ...item.section, type: 'table', severity: 'quality', message: '仍有数据表格，需要转换为段落或列表并保留全部信息', fixable: true,
  }));
}

// 提交修复工具复查指定小节，复用基础检查和同一份表格质量规则。
function sectionSubmissionIssues(workspaceDir, section, { imageProtection, requireNoDataTables = false, acceptedTableSectionIds = [] } = {}) {
  const inspected = inspectSectionArtifact(workspaceDir, section, { recordedImages: imageProtection?.recorded(section.file) });
  return [...inspected.issues, ...(requireNoDataTables ? collectTableSubmissionIssues([inspected], acceptedTableSectionIds) : [])];
}

// 整理现有问题清单和操作指引；修复次数及放行决定只由公共运行时负责。
function contentSubmissionInstructions(workspaceDir, issues, protectionActive) {
  const sectionIssues = issues.filter(item => item.section_id && ['missing', 'content', 'image-ref', 'structure', 'image-block', 'table'].includes(item.type));
  if (!sectionIssues.length) return '按问题说明修正当前结果，保留已完成内容和当前阶段范围。';
  const file = writeListFile(workspaceDir, 'submission', { issues: sectionIssues });
  const sectionCount = new Set(sectionIssues.map(item => item.section_id)).size;
  const manual = sectionIssues.some(item => !item.fixable);
  const route = sectionCount > SUBMISSION_FIX_PARALLEL_THRESHOLD
    ? '涉及小节超过 ' + SUBMISSION_FIX_PARALLEL_THRESHOLD + ' 个，调用 ' + SUBMISSION_FIX_TOOL + ' 并发修复' + (manual ? '，正文或图片文件缺失等子任务无法处理的问题由你直接处理' : '')
    : '由你直接修改对应小节';
  return '完整小节问题见 ' + file + '。' + route + '，修复后重新提交。图片块按清单中的原始图片块恢复，保留文字修改。' + structureFixRule(protectionActive);
}

// 一次读取清单和各节实际产物，供提交验收及程序读取共同使用。
function inspectContentArtifacts(workspaceDir, { checkStructure = true, imageProtection } = {}) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, INPUT_FILES.decisions), 'utf8'));
  const issues = [];
  const manifestPath = path.join(workspaceDir, RESULT_FILE);
  let manifest;
  const manifestIssue = message => ({ type: 'manifest', severity: 'blocking', file: RESULT_FILE, message });
  if (!fs.existsSync(manifestPath)) issues.push(manifestIssue(RESULT_FILE + ' 尚未生成'));
  else {
    const content = fs.readFileSync(manifestPath, 'utf8');
    try { manifest = JSON.parse(content); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      issues.push(manifestIssue(RESULT_FILE + ' 不是有效 JSON：' + error.message));
    }
  }
  if (manifest !== undefined) {
    if (checkStructure && !validateResultManifest(manifest)) {
      issues.push(...validateResultManifest.errors.map(error => manifestIssue(RESULT_FILE + ' ' + error.instancePath + ' ' + error.message)));
    } else if (!manifest || !Array.isArray(manifest.sections)) {
      issues.push(manifestIssue(RESULT_FILE + ' 必须包含 sections 数组'));
    } else {
      const entries = new Map(manifest.sections.map(item => [item.section_id, item]));
      if (entries.size !== decisions.targets.length || manifest.sections.length !== decisions.targets.length) {
        issues.push(manifestIssue('正文生成结果清单与本次目标小节不一致'));
      }
      for (const section of decisions.targets) {
        if (entries.get(section.id)?.file !== section.file) issues.push(manifestIssue('正文结果缺少小节或文件路径不匹配：' + section.id));
      }
    }
  }
  const inspections = decisions.targets.map(section => inspectSectionArtifact(workspaceDir, section, {
    checkStructure, recordedImages: imageProtection?.recorded(section.file),
  }));
  issues.push(...inspections.flatMap(item => item.issues));
  return { result: { workspaceDir, sections: inspections.map(item => item.section) }, issues, inspections };
}

// 程序读取当前正文；共用产物检查，不承担 Agent 的阶段质量决策。
function readContentGenerationResult(workspaceDir, { checkStructure = false, imageProtection, requireNoDataTables = false, acceptedTableSectionIds = [] } = {}) {
  const inspected = inspectContentArtifacts(workspaceDir, { checkStructure, imageProtection });
  const issues = [...inspected.issues, ...(requireNoDataTables ? collectTableSubmissionIssues(inspected.inspections, acceptedTableSectionIds) : [])];
  if (issues.length) {
    const error = new Error(issues.map(item => item.message).join('\n'));
    error.issues = issues;
    throw error;
  }
  return inspected.result;
}

// Agent 批量提交写作任务；复用 scoped AI 队列实现真实并发和统一取消。
// submissionOptions 返回当前阶段的提交校验条件，供提交问题修复工具复查小节。
// 批量请求遇服务端连续失败时 failTask 结束整个任务，避免交回 Agent 反复重试。
function createContentGenerationTools({ aiService, agentService, generationOptions = {}, hasKnowledgeBase = false, signal, onActivity, imageProtection, consistency, tableCleanup, wordAdjust, onProgress = () => {}, submissionOptions = () => ({}), failTask = () => {} }, { Type, workspaceDir, setActiveTools, baseline }) {
  const activity = { pending: 0 };
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  let input;
  // 工具可在基础编排阶段注册，首次写作时才读取程序处理后的正文输入。
  function loadInput() {
    if (!input) {
      const decisions = JSON.parse(read(INPUT_FILES.decisions));
      input = { decisions, targets: new Map(decisions.targets.map(section => [section.id, section])),
        savedIds: new Set(decisions.targets.filter(section => {
          const filePath = path.join(workspaceDir, section.file);
          return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').trim();
        }).map(section => section.id)),
        overview: read(INPUT_FILES.overview), facts: read(INPUT_FILES.facts), rules: read(INPUT_FILES.rules),
        imageTypes: read(INPUT_FILES.imageTypes), template: read(INPUT_FILES.template), config: read(INPUT_FILES.config) };
    }
    return input;
  }
  // 小节检查通过依赖传递，编辑工具只报告结果，不另开提交修复循环。
  const inspectSection = (section, options) => inspectSectionArtifact(workspaceDir, section, options);
  return [{
    name: 'generate-sections', label: '批量生成正文小节',
    description: `读取 ${taskFilePath('sections')} 中的全部小节并提交生成受限 HTML，格式为 {"sections":[{"section_id":"…","instructions":"…","references":"…"}]}，每项三个字段都必填。section_id 原样填写正文编排决策 targets 中本节的 id，不使用 number。instructions 仅填写本节新增配图安排，以及已有编排和公共规则之外确有必要的补充要求：配图安排包含布局、组数、逐图表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid），AI 图片另写明画面类型、主体、视角景别和画面形式；没有新增配图和补充要求时填空字符串，失败重试时可填写具体纠错要求。references 为${hasKnowledgeBase ? '知识库等' : ''}补充资料的相关原文摘录并注明来源，完整全局事实由程序提供，无补充资料时填空字符串。程序自动提供本节编排、完整全局事实及公共材料，无需复述目标字数、写作重点、表格安排和格式规则。已生成正文的小节自动跳过，重复提交同一任务文件不会重写；确需整节重写时该项加 "regenerate": true。${TASK_FILE_WRITING}程序队列按用户配置控制实际并发，超出上限的任务自动排队，各节独立落盘。返回 total、success、skipped 和 unresolved（失败小节及原因）；失败小节修正文件中的要求后再次提交即可。`,
    executionMode: 'sequential',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal, onUpdate) {
      const { decisions, targets, savedIds, overview, facts, rules, imageTypes, template, config } = loadInput();
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      const { sections: jobs } = readTaskFile(workspaceDir, 'sections');
      const ids = jobs.map(section => section.section_id);
      const invalid = ids.filter((id, index) => !targets.has(id) || ids.indexOf(id) !== index);
      if (invalid.length) throw new Error(`任务文件只能包含本次目标小节，且同一小节不能重复出现：${[...new Set(invalid)].join('、')}`);
      // 已生成正文视为完成，重复提交同一任务文件不重写；regenerate 明确要求整节重写。
      const generated = id => {
        const file = path.join(workspaceDir, targets.get(id).file);
        return fs.existsSync(file) && Boolean(fs.readFileSync(file, 'utf8').trim());
      };
      const skipped = new Map(jobs.filter(job => !job.regenerate && generated(job.section_id))
        .map(job => [job.section_id, { section_id: job.section_id, file: targets.get(job.section_id).file, status: 'skipped' }]));
      const pending = jobs.filter(job => !skipped.has(job.section_id));
      for (const id of skipped.keys()) savedIds.add(id);
      onActivity?.({ progress: { step: 'writing', label: '正在生成小节正文', unit: '节', total: targets.size, items: ids.map(id => ({ id, status: skipped.has(id) ? 'success' : 'running' })) } });
      activity.pending += 1;
      // 全轮相同的规则放 system、公共材料单独作为一条 user 消息，排在本节内容之前，便于模型服务复用请求前缀缓存。
      const system = `${writingInstructions(decisions.has_knowledge_base)}\n\n本次事实处理要求：\n${decisions.global_facts_requirements}\n\n${rules}\n\n配图类型对照表（据此确定新增图片的生成类型）：\n${imageTypes}\n\n本次配图要求：\n${decisions.image_requirements}\n\n写作执行要求：\n按本节 content_plan.target_words 的目标字数生成正文，0 表示不设目标；不能用全文上下限或其他小节字数代替本节目标。按本节 content_plan 执行：table.needed=false 时不新增数据表格；仅按本节配图安排与补充要求中主 Agent 分配的布局、组数、表达目的和生成方式新增图片，不自行改变生成方式；AI 图片的 template 按分配的画面类型、主体、视角景别正向描述画面，并注明画面形式名称，不自行分配全局名额或独立承担 AI 图片占比目标；未分配布局时不新增配图；无图、无允许类型或 image_needed=false 时不留新增配图块，并发正文写作阶段只生成新增图片的受限 HTML 结构，填写生成类型、用途说明、替代文本及必要图注，暂不填写图片资源引用。主 Agent 生成图片后补入工具返回的 asset_ref；已有原图直接使用提供的资源引用。你没有文件检索或图片生成工具，仅核对本次请求提供的材料；规范中要求主 Agent 读取文件、生成图片及提交结果清单的操作不由你执行，只返回本节 HTML，不虚构图片路径。`;
      const sharedInput = `项目概述：
${overview}

全局事实设定（完整内容）：
${facts}

字数要求：
${decisions.word_requirements}

用户额外要求：
${decisions.user_requirement}

受限 HTML 模板：
${template}

所选模板配置：
${config}`;
      // 服务端连续失败时停止派发剩余小节并结束任务，已保存的小节保留。
      const guard = createAiBatchGuard({ signal: combinedSignal });
      try {
        if (pending.length > 1) await warmPromptPrefix({ aiService, messages: sharedPrefixMessages(system, sharedInput), signal: guard.signal, onActivity, logTitle: 'Agent HTML正文-公共前缀预热', label: '正文公共材料' });
        const generatedResults = new Map((await Promise.all(pending.map(async job => {
          const section = targets.get(job.section_id);
          try {
            guard.signal.throwIfAborted();
            const restoredContext = section.restored_content
              ? `\n\n本节还原处理要求（原表格、原图保留规则优先于新增限制）：\n${decisions.restoration_requirements}\n\n本节已还原底稿（完整内容）：\n${read(section.restored_content.file)}`
              : '';
            // 截断的回复直接失败；提示词结束标签被写成异常标记时程序无损补齐，其余结构问题不落盘，均作为本节失败交回主 Agent 重试。
            const html = closeOpenTemplates(checkSectionHtml(extractAiSource(await aiService.chat({
              signal: guard.signal, logTitle: `Agent HTML正文-${section.number}-${section.title}`, reject_truncated_output: true,
              messages: sharedPrefixMessages(system, sharedInput, `本节编排决策：
${JSON.stringify(section, null, 2)}${restoredContext}

本节配图安排与补充要求：
${job.instructions.trim() || '无补充要求，未分配新增配图；已有原图按本节底稿要求保留。'}

补充参考资料摘录：
${job.references || '未提供'}`),
            }), 'html'))).html;
            assertHtmlStructure(html);
            guard.signal.throwIfAborted();
            guard.success();
            const target = path.join(workspaceDir, section.file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(`${target}.tmp`, html, 'utf8');
            fs.renameSync(`${target}.tmp`, target);
            savedIds.add(section.id);
            onActivity?.({ progress: { step: 'writing', label: '正在生成小节正文', unit: '节', items: [{ id: section.id, status: 'success' }] } });
            const result = { section_id: section.id, file: section.file, words: countHtmlWords(html), status: 'success' };
            onProgress({ ...result, completed: savedIds.size, total: targets.size });
            onUpdate?.({ content: [{ type: 'text', text: `已保存 ${section.file}（${savedIds.size}/${targets.size}）` }], details: result });
            return result;
          } catch (error) {
            const cancelled = isBatchCancelled(error, guard.signal);
            if (!cancelled) guard.failure(error);
            onActivity?.({ progress: { step: 'writing', label: '正在生成小节正文', unit: '节', items: [{ id: section.id, status: cancelled ? 'cancelled' : 'error' }] } });
            const result = { section_id: section.id, status: 'error', error: error.message };
            // 小节失败或取消后通知主 Agent，刷新无进展计时。
            onUpdate?.({
              content: [{ type: 'text', text: `${cancelled ? '已取消' : '生成失败'} ${section.file}：${error.message}` }],
              details: result,
            });
            return result;
          }
        }))).map(result => [result.section_id, result]));
        combinedSignal.throwIfAborted();
        if (guard.error) {
          failTask(guard.error);
          throw guard.error;
        }
        // 模型只接收统计和失败小节，逐节结果保留在 details。
        const results = ids.map(id => skipped.get(id) || generatedResults.get(id));
        return { content: [{ type: 'text', text: JSON.stringify(compactResults(results)) }], details: { results } };
      } finally { activity.pending -= 1; }
    },
  },
  ...createContentGenerationConsistencyTools({ agentService, aiService, signal, activity, onActivity, consistency, inspectSection, failTask,
    protectLedger: () => protectLedger(baseline, workspaceDir) }, { Type, workspaceDir }),
  ...createContentGenerationTableTools({ aiService, signal, onActivity, tableCleanup, failTask }, { Type, workspaceDir }),
  ...createContentGenerationWordTools({ aiService, signal, activity, onActivity, imageProtection, inspectSection, wordAdjust, failTask,
    validateHtml: html => assertHtmlStructure(checkSectionHtml(html)) }, { Type, workspaceDir, setActiveTools }),
  ...createContentGenerationImageTools({ aiService, signal, onActivity, failTask, getSections: () => JSON.parse(read(INPUT_FILES.decisions)).targets, htmlImageOptimization: generationOptions.htmlImageOptimization === true,
    beforeApply: () => imageProtection?.beforeToolCall({ toolCall: { name: 'apply-section-images' } }),
  }, { Type, workspaceDir }),
  // 进入去表格后，提交修复子任务也按当前阶段转换数据表格。
  createSubmissionFixTool({ agentService, signal, activity, onActivity,
    inspectSection,
    preserveDataTables: () => !submissionOptions().requireNoDataTables,
    readTargets: () => new Map(JSON.parse(read(INPUT_FILES.decisions)).targets.map(section => [section.id, section])),
    checkSection: section => sectionSubmissionIssues(workspaceDir, section, submissionOptions()),
    // 保护开始后按保护时的图片恢复；此前的结构修复允许调整图片包裹方式，不比对图片。
    expectedImages: section => submissionOptions().imageProtection?.recorded(section.file) || null,
    structureRule: STRUCTURE_RULE,
  }, { Type, workspaceDir })];
}

// 单个持久 Agent 负责阅读、检索、批量调度及最终文件清单；提示词只写任务和覆盖范围，读取与分批方式由 Agent 决定。
function buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan, runSummary, planningHandoff) {
  return `你负责本次投标文件受限 HTML 正文生成，使用一个持久会话完成任务。
1. 下面是程序根据正文编排决策.json整理的本轮执行摘要，包含本轮全部要求、布局名额和统计数：
${JSON.stringify(runSummary)}
${planningHandoff ? '基础编排已由程序处理并保存：字数已校正，表格和配图已按设置选定。各目标的最终字数、表格安排和配图标记以正文编排决策.json 的 targets 为准，不沿用基础编排中的草稿或候选建议；继续本会话已有的写作重点和知识条目，不重新编排，也无需重复通读未变化的目录和招标资料。' : ''}随小节数增长的内容只保存在文件中：正文编排决策.json 的 targets（本轮目标、最终编排、HTML 路径和还原材料引用）、execution_summary 中的配图候选及表格入选小节 ID、completed_sections，以及正文完整目录.json 的完整目录，按需读取或检索，读取方式自行决定，可用 read 分页，也可用 rg、jq 等命令筛选。受限HTML生成规范.md 篇幅固定，须完整阅读；项目概述.md 按需读取。参考正文模板.html和所选模板配置.json。模板只是结构示例，不照抄示例正文，不要求每节套用全部元素。
2. ${hasKnowledgeBase ? '已选择知识库，可通过知识库/索引.json定位参考文档。编排中的 knowledge.item_ids 对应索引条目的 id；根据条目所属文档读取相关原文。索引标题和简介用于定位，具体内容以文档原文为准。' : ''}程序自动向每个小节写作请求提供全局事实设定.md的完整内容，无需为传递事实重复摘录；你可按需阅读，以核实相关要求和安排配图。主 Agent 负责按需检索并提供补充资料摘录，并发正文模型核对请求中提供的材料；编辑子 Agent 按需读取工作区文件。一致性审计阶段的阅读范围按审计指令执行。遵守执行摘要中的 global_facts_requirements（当前事实模式的中文要求）。
3. 只生成正文编排决策.json中 targets 列出的 AI 生成叶子小节，完整目录按需用于了解上下级和相邻章节。执行摘要的 execution_summary 已汇总全文 AI 小节数、本轮目标数与目标字数、未设置字数目标的小节数、配图候选及表格入选小节数；image_layout_quota 已计算本轮布局名额，直接使用这些结果，对应小节 ID 见正文编排决策.json。如发现信息不一致，可读取相关文件核实。统计与检查使用程序工具的结果：布局组数、生成方式分布，以及缺少图注、data-yb-fit 或有效引用的图片以 list-section-images 返回的 summary 为准，字数以 check-word-count 为准，HTML 结构和图片块由程序在提交时统一校验；不另写脚本或中间文件重复这些统计和格式检查。completed_sections 仅记录本轮启动前已成功完成的非目标小节，不是实时进度；本轮暂停恢复时结合工具结果和实际文件继续，不能仅因 HTML 存在就认定图片、审计等步骤全部完成。遵守写作重点、表格和配图标记、全文及每小节字数要求、用户额外要求。各小节严格按照编排结果中的 content_plan.target_words 目标字数安排生成，不自行调整目标，不重新分配全文目标。字数校验可按约10%的容差判断，但该容差仅用于结果校验，不得写入 generate-sections 的补充要求或传递给正文生成模型。每节输出路径已给定，禁止修改输入文件和业务数据库。保留非目标小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。${hasOriginalPlan ? '本次使用已还原底稿：阅读执行摘要中的 restoration_requirements；工具会自动向每节写作请求加入本节完整底稿、原图引用对应关系和全局事实，各节 restored_content.file 按需阅读，用于安排配图和补充要求。已超过生效字数要求的底稿只整理、不扩写；冲突以全局事实设定为准。保留原表格和原图，以下配图与表格限制仅用于新增内容；原图直接引用已复制文件，不重新生图。无底稿小节按正常流程生成。' : ''}
4. 先完整阅读配图类型对照表.md及 image_requirements（用户配图要求），读取 image_layout_quota（本轮新增布局名额）：total_groups 为总组数，single、imageText、threeImages、fourImages 分别为单张图片、图片表格、三列图片、四宫格的组数。结合本轮 targets 中 image_needed=true 小节的主题、写作重点和适配评分统一分配布局，并按 image_requirements 的本轮 AI 图片占比要求，在并发写作前规划每张图的表达目的、图片类型及生成方式；AI 图片按 image_requirements 的画面差异化要求逐图确定画面类型、主体、视角景别和画面形式，保证全文及图组内画面分散；名额为零时不安排新增配图。可在合适小节安排多组，不要求逐节平均分配；单张图片、图片表格、三列图片和四宫格分别保持各自组数，不互换名额。暂停、失败重试沿用本轮名额，已完成的布局计入完成数量，只补未完成部分，不重新分配一整轮。检索需要的参考资料并完成本轮安排后，将本轮待生成小节写入 ${taskFilePath('sections')}，格式为 {"sections":[{"section_id":"targets 中的小节 id","instructions":"本节补充要求","references":"补充资料摘录"}]}；每项都必须包含 section_id、instructions 和 references，section_id 原样使用 targets 中对应小节的 id，无参考摘录时 references 填空字符串，不省略字段。写完后调用 generate-sections 提交：程序读取文件中的全部小节，AI 服务队列按用户设置的并发上限运行，超出上限的任务自动排队，空出名额后自动启动后续任务，无需你控制批次。已生成正文的小节自动跳过，确需整节重写时给该项加 "regenerate": true；暂停恢复或失败重试时可直接再次提交，失败项先在文件中修正要求。任务/ 目录下的任务文件是程序工具的输入，已预置 Schema，可用 json-validation 自查，提交工具读取时校验。${TASK_FILE_WRITING}工具会自动加入本节编排、项目概述、HTML规范、模板、配图类型对照表、字数及配图要求，直接使用已保存编排，不逐节重写写作重点或扩展详细提纲，段落组织由正文写作模型根据编排完成。instructions 只补充本节配图布局、组数、逐图表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid），AI 图片另含画面类型、主体、视角景别和画面形式，以及确有必要的特殊要求；无需复述目标字数、写作重点、表格安排、全局事实和公共格式规则，也不重复编写图片标签、属性、编号或完整生图提示词，这些由正文写作模型按规范生成。没有新增配图和补充要求时 instructions 填空字符串，程序将其解释为无补充要求、未分配新增配图，已有原图仍按原规则保留。references 只提供实际需要的补充资料摘录。发现具体问题时仍可核实资料并提供针对性的修正要求，失败重试只说明需要纠正的问题。全局名额由你统筹，不得让每个并发任务自行分配或承担整轮名额。文本并发遵循用户现有模型配置，不要使用bash或脚本直接调用外部模型。
5. 正文布局保存后，调用 list-section-images：工具返回 summary，并将完整图片清单（小节、figure、生成方式、比例、提示词及当前引用）写入 程序清单/正文图片清单.json。完成本次要求的配图生成、失败项修复和正文图片引用更新，保留有效的已有成果。清单和源码的读取、任务整理及处理批次由你自主决定，可分批读取、分批保存和提交，无需一次掌握全部图片明细。发现结构或提示词问题可 read/edit 修复后按 section_ids 重新提取。image_id 原样沿用到图片工具和回填工具，不能自行重编；reused_original=true 的图片直接复用，文件缺失时修复原引用，不重新生图。已有有效图片无需重复生成。配图前完整阅读配图类型对照表.md，并遵守 image_requirements（用户配图要求）。无图不安排图片或占位，不调用配图工具；有图时按已分配的布局及逐图确定的生成方式完成配图；生成方式遵守类型开关和对照表，布局本身不绑定 AI、HTML 或 Mermaid，无须覆盖全部已开启类型。在当前会话中完成所需图片：将本轮待生成的 AI、HTML、Mermaid 图片写入 ${taskFilePath('images')}，格式为 {"images":[{"image_id":"清单标识","kind":"ai/html/mermaid","prompt":"…"}]}，写完后调用 generate-section-images 提交；每项提供清单 image_id、kind、prompt。AI 项 size 必填，逐图读取对应 figure 的 data-yb-size，按 square=1:1、wide=3:2、tall=3:4、panorama=16:9 选择匹配的具体生图尺寸；当前金龙 gpt-image-2-1k 的 tall 使用已验证的 768x1024。不能把画框名称作为尺寸，不得省略 size 或统一使用默认方图；prompt 中保留相同的宽高比例和横向/竖向构图方向。AI 项 style 必填，按 template 注明的画面形式选择对应值；prompt 正向描述画面，不写与 style 冲突的风格，也不重复罗列品牌、水印、无关文字等由程序统一追加的限制。HTML 项必填 frame_size，与正文画框一致。HTML/Mermaid 的 prompt 写明图片类型、表达目的、准确内容和数据，不只给文件路径或要求并发模型自行检索。程序读取全部条目，同时向既有生图和文本队列提交任务，超限自动排队；每张源码生成完成立即本地转图，不等其他源码或 AI 图完成。已有有效图片的项自动跳过，需要替换已有图片时该项加 "regenerate": true，原方案图片不重新生成。每张成功图片由程序立即回填正文；提交结束后按返回的 unresolved 逐项检查 status、stage 和 error，按工具说明处理未成功项。有 source_file 的失败或未完成项直接读取、必要时修改源码后，按类型写入 ${taskFilePath('renderHtml')} 或 ${taskFilePath('renderMermaid')}（每项 image_id、source_file，HTML 另填 frame_size），再调用 render-html-image 或 render-mermaid-image，不重复生成成功源码；无源码的失败项才重新提交生成工具。设计宽度1240px，square/wide/tall/panorama对应高度1240/827/1653/698px，尺寸包含程序统一设置的四周40px内边距；以 body 为画布，用 Flex/Grid 合理铺满内部区域，不额外包一层画布或重复添加外层边距。采用正式简洁的配色和清晰层次，不在底部留下大块空白，不靠无意义文字或空卡片填满；Mermaid 图的语法问题通过修改已保存的 .mmd 源文件并提交 render-mermaid-image 修复。源码保存在图片/目录，配图 HTML 可使用 CSS，不受正文受限 HTML 标签限制。图片工具成功后由程序直接更新对应 img 的引用，无须再调用 apply-section-images，也不必手工编辑正文。仅对返回 applied=false 的项，按 apply_error 刷新清单后写入 ${taskFilePath('applyImages')}（每项 image_id、图片工具返回的 asset_ref 和 previous_asset_ref），再调用 apply-section-images 重试。不要回填状态非 success 的项，不填写 src，不虚构路径，不把源码嵌入正文。图组中每张图片均须生成。暂停恢复时先核对最新图片清单（成功图片已回填）与会话中工具返回的未完成项，复用已保存源码；已完成的图片再次提交时自动跳过，无源码的剩余项提交生成工具，已有源码的剩余项使用对应 render 工具。执行错误按工具反馈修复，失败不得默认为成功或改换生成方式。
6. ${resuming ? '本次继续原会话。先检查正文/已完成文件，保留有效正文、图片和源码，复用已存在且符合内容的图片引用；只补齐未完成、失败或明确需要修正的小节及图片。' : '每个小节保存为正文/下的独立HTML文件。'} 工具返回统计和失败小节；对失败小节修正要求后重试，可用read/edit检查和修正已有HTML。不要删除已完成的小节。
小节 id 是固定身份，number 才是显示编号。任务文件的 section_id、结果清单及文件名均使用 id；不得根据显示编号改写文件路径。
7. 所有并发生成任务及配图全部完成后，再次调用 list-section-images，依据 summary 核对本轮实际新增布局与名额一致、图注及图片引用完整，并按 image_requirements 核对本轮新增图片的生成方式分布及 AI 图片画面是否分散；AI 占比是规划目标，不因比例偏差新增失败条件或额外加图。原方案图片及布局不占新增名额，也不计入 AI 占比。核对完成后，再调用 check-word-count 统一检查实际字数，不能一边生成一边按部分结果调整；工具返回总字数和上下限，各节字数写入 程序清单/正文字数统计.json。完整检查后进入图片保护阶段：优先用 edit 修改正文文字，也可按需使用 bash 处理工作区文件，不能再调用正文生成或配图工具。已插入的所有图片块（包括原图、新图、图注及提示词）、图片顺序和图片表格布局不可修改；图文表格中的普通说明文字可以调整。提交时程序逐节核对图片块，不一致会退回并附上原始图片块，须原样恢复。本阶段只统计字数：统计后保持正文不变，不以任何方式（包括脚本批量删改）调整字数，如实写入结果清单并提交；字数要求由程序在本阶段提交后按设置统一处理。
8. 检查小节覆盖、字数及所有 img 的 data-yb-asset-ref 对应图片文件已存在，图片占位全部完成后将所有本次目标写入正文生成结果.json，格式为{"sections":[{"section_id":"小节ID","file":"正文/小节ID.html","words":实际正文统计字数}]}，各节字数可取自 程序清单/正文字数统计.json。该 JSON 已预置 Schema，可用 json-validation 自查，内容较多时可分多次写入。正文内容仅保存于各小节 HTML 文件。结果清单只记录小节 ID、文件路径和实际字数。本轮生成、调整和检查结束后，在结果清单最后一次写入或更新操作上设置 task_complete=true，如实提交当前产物和字数。标记完成后程序统一提交校验结果清单、各小节 HTML 结构、图片引用和图片块，并还原被改动的输入资料和非目标小节；不通过时退回问题清单（完整清单在 程序清单/提交校验问题.json），问题涉及的小节超过 ${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个时调用 ${SUBMISSION_FIX_TOOL} 并发修复，${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个及以下直接修改，按程序要求修复后重新提交；程序根据进展统一决定继续修复、更换方法或接受质量遗留问题，最低目标修复后仍有阻塞问题才停止任务。
9. 提交本阶段结果后，程序会在同一会话中发出一致性审计任务；等待下一阶段要求，不自行转换 Word。
以下写作规则仅适用于小节 HTML 文件，不适用于结果清单：\n${writingInstructions(hasKnowledgeBase)}`;
}

// 基础编排、正文与后处理共用一次主调用；暂停后仍从持久 Session 和已保存阶段恢复。
async function runContentGenerationAgent({ agentService, aiService, generationOptions = {}, resume, hasKnowledgeBase, hasOriginalPlan, resolveOriginalImagePath,
  signal, planning, prepareGeneration, buildFiles, checkLayout, onLayoutProgress = () => {}, onCheckpoint = () => {}, onActivity, onProgress,
  onWordAdjustProgress = () => {}, onConsistencyProgress = () => {}, onTableCleanupProgress = () => {}, onWorkspaceReady = () => {}, failTask = () => {} }) {
  const reuseSession = agentService.hasPersistentTaskSession(CONTENT_GENERATION_AGENT_TASK_KEY);
  const persistent = reuseSession ? agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY) : null;
  const persistentState = persistent?.state || {};
  const planningHandoff = Boolean(planning) || ['content-planning', 'restoring'].includes(persistentState.phase);
  const resuming = Boolean(resume && reuseSession && !planningHandoff);
  // 同一轮编排暂停或失败后继续，不属于新一轮任务。
  const continuingPlanning = Boolean(planning?.continuing);
  const savedState = resuming ? persistentState : {};
  const wordAdjustmentEnabled = generationOptions.wordCountRepair === true;
  const protectionActive = savedState.word_adjustment_started === true;
  let consistencyState = savedState.consistency || null;
  let tableCleanupState = savedState.table_cleanup || null;
  let layoutState = savedState.layout_check || null;
  let wordAdjustState = savedState.word_adjust || null;
  let stage = planning ? 'content-planning' : layoutState ? 'layout-checking' : tableCleanupState ? 'table-cleaning' : consistencyState ? 'auditing' : wordAdjustState ? 'word-adjusting' : 'generating';
  let toolContext;
  let imageProtection;
  let generationTools;
  let runSummary;
  const localContext = { signal, onActivity, workspace_dir: persistent?.paths?.workspaceDir };
  const currentWorkspaceDir = () => toolContext?.workspaceDir || localContext.workspace_dir;
  const consistency = { get: () => consistencyState, save(state) {
    consistencyState = state;
    agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { consistency: state });
    onConsistencyProgress(state);
  } };
  const tableCleanup = { get: () => tableCleanupState, save(state) {
    tableCleanupState = state;
    agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { table_cleanup: state });
    onTableCleanupProgress(state);
  } };
  const layout = { get: () => layoutState, save(state) {
    layoutState = state;
    stage = 'layout-checking';
    agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { layout_check: state, phase: stage });
    onLayoutProgress(state);
  } };
  const wordAdjust = { get: () => wordAdjustState, save(state) {
    wordAdjustState = state;
    agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { word_adjust: state });
    onWordAdjustProgress(state);
  } };
  // 注册时传入稳定的保护入口，实际规则在阶段切换后更新。
  const protection = {
    get active() { return Boolean(imageProtection?.active); },
    enter: names => imageProtection.enter(names),
    beforeToolCall: context => imageProtection.beforeToolCall(context),
    recorded: file => imageProtection?.recorded(file) || null,
  };
  // 修复工具沿用当前阶段规则：图片保护后比对图片块，进入去表格后检查未接受的残表格。
  const submissionOptions = () => ({ imageProtection: protection, requireNoDataTables: Boolean(tableCleanupState),
    acceptedTableSectionIds: tableCleanupState?.remaining_section_ids || [] });
  const planningTools = [...NATIVE_AGENT_TOOLS, 'json-validation', 'ask-user', 'report-failure'];
  const generationToolNames = () => [...planningTools, ...generationTools.map(tool => tool.name)];
  const prepareFiles = context => prepareGeneration ? prepareGeneration(context) : buildFiles();
  // 交接只内嵌执行摘要；目标编排等列表由 Agent 从执行清单按需读取。
  function prepareRunSummary(files) {
    runSummary = buildRunSummary(JSON.parse(files.find(file => file.path === INPUT_FILES.decisions).content));
  }
  // 只有正文输入已落盘后才建立目标与图片保护；图片记录覆盖本轮全部目标小节。
  function initializeContent() {
    const { workspaceDir, baseline } = toolContext;
    const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, INPUT_FILES.decisions), 'utf8'));
    const isLayout = stage === 'layout-checking';
    imageProtection = createContentImageProtection({
      workspaceDir, files: decisions.targets.map(section => section.file), baseline,
      active: isLayout || protectionActive || Boolean(consistencyState) || Boolean(tableCleanupState) || Boolean(wordAdjustState),
      ...(isLayout ? { toolNames: LAYOUT_TOOLS } : tableCleanupState ? { toolNames: TABLE_CLEANUP_TOOLS } : consistencyState ? { toolNames: CONSISTENCY_TOOLS } : wordAdjustState ? { toolNames: WORD_ADJUST_TOOLS } : {}),
      setActiveTools: names => toolContext.setActiveTools?.(names),
      onEnter: () => agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { word_adjustment_started: true }),
    });
    if (isLayout) return;
    // 新一轮进入生成时，本轮目标交给 Agent 生成和修改，其他已有小节保持登记。
    if (!resuming) baseline?.release(BASELINE_GROUPS.sections, decisions.targets.map(section => section.file));
    if (!resuming && hasOriginalPlan) {
      const copied = copyRestoredImages(workspaceDir, resolveOriginalImagePath);
      baseline?.setGroup(BASELINE_GROUPS.originalImages, copied);
    }
    if (!protectionActive && !consistencyState && !tableCleanupState && !wordAdjustState) toolContext.setActiveTools?.(generationToolNames());
    onWorkspaceReady(workspaceDir);
    if (tableCleanupState) onTableCleanupProgress(tableCleanupState);
    else if (consistencyState) onConsistencyProgress(consistencyState);
  }
  function next(nextStage, prompt, compaction) {
    stage = nextStage;
    return { stage, prompt, ...(compaction ? {
      compact_before_prompt: true, compaction_optional: true, compaction_stage: `${nextStage}-compaction`,
      compaction_message: '正在压缩上下文', compaction_complete_message: '上下文压缩完成', compaction_instructions: compaction,
    } : {}) };
  }
  // 进入读写量大的后续阶段前压缩历史；正文以工作区文件为准，摘要只保留流程结论。
  function compactionInstructions(nextStageName) {
    return `请用简体中文总结，供下一阶段「${nextStageName}」继续使用。保留：本轮目标小节范围及正文、图片文件的位置约定；各阶段已完成情况和程序反馈的结论；已确定的统一事实口径；尚未解决的问题、失败或待重试的小节及原因。正文、图片和台账以工作区文件为准，不在摘要中摘录正文、HTML 或台账原文，也不复述已结束阶段的操作细节。`;
  }
  const consistencyPrompt = workspaceDir => buildConsistencyPrompt(consistencyState, { hasKnowledgeBase, workspaceDir });
  const createAuditState = () => ({ status: 'extracting', extract_completed: 0, extract_total: 0, remaining_issues: [], failed_sections: [], summary: '', submission: null });
  // 小节并发核对是程序步骤：核对阶段按正文哈希复用未变化小节的结果；比对修复中恢复时只补缺失小节，不因修复改动重新核对。
  // 个别小节核对失败不中断审计，失败原因写入台账，由主 Agent 重新核对或自行核对。
  async function extractLedger(context) {
    const extractSignal = context.signal || signal;
    const ledger = await extractConsistencyLedger({ aiService, workspaceDir: context.workspace_dir, signal: extractSignal, onActivity: context.onActivity || onActivity,
      checkChanges: consistencyState.status !== 'running',
      onProgress: (completed, total) => consistency.save({ ...consistencyState, extract_completed: completed, extract_total: total }) });
    extractSignal.throwIfAborted();
    const failed = Object.keys(ledger.failures).length;
    if (failed) (context.onActivity || onActivity)?.({ message: `${failed} 个小节一致性核对失败，已写入台账交由主 Agent 重新核对或自行核对。` });
    protectLedger(context.baseline, context.workspace_dir);
    consistency.save({ ...consistencyState, status: 'running' });
  }
  function generationPrompt() {
    // 继续任务不重写输入快照，摘要从工作区已有执行清单整理。
    runSummary ||= buildRunSummary(JSON.parse(fs.readFileSync(path.join(currentWorkspaceDir(), INPUT_FILES.decisions), 'utf8')));
    return `${reuseSession && !resuming && !planningHandoff ? '本次为目录变更后的局部生成任务，在原会话中执行。重新读取已更新的输入文件，仅对当前 targets 执行生成和审计修复；本轮完成状态根据当前目标重新确认，不沿用上一轮的完成结论。保留其他小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。\n' : ''}${buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan, runSummary, planningHandoff)}`;
  }
  // 验收当前阶段：共用一次产物读取，阶段检查只汇总问题，不处理修复次数。
  function validateContentStageSubmission(workspaceDir) {
    const inspected = inspectContentArtifacts(workspaceDir, { imageProtection: protection });
    const issues = [...inspected.issues];
    if (stage === 'auditing') {
      issues.push(...collectConsistencySubmissionIssues(workspaceDir, consistencyState));
    } else if (stage === 'table-cleaning' && (tableCleanupState.submission || tableCleanupState.status === 'completed')) {
      issues.push(...collectTableSubmissionIssues(inspected.inspections, tableCleanupState.remaining_section_ids));
    }
    if (stage !== 'table-cleaning' && tableCleanupState?.status === 'completed') {
      issues.push(...collectTableSubmissionIssues(inspected.inspections, tableCleanupState.remaining_section_ids));
    }
    return {
      value: inspected.result, issues,
      minimumGoal: '结果清单是有效 JSON，覆盖本轮全部目标小节；正文完整且可转换为 Word，必要图片引用和受保护图片块有效。保留已有正文、原图和任务范围。',
    };
  }

  // 初检及复查均由程序完成，只有明确的补写任务才继续请求主模型。
  function finishLayout(context, result) {
    if (!checkLayout) return { complete: true };
    return (async () => {
      await checkLayout(result, layout, context);
      context.signal?.throwIfAborted();
      if (layoutState.status === 'supplementing') {
        stage = 'layout-checking';
        if (toolContext) initializeContent();
        return next(stage, buildLayoutPrompt(layoutState));
      }
      return { complete: true };
    })();
  }
  // 审计结束后按既有配置去表格，随后进入本地格式检测。
  function finishConsistency(context, result) {
    const decisions = JSON.parse(fs.readFileSync(path.join(context.workspace_dir, INPUT_FILES.decisions), 'utf8'));
    if (decisions.table_requirement !== 'none') return finishLayout(context, result);
    tableCleanup.save({ status: 'running', section_ids: [], completed_section_ids: [], remaining_section_ids: [], remaining: [], failures: {}, submission: null });
    imageProtection.enter(TABLE_CLEANUP_TOOLS);
    return next('table-cleaning', buildTableCleanupPrompt(tableCleanupState));
  }

  onActivity?.(resuming ? { message: '正在恢复任务与输入资料' } : { progress: { step: 'preparing', label: planning ? '正在准备基础编排资料' : '正在准备正文输入资料' } });
  const files = planning ? planning.files : resuming ? [] : await prepareFiles(localContext);
  if (!planning && !resuming) prepareRunSummary(files);
  // 格式检测被暂停时先继续程序工作，不为跳过已完成补写再请求一次模型。
  if (stage === 'layout-checking' && layoutState.status !== 'supplementing') {
    const restoredResult = readContentGenerationResult(localContext.workspace_dir);
    const continuation = await finishLayout(localContext, restoredResult);
    if (continuation.complete) {
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'success', phase: 'completed', agent_connection: 'idle', error: null });
      return restoredResult;
    }
  }
  const runId = crypto.randomUUID();
  // 新一轮清空上一轮任务文件和程序清单；暂停继续与失败重试保留。
  if (reuseSession && !resuming) clearTaskArtifacts(localContext.workspace_dir);
  // 继续任务先清掉上次暂停或失败的错误，前置程序步骤失败时再如实记录。
  // 新一轮同时清除上一轮的阶段要求记录和待补压缩，避免误判为续跑。
  if (reuseSession) agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
    run_id: runId, status: 'running', phase: stage, agent_connection: 'running', error: null,
    ...(!resuming ? { word_adjustment_started: false, word_adjust: null, consistency: null, table_cleanup: null, layout_check: null } : {}),
    ...(!resuming && !continuingPlanning ? { prompted_stage: null, compaction_pending: null } : {}),
  });
  // 审计恢复先补齐小节核对，核对失败的小节随台账交给主 Agent。
  if (stage === 'auditing' && consistencyState.status !== 'completed') await extractLedger(localContext);
  // 当前阶段要求已在原会话发出时只发送“继续之前的任务”；已完成的审计或去表格仍用程序的收尾提示。
  const stageFinished = (stage === 'auditing' && consistencyState?.status === 'completed')
    || (stage === 'table-cleaning' && tableCleanupState?.status === 'completed');
  const continuingStage = (resuming || continuingPlanning) && !stageFinished && wasStagePrompted(persistentState, stage);
  const result = await agentService.runTask({
    task_id: runId, title: '投标文件正文生成', primary_session: true, summary_enabled: false, fixed_tool_list: true,
    prompt: continuingStage ? CONTINUE_PROMPT : planning ? planning.prompt : layoutState ? buildLayoutPrompt(layoutState) : tableCleanupState ? buildTableCleanupPrompt(tableCleanupState) : consistencyState ? consistencyPrompt(localContext.workspace_dir) : wordAdjustState ? buildWordAdjustPrompt(wordAdjustState) : generationPrompt(),
    output_file: RESULT_FILE, files, signal,
    persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: reuseSession ? 'resume' : 'create' },
    initial_stage: stage, active_tools: planning ? planningTools : layoutState ? LAYOUT_TOOLS : undefined,
    prepare_output_files: planning ? [planning.outputFile] : [],
    max_retries: 1, timeout_ms: 30 * 60 * 1000,
    // 提交校验不通过时完整退回问题说明；执行失败（模型或服务中断）直接续接原任务。
    // 基础编排的执行失败沿用原有不自动重试策略，正文仍保留一次续接机会。
    buildRetryPrompt: (request, meta) => {
      if (request.kind === 'execution') return stage === 'content-planning' ? null : CONTINUE_PROMPT;
      const issues = request.mode === 'minimum' ? request.report.issues.filter(item => item.severity === 'blocking') : request.report.issues;
      return '本次结果文件：' + (stage === 'content-planning' ? planning.outputFile : RESULT_FILE) + '。'
        + contentSubmissionInstructions(meta.workspace_dir, issues, protection.active)
        + ' 保留已完成内容，不重新执行已结束阶段；本轮处理后重新提交，由程序判断是否继续。';
    },
    json_validation_schemas: { [RESULT_FILE]: RESULT_SCHEMA, ...taskFileSchemas(), ...(planning ? { [planning.outputFile]: planning.schema } : {}) },
    // 阶段门禁只限制业务工具；文件修改不在写入时拦截，由提交校验检查结果并还原程序文件。
    before_tool_call: context => {
      if (stage === 'content-planning') {
        if (!planningTools.includes(context.toolCall.name)) throw new Error('基础编排尚未完成，请先提交编排结果');
      } else {
        // 字数校正、去表格和格式补写阶段只调用本阶段工具，工作由程序完成。
        const stageTool = ({ 'word-adjusting': WORD_ADJUST_TOOL, 'table-cleaning': TABLE_CLEANUP_TOOL, 'layout-checking': LAYOUT_TOOL })[stage];
        if (stageTool && ![stageTool, 'report-failure'].includes(context.toolCall.name)) throw new Error(`本阶段只调用 ${stageTool}，并在该调用上设置 task_complete=true；不要读取或修改正文。`);
        if (!tableCleanupState && consistencyState && consistencyState.status !== 'running' && context.toolCall.name === 'repair-sections') throw new Error('一致性审计结论已经提交，请标记任务完成并等待程序进入下一阶段');
        imageProtection.beforeToolCall(context);
      }
      const { name } = context.toolCall;
      const args = context.args || {};
      if (['read', 'edit', 'write', 'find', 'ls'].includes(name)) onActivity?.({ operation: name,
        message: `${({ read: '正在读取', edit: '正在修改', write: '正在保存', find: '正在查找', ls: '正在查看目录' })[name]}：${args.path || args.file_path || args.pattern || name}` });
    },
    create_tools: context => {
      toolContext = context;
      // 新一轮开始时登记工作区已有的全部小节，进入生成时再解除本轮目标；继续任务沿用已保存的登记。
      if (!resuming) context.baseline?.setGroup(BASELINE_GROUPS.sections, listSectionFiles(context.workspaceDir));
      // 审计恢复前程序已补齐台账，刷新登记。
      if (stage === 'auditing') protectLedger(context.baseline, context.workspaceDir);
      generationTools = createContentGenerationTools({ aiService, agentService, generationOptions, hasKnowledgeBase, signal, onProgress, onActivity, wordAdjust,
        imageProtection: protection, consistency, tableCleanup, submissionOptions, failTask }, context);
      const layoutTools = createContentGenerationLayoutTools({ aiService, signal, layout, onActivity, failTask }, context);
      if (stage !== 'content-planning') initializeContent();
      return [...generationTools, ...layoutTools];
    },
    validateOutput: (_result, context) => {
      if (stage === 'content-planning') {
        const file = path.join(context.workspace_dir, planning.outputFile);
        if (!fs.existsSync(file)) return { value: null, issues: [{ severity: 'blocking', file: planning.outputFile, message: planning.outputFile + ' 尚未生成，请按本阶段要求保存结果。' }] };
        return planning.validate(fs.readFileSync(file, 'utf8'));
      }
      onActivity?.({ progress: { step: 'result-check', label: '正在核对正文结果与当前阶段要求' } });
      const report = validateContentStageSubmission(context.workspace_dir);
      onActivity?.({ progress: { step: 'result-check', label: report.issues.length ? '结果核对发现 ' + report.issues.length + ' 处问题' : '正文结果核对完成', done: report.issues.length === 0 } });
      return report;
    },
    continueTask: (_result, context) => {
      if (stage === 'content-planning') return (async () => {
        await planning.complete(context.validation_result, context);
        const nextFiles = await prepareFiles(context);
        await context.writeFiles(nextFiles);
        prepareRunSummary(nextFiles);
        stage = 'generating';
        initializeContent();
        return next(stage, generationPrompt());
      })();
      const accepted = context.accepted_issues;
      const checked = context.validation_result;
      // 单工具阶段未调用工具就结束时重发阶段提示词；工具已提交的结果即本阶段结论，遗留项由工具记录。
      if (stage === 'layout-checking') {
        if (!layoutState.submission) return next(stage, buildLayoutPrompt(layoutState));
        layout.save({ ...layoutState, submission: null, status: 'rechecking' });
        return finishLayout(context, checked);
      }
      if (tableCleanupState) {
        if (tableCleanupState.status !== 'completed') {
          if (!tableCleanupState.submission) return next('table-cleaning', buildTableCleanupPrompt(tableCleanupState));
          tableCleanup.save({ ...tableCleanupState, submission: null, status: 'completed' });
        }
        return finishLayout(context, checked);
      }
      if (consistencyState) {
        if (consistencyState.status !== 'completed') {
          if (!consistencyState.submission) return next('auditing', CONTINUE_PROMPT);
          const submitted = consistencyState.submission;
          consistency.save({ ...consistencyState, ...submitted, submission: null, status: 'completed',
            remaining_issues: [...submitted.remaining_issues, ...accepted.map(item => item.message)] });
        }
        return finishConsistency(context, checked);
      }
      // 字数校正结束后进入一致性审计；进入审计前压缩上下文，核对小节事实与压缩并行。
      const startAudit = () => {
        consistency.save(createAuditState());
        imageProtection.enter(CONSISTENCY_TOOLS);
        return { ...next('auditing', consistencyPrompt(context.workspace_dir), compactionInstructions('一致性审计')), await_before_prompt: extractLedger(context) };
      };
      if (stage === 'word-adjusting') {
        if (wordAdjustState.status !== 'completed') return next(stage, buildWordAdjustPrompt(wordAdjustState));
        return startAudit();
      }
      const decisions = JSON.parse(fs.readFileSync(path.join(context.workspace_dir, INPUT_FILES.decisions), 'utf8'));
      const targetWords = decisions.targets.reduce((sum, section) => sum + (section.content_plan?.target_words || 0), 0);
      const totalWords = checked.sections.reduce((sum, section) => sum + section.words, 0);
      // 开启字数修复且总字数不在要求范围内时，进入字数校正阶段由工具统一校正；主 Agent 只统计字数。
      const plan = wordAdjustmentEnabled ? planWordAdjustment(context.workspace_dir) : null;
      const adjusting = Boolean(plan?.jobs.length);
      onActivity?.({ message: '首次正文生成：本轮目标 ' + (targetWords || '未设置') + ' 字，实际 ' + totalWords + ' 字；'
        + (adjusting ? `进入字数校正，按字数要求改写 ${plan.jobs.length} 个小节。` : (plan ? '没有可调整的小节，保留字数偏差，' : wordAdjustmentEnabled ? '' : '未开启字数修复，') + '进入一致性审计。') });
      if (!adjusting) return startAudit();
      // 先记录图片保护，字数校正和审计都以此比对图片块；字数校正阶段不压缩上下文。
      imageProtection.enter(WORD_ADJUST_TOOLS);
      wordAdjust.save(createWordAdjustState(plan));
      return next('word-adjusting', buildWordAdjustPrompt(wordAdjustState));
    },
    onCheckpoint: checkpoint => onCheckpoint({ ...checkpoint, task_key: CONTENT_GENERATION_AGENT_TASK_KEY, run_id: runId }),
    onActivity,
  });
  signal.throwIfAborted();
  return result.validation_result;
}

module.exports = { CONTENT_GENERATION_AGENT_TASK_KEY, CONTINUE_PROMPT, wasStagePrompted, BASELINE_GROUPS, listSectionFiles, buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, readContentGenerationResult, inspectSectionArtifact, inspectContentArtifacts, checkSectionHtml };
