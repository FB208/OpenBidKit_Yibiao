const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir, getWorkspaceDatabasePath } = require('../utils/paths.cjs');
const { ensureDiagnosisSource } = require('./diagnosisSourceService.cjs');
const { numberOutline } = require('./technicalPlanOutline.cjs');

const BID_DOCUMENT_ADJUSTMENT_KEY = 'technical-plan-document-adjustment';
const CONTENT_TASK_KEY = 'technical-plan-content-generation';

// 当前树顺序决定编号，正文文件始终按稳定节点 ID 寻址。
function adjustmentSections(items = [], prefix = '') {
  return items.flatMap((item, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    return item.children?.length
      ? adjustmentSections(item.children, number)
      : [{ ...item, number, file: `正文/${encodeURIComponent(item.id)}.html` }];
  });
}

// 每次发送要求重新解析正式路径；只提供位置和结构，不复制业务文件。
async function buildAdjustmentContext({ app, workspaceStore, agentService }) {
  const plan = workspaceStore.loadTechnicalPlan();
  const projectDir = workspaceStore.getContentWordOutputDir();
  const workspaceRoot = getWorkspaceDir(app);
  const sourceDir = await ensureDiagnosisSource(app);
  const bodyDir = agentService.loadPersistentTask(CONTENT_TASK_KEY)?.paths.workspaceDir || '';
  const available = file => fs.existsSync(file) ? file : '';
  const paths = {
    数据库: getWorkspaceDatabasePath(app),
    项目目录: projectDir,
    正文和图片根目录: bodyDir,
    招标文件: available(path.join(projectDir, 'tender.md')),
    商务有效底稿: available(path.join(workspaceRoot, workspaceStore.getBidTemplateBaseRelativePath())),
    商务提取底稿: available(path.join(workspaceRoot, workspaceStore.getBidTemplateBlankRelativePath())),
    商务字段和章节定位: available(workspaceStore.getBidTemplateFieldsPath()),
    商务预览文档: available(workspaceStore.getBidTemplatePath()),
    规则和页码表: available(path.join(projectDir, 'rule-page-tables.json')),
    原方案: plan.originalPlanFile?.markdownPath ? path.join(workspaceRoot, plan.originalPlanFile.markdownPath) : '',
    受限HTML生成规范: bodyDir ? available(path.join(bodyDir, '受限HTML生成规范.md')) : '',
    全局事实设定: bodyDir ? available(path.join(bodyDir, '全局事实设定.md')) : '',
    配图类型对照表: bodyDir ? available(path.join(bodyDir, '配图类型对照表.md')) : '',
  };
  return { plan, projectDir, workspaceRoot, sourceDir, bodyDir, paths,
    sections: adjustmentSections(plan.outlineData?.outline) };
}

// 工作区外访问沿用 Runtime 的任务例外；数据库仅修改本项目业务记录。
function adjustmentWorkspaceInstructions(context) {
  return `本任务可读写以下正式项目位置：\n${[context.projectDir, context.bodyDir, context.paths.数据库].filter(Boolean).map(file => `- ${file}`).join('\n')}
数据库只修改 technical_plan_* 业务数据，不修改数据库结构、任务记录或其他功能数据。关联写入使用事务，连接开启 foreign_keys 并沿用源码中的连接设置。
可以只读查阅 ${context.sourceDir} 和 ${context.workspaceRoot} 下与本次任务有关的参考资料；应用安装目录中的运行依赖只读。源码不参与运行，不修改源码和运行程序。
临时脚本、中间文件放在当前工作区。以上为工作区外路径例外，其余通用约定不变。`;
}

const OUTLINE_FILE = '项目目录.json';
const MATERIALS_FILE = '材料与存储.md';

// 精简目录树：只留身份、编号、标题、描述和处理方式，AI 叶子带正文文件；非 AI 节点内容以数据库为准，不复制。
function compactOutline(items = []) {
  return items.map(item => {
    const leaf = !item.children?.length;
    return {
      id: item.id, number: item.number, title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(leaf ? { content_mode: item.content_mode } : {}),
      ...(item.rule_basis ? { rule_basis: item.rule_basis } : {}),
      ...(leaf && item.content_mode === 'ai-generate' ? { file: `正文/${encodeURIComponent(item.id)}.html` } : {}),
      ...(leaf ? {} : { children: compactOutline(item.children) }),
    };
  });
}

