const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { originalImageReferences } = require('./originalPlanRestoration.cjs');
const { createContentGenerationImageTools, validateContentImageReferences } = require('./contentGenerationImageTools.cjs');
const { countHtmlWords, checkWordCount, createContentGenerationWordTools } = require('./contentGenerationWordTools.cjs');
const { createContentImageProtection } = require('./contentGenerationEditTools.cjs');
const { CONSISTENCY_TOOLS, buildConsistencyPrompt, createContentGenerationConsistencyTools } = require('./contentGenerationConsistencyTools.cjs');

const CONTENT_GENERATION_AGENT_TASK_KEY = 'technical-plan-content-generation';
const RESULT_FILE = '正文生成结果.json';
const RESOURCE_DIR = path.join(__dirname, '../resources/content-generation');
const INPUT_FILES = {
  overview: '项目概述.md',
  decisions: '正文编排决策.json',
  rules: '受限HTML生成规范.md',
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
function wordInstructions(control) {
  const range = control.sectionWords > 0
    ? `建议约 ${control.sectionWords} 字，不设小节硬性上下限`
    : '不限制';
  return `全文最少字数：${control.minimumWords || '不限制'}；全文最多字数：${control.maximumWords || '不限制'}。\n每个 AI 小节：${range}。\n全文字数适用于整个文件，部分小节重生时不要把全文目标分摊到本次小节，也不是每节都写到全文目标。字数统计不含 HTML 标签及配图提示词。`;
}

// 保留旧正文写作要求，按用户的事实缺失策略生成约束。
function writingInstructions(mode, hasKnowledgeBase) {
  const missing = mode === 'placeholder'
    ? '不确定事实使用【待填写】，已有占位符原样沿用。'
    : mode === 'omit'
      ? '不确定事实使用笼统表达，不把笼统口径补成未经提供的具体事实。'
      : '';
  return `你是专业的投标文件正文编写专家。内容专业、准确、具体、可执行，围绕章节描述和写作重点展开；语言正式朴实，不写宣传口号、空话和重复凑字内容。\n参考资料改写为当前项目语境，不提及${hasKnowledgeBase ? '知识库、' : ''}历史文档或素材来源；事实设定优先，不得与其矛盾。${missing}\n只输出受限 HTML 正文，不输出 Markdown、代码围栏、外层章节标题或解释。内部层次用普通段落、列表或无编号加粗引导语；有序列表仅用于步骤、流程和时间顺序。`;
}

// 将用户配图设置译成任务要求，具体张数和类型由 Agent 结合正文决定。
function imageInstructions(options) {
  const mode = {
    none: '无图：不安排配图、不留图片占位、不调用配图工具。',
    light: '少图：参考编排中需要配图的小节，建议每节 1～3 张，可使用图片表格、三列图片等。',
    heavy: '多图：参考编排中需要配图的小节，建议每节 1～6 张，可使用图片表格、三列图片、四宫格等。',
  }[options.imageQuantity];
  return `${mode}\n允许使用的类型：AI 图片（aiImage）${options.useAiImages ? '允许' : '不允许'}；HTML 图片（htmlImage）${options.useHtmlImages ? '允许' : '不允许'}；Mermaid 图片（mermaid）${options.useMermaidImages ? '允许' : '不允许'}。无图要求优先于类型开关；有图模式下仅使用允许的类型，三类均不允许时不安排配图或占位。\nHTML 图片允许的类型：${options.htmlImageTypes}。\n参考本节 image_needed 和 image_suitability_score：image_needed=false 时不安排配图；true 时结合正文判断具体需要。张数是指导范围，不是必须凑足的配额；评分高的小节可以适当多配，但高分不等于必须多图。由你结合上下文决定实际张数、类型和排版，不为凑数量重复配图，也不为套用图组凑图。\n开启某类图片只表示允许使用，不要求每节或全文覆盖所有类型。内容适合时建议优先 AI 图片 > HTML 图片 > Mermaid 图片，不设比例或强制顺序。`;
}

// 将整理扩写规则和当前字数交给模型，不增加程序缩写或内容审计流程。
function restorationInstructions(control, existingTotalWords) {
  return `有 restored_content 的小节必须先完整阅读对应底稿，以其为基础对齐当前项目、目录及编排重点，整理为受限 HTML，不得忽略底稿另写一份。没有底稿的小节按正常流程生成，不搬用其他小节材料。\n本次启动时全文已有正文共 ${existingTotalWords} 字，全文上限 ${control.maximumWords || '不限制'}；每小节目标 ${control.sectionWords || '不限制'} 字，本节还原字数见 restored_content.words。若本节还原字数已超过小节目标，或全文已有正文已超过全文上限，则本节只整理，不扩写，不为压字数删除实质内容；未超过时按现有要求适当扩写。没有设置的目标不参与判断，不将全文目标分摊给本节。\n保留底稿中的实质信息、技术参数、措施和承诺；与全局事实设定冲突时，以全局事实设定为准，必要时读取并核对相关事实，无依据时不擅自改动。\n保留所有原表格的数据及含义，并保留本节原图片和引用顺序。表格编排和配图设置只指导新增内容：原表格不受 table.needed 限制，原图不受无图、image_needed、类型开关限制，也不计入新增配图建议张数。原图按 restored_content.images 中的对应关系直接使用 asset_ref，不重新生成，不留待生图占位。原图 figure 必须保留 data-yb-generation="aiImage" 以及唯一、非空的 template data-yb-role="prompt"，模板写“复用原方案图片，不重新生成”并可补充图片说明。此处 aiImage 仅满足现有受限 HTML 结构，不表示原图由 AI 生成；是否复用以原图对应关系为准，不得因该属性调用生图工具。保留 img、图注及其他必需属性。`;
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
    { path: INPUT_FILES.decisions, content: JSON.stringify({ outline: tree, targets: sections, has_knowledge_base: documentIds.length > 0, word_requirements: wordInstructions(wordControl), word_control: { minimumWords: wordControl.minimumWords, maximumWords: wordControl.maximumWords, checkTotalWords }, image_requirements: imageInstructions(generationOptions), ...(hasOriginalPlan ? { restoration_requirements: restorationInstructions(wordControl, existingTotalWords) } : {}), global_facts_mode: globalFactsMode, user_requirement: requirement || '' }, null, 2) },
    { path: INPUT_FILES.rules, content: fs.readFileSync(path.join(RESOURCE_DIR, INPUT_FILES.rules), 'utf8') },
    { path: INPUT_FILES.template, content: fs.readFileSync(path.join(RESOURCE_DIR, INPUT_FILES.template), 'utf8') },
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
function createContentGenerationTools({ aiService, agentService, signal, onActivity, imageProtection, consistency, onProgress = () => {} }, { Type, workspaceDir, setActiveTools }) {
  const activity = { pending: 0 };
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  const decisions = JSON.parse(read(INPUT_FILES.decisions));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const savedIds = new Set(decisions.targets.filter(section => fs.existsSync(path.join(workspaceDir, section.file))).map(section => section.id));
  const overview = read(INPUT_FILES.overview);
  const rules = read(INPUT_FILES.rules);
  const template = read(INPUT_FILES.template);
  const config = read(INPUT_FILES.config);
  const validateHtml = (root, html) => { checkSectionHtml(html); validateContentImageReferences(root, html); };
  return [{
    name: 'generate-sections', label: '批量生成正文小节',
    description: `一次提交多个目标小节并发生成受限 HTML，各节独立落盘。先检索相关${decisions.has_knowledge_base ? '知识库和' : ''}全局事实，把需要的参考原文摘录传入。失败小节可单独重试。`,
    executionMode: 'sequential',
    parameters: Type.Object({ sections: Type.Array(Type.Object({
      section_id: Type.String(), instructions: Type.String(), references: Type.String({ description: `从${decisions.has_knowledge_base ? '知识库、' : ''}全局事实检索得到的相关原文摘录，注明来源；无相关资料时填空字符串。` }),
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
                { role: 'system', content: `${writingInstructions(decisions.global_facts_mode, decisions.has_knowledge_base)}\n\n${rules}\n\n本次配图要求：\n${decisions.image_requirements}${section.restored_content ? `\n\n本节还原处理要求（原表格、原图保留规则优先于新增限制）：\n${decisions.restoration_requirements}` : ''}` },
                { role: 'user', content: `项目概述：\n${overview}\n\n本节编排决策：\n${JSON.stringify(section, null, 2)}\n\n字数要求：\n${decisions.word_requirements}\n\n用户额外要求：\n${decisions.user_requirement}\n\n受限 HTML 模板：\n${template}\n\n所选模板配置：\n${config}\n\n本节写作要求：\n${job.instructions}\n\n参考资料与事实摘录：\n${job.references || '未提供'}\n\n按本节 content_plan 执行：table.needed=false 时不新增数据表格；结合本次配图要求与 image_needed 判断是否新增图片；无图、无允许类型或 image_needed=false 时不留新增配图块，需要配图时先留占位并给出具体用途，图片资源由主 Agent 调用工具生成后填写；你仅负责本节正文，不虚构图片路径。${restoredContext}` },
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
  ...createContentGenerationWordTools({ agentService, signal, activity, onActivity, imageProtection, validateHtml }, { Type, workspaceDir, setActiveTools }),
  ...createContentGenerationImageTools({ aiService, signal }, { Type, workspaceDir })];
}

// 单个持久 Agent 负责阅读、检索、批量调度及最终文件清单。
function buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan) {
  return `你负责本次投标文件受限 HTML 正文生成，使用一个持久会话完成任务。
1. 项目概述.md、正文编排决策.json、受限HTML生成规范.md 三个文件必须完整阅读；参考正文模板.html和所选模板配置.json。模板只是结构示例，不照抄示例正文，不要求每节套用全部元素。
2. ${hasKnowledgeBase ? '知识库/包含用户选中的全部文档，索引提供编排知识条目与文件的对应关系；知识库和' : ''}全局事实设定.md是参考项，用到时再用 rg、read 搜索和读取相关内容，不要求全文通读。具体事实以全局事实设定为准，并遵守 global_facts_mode；不能仅因没有阅读就认定事实缺失。
3. 只生成正文编排决策.json中targets列出的AI生成叶子小节，其他目录作上下文；遵守写作重点、表格和配图标记、全文及每小节字数要求、用户额外要求。每节输出路径已给定，禁止修改输入文件和业务数据库。${hasOriginalPlan ? '本次使用已还原底稿：阅读 restoration_requirements，并在生成每节前完整阅读其 restored_content.file；工具会自动加入本节完整底稿、原图引用对应关系和全局事实。已超过生效字数要求的底稿只整理、不扩写；冲突以全局事实设定为准。保留原表格和原图，以下配图与表格限制仅用于新增内容；原图直接引用已复制文件，不重新生图。无底稿小节按正常流程生成。' : ''}
4. 检索需要的参考资料后，调用 generate-sections，一次提交多个相互独立的小节以真正并发生成；工具会自动加入本节编排、项目概述、HTML规范、模板、字数及配图要求，你负责提供各节写作要求及准确的参考摘录。文本并发遵循用户现有模型配置，不要使用bash或脚本直接调用外部模型。
5. 阅读并遵守正文编排决策.json 的 image_requirements（用户配图要求）。无图不安排图片或占位，不调用配图工具；有图时参考 image_needed、image_suitability_score 和实际正文，自主判断张数、允许的生成类型及排版。张数范围与类型优先级仅作建议，不凑数、不要求三类齐全。在当前会话中完成所需图片：AI 图调用 generate-image；HTML 图先用 write 编写独立配图 HTML 文件再调用 render-html-image；Mermaid 图先编写 .mmd 源文件再调用 render-mermaid-image。源码保存在图片/目录，配图 HTML 可使用 CSS，不受正文受限 HTML 标签限制。将工具返回的 asset_ref 原样写入对应 img 的 data-yb-asset-ref，不填写 src，不虚构文件路径，不把配图源码嵌入小节正文。图组中每张图片均须生成。渲染错误或 HTML layout_issues 交回当前会话修改源码并重新转图；失败不得默认为成功或改换生成方式。
6. ${resuming ? '本次继续原会话。先检查正文/已完成文件，保留有效正文、图片和源码，复用已存在且符合内容的图片引用；只补齐未完成、失败或明确需要修正的小节及图片。' : '每个小节保存为正文/下的独立HTML文件。'} 工具返回每节文件、字数和错误；对失败小节修正要求后重试，可用read/edit检查和修正已有HTML。不要删除已完成的小节。
小节 id 是固定身份，number 才是显示编号。generate-sections 的 section_id、结果清单及文件名均使用 id；不得根据显示编号改写文件路径。
7. 所有并发生成任务及配图全部完成后，再调用 check-word-count 统一检查实际字数，不能一边生成一边按部分结果调整。完整检查后进入图片保护阶段：只用 edit 调整正文文字，write 仅可保存正文生成结果.json；不能再调用命令、正文生成或配图工具。已插入的所有图片块（包括原图、新图、图注及提示词）、图片顺序和图片表格布局不可修改；图文表格中的普通说明文字可以调整。图片保护拒绝编辑时文件未写入，重新读取后仅修改文字。word_control.checkTotalWords=false 表示本次是单节或局部生成，只统计本次字数，不要求本次小节满足全文上下限；两个边界都未设置时不做字数调整。
检查完整且尚未达标时，按距离要求范围的差额选择：大于10000字，调用 adjust-sections 并发安排不同小节扩缩写；小于等于10000字，由你直接使用原生 read/edit 微调，不调用并发扩缩写。增减目标由你按内容安排，不要让每个子任务都承担全文差额。并发编辑期间你不得同时修改这些文件；等本轮所有任务结束后再调用 check-word-count。可以多轮调整，每轮按最新差额重新选择方式，直到进入要求范围，不设固定轮数。不删除原表格、原图、实质信息或承诺来凑字数；无法在保留要求下达标时明确调用 report-failure，不得伪报完成。不要再使用 generate-sections 重写整节进行字数调整。
8. 检查小节覆盖、字数及所有 img 的 data-yb-asset-ref 对应图片文件已存在，图片占位全部完成后将所有本次目标写入正文生成结果.json，格式为{"sections":[{"section_id":"小节ID","file":"正文/小节ID.html","words":实际正文统计字数}]}。该JSON已预置Schema并开启自动校验；用write/edit完成，无需重复独立JSON校验。HTML正文留在小节文件中，不塞进清单。最后完成标记放在清单写入上。
9. 提交本阶段结果后，程序会在同一会话中发出一致性审计任务；等待下一阶段要求，不自行转换 Word。
以下写作规则仅适用于小节 HTML 文件，不适用于结果清单：\n${writingInstructions('', hasKnowledgeBase)}`;
}

// 新一轮目标也复用正文 Session；仅暂停恢复时继承本轮字数调整与审计进度。
async function runContentGenerationAgent({ agentService, aiService, resume, hasKnowledgeBase, hasOriginalPlan, resolveOriginalImagePath, signal, buildFiles, onCheckpoint = () => {}, onActivity, onProgress, onConsistencyProgress = () => {}, onWorkspaceReady = () => {} }) {
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
  let imageProtection;
  const runId = crypto.randomUUID();
  if (reuseSession) agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
    run_id: runId, status: 'running', agent_connection: 'running', error: null,
    ...(!resuming ? { phase: 'generating', word_adjustment_started: false, consistency: null } : {}),
  });
  const result = await agentService.runTask({
    task_id: runId, title: '投标文件正文生成', primary_session: true, summary_enabled: false,
    prompt: consistencyState ? buildConsistencyPrompt(consistencyState, hasKnowledgeBase, hasOriginalPlan) : `${reuseSession && !resuming ? '目录已变更，本次是在原会话中开始新一轮局部生成。重新阅读程序更新的输入文件，以当前 targets 为唯一生成、调整和修复范围；上一轮完成结论不适用于本轮。保留其他小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。\n' : ''}${buildContentGenerationPrompt(resuming, hasKnowledgeBase, hasOriginalPlan)}${protectionActive ? '\n本次恢复时已处于图片保护阶段，正文和配图已经就绪，只继续文字调整及结果清单保存，不重新生成正文或图片。' : ''}`, output_file: RESULT_FILE,
    files, signal,
    persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: reuseSession ? 'resume' : 'create' },
    initial_stage: consistencyState ? 'auditing' : 'generating', max_retries: 1, timeout_ms: 30 * 60 * 1000,
    json_validation_schemas: { [RESULT_FILE]: RESULT_SCHEMA }, auto_validate_json: true,
    before_tool_call: context => {
      if (consistencyState && consistencyState.status !== 'running' && ['edit', 'write', 'repair-sections'].includes(context.toolCall.name)) {
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
        active: protectionActive || Boolean(consistencyState), ...(consistencyState ? { toolNames: CONSISTENCY_TOOLS } : {}), allowManifest: true, setActiveTools: context.setActiveTools,
        onEnter: () => agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { word_adjustment_started: true }),
      });
      onWorkspaceReady(context.workspaceDir);
      if (consistencyState) onConsistencyProgress(consistencyState);
      return createContentGenerationTools({ aiService, agentService, signal, onProgress, onActivity, imageProtection, consistency }, context);
    },
    validateOutput: (_result, context) => readContentGenerationResult(context.workspace_dir),
    // 字数不达标时继续同一主会话，不使用旧调整阶段或固定重试轮数。
    continueTask: (_result, context) => {
      // 审计分支必须先于字数检查，修复后绝不再次检查字数范围。
      if (consistencyState) {
        if (consistencyState.status === 'completed') return { complete: true };
        if (consistencyState.status === 'round-completed') {
          if (!consistencyState.remaining_issues.length || consistencyState.round >= 3) {
            consistency.save({ ...consistencyState, status: 'completed' });
            return { complete: true };
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
      return { stage: 'generating', prompt: `正文尚未满足总字数要求：${JSON.stringify(words)}。所有并发任务结束后复查；差额大于10000字调用 adjust-sections，小于等于10000字由你用原生 edit 微调。继续调整并更新结果清单；不得改变输入要求或删除实质内容，确实无法满足时调用 report-failure。` };
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

module.exports = { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, readContentGenerationResult, checkSectionHtml };