// 目录和材料说明作为输入文件按最新数据重写（Runtime 登记保护），不随每条要求进入持久会话的上下文。
function buildAdjustmentFiles(context) {
  const outline = { project_name: context.plan.outlineData?.project_name, outline: compactOutline(numberOutline(context.plan.outlineData?.outline)) };
  const materials = `# 材料与存储

## 正式材料位置
${Object.entries(context.paths).filter(([, value]) => value).map(([label, value]) => `- ${label}：${value}`).join('\n')}

## 存储关系
- AI 正文在正文根目录的 正文/<节点ID>.html，图片引用相对于该根目录；对应小节 Word 是派生产物。修改或编写 AI 正文时遵守受限HTML生成规范和全局事实设定，新增图片按配图类型对照表选择本任务可用的生成方式。
- 商务文档由有效底稿、bid-template-fields.json 中的字段值和章节定位、rule-page-tables.json 重新回填。仅修改 bid-template.docx 不会进入后续导出。有 base 底稿时它优先于 blank 底稿；按实际修改维护相关底稿、字段和章节定位。
- 目录及非 AI 节点内容以数据库 technical_plan_outline_nodes 为准。节点 ID 保持稳定，parent_node_id 与 sort_order 表示树关系，编号由程序计算。新增节点使用 crypto.randomUUID() 分配 ID。
- 页码引用保存为 {{YBPAGE:节点ID}} 或 {{YBPAGE:节点ID|text}}，实际页码由导出计算。
- 目录结构变化（增删节点，修改标题、描述、处理方式或层级）后，程序会在本次调整结束后自动重新编制规则和页码，无需为适配目录手改 rule-page-tables.json。
- saveBidTemplateFieldValues 的参数是整体填写值，未列出的字段会清除旧值，不是局部 patch。
- 脚本可使用 node；通过 require('node:module').createRequire(process.env.YIBIAO_APP_PACKAGE) 加载应用自带的 adm-zip、cheerio、better-sqlite3。文本统一 UTF-8。图片工具的任务文件位于当前工作区，图片及源码相对路径属于上述正文根目录。

## 修改原则
- 先读取要修改的当前内容，以文件和工具返回的最新数据为准。
- 修改保存到软件实际使用的数据中。涉及文件、节点、字段或图片的增删调整时，同步维护相关引用和记录，保持现有存储格式，使后续读取、预览和导出能够使用修改结果。
- 需要了解文件格式、数据关联或处理规则时，只读查阅项目源码：${context.sourceDir}，先看相关开发说明，再按需检索实现。
`;
  return [
    { path: OUTLINE_FILE, content: JSON.stringify(outline, null, 2) },
    { path: MATERIALS_FILE, content: materials },
  ];
}

// 业务提示只写本次要求、输入文件和结束方式，长度不随目录增长。
function buildAdjustmentPrompt(context, requirement) {
  return `请完成下面的投标文件修改任务。

本次要求：
${requirement}

输入文件（在当前工作区，每次发送要求时由程序按最新数据重写，只读）：
- ${OUTLINE_FILE}：当前目录树（节点 ID、编号、标题、处理方式、描述、AI 正文文件）。
- ${MATERIALS_FILE}：正式材料位置、各类数据的存储关系和修改原则；修改涉及的数据类型时先查阅对应部分。

只做完成本次要求所需的修改，保留与本次要求无关的内容。需要了解文件格式或处理规则时，可以只读查阅源码：${context.sourceDir}。
完成后结束本轮，并用一两句话说明实际修改和未完成事项；程序随后刷新正式内容和预览。`;
}

const DEFAULT_SECTION_REQUIREMENT = '尚无正文的小节按目录、全局事实设定和受限HTML生成规范编写正文；有上次记录问题的小节修正这些问题；其余小节保留实质信息、事实参数、承诺及现有图片，整理段落顺序、合并重复表述，并修正含糊或不连贯的表达。';

// 页面指定的小节由程序写明位置和现状；用户没写要求时按各节现状处理。
function buildSectionRequirement(context, sectionIds, requirement) {
  const ids = new Set(sectionIds);
  const states = context.plan.contentGenerationSections || {};
  const sectionWords = context.plan.outlineWordControlSnapshot?.sectionWords;
  const items = context.sections.filter(section => ids.has(section.id)).map(section => {
    const written = Boolean(context.bodyDir) && fs.existsSync(path.join(context.bodyDir, section.file));
    const error = states[section.id]?.status === 'error' ? states[section.id].error : '';
    return `- ${section.number} ${section.title}（稳定 ID：${section.id}，文件：${section.file}，${written ? '已有正文' : '尚无正文'}${error ? `，上次记录的问题：${error}` : ''}）`;
  });
  return `${String(requirement || '').trim() || DEFAULT_SECTION_REQUIREMENT}

涉及小节：
${items.join('\n')}
只修改上述小节，未要求调整的内容和图片保持不变。${sectionWords ? `新写的小节每节约 ${sectionWords} 字。` : ''}`;
}

module.exports = { BID_DOCUMENT_ADJUSTMENT_KEY, CONTENT_TASK_KEY, adjustmentSections,
  buildAdjustmentContext, buildAdjustmentFiles, adjustmentWorkspaceInstructions, buildAdjustmentPrompt, buildSectionRequirement };
