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
// 材料按数据类型写明权威数据和本轮结束后程序自动完成的处理，Agent 据此划定自己的职责，不再去求证派生产物。
function buildAdjustmentFiles(context) {
  const outline = { project_name: context.plan.outlineData?.project_name, outline: compactOutline(numberOutline(context.plan.outlineData?.outline)) };
  const materials = `# 材料与存储

## 正式材料位置
${Object.entries(context.paths).filter(([, value]) => value).map(([label, value]) => `- ${label}：${value}`).join('\n')}

## 各类数据
每类先写权威数据（修改落在这里），再写本轮结束后程序自动完成的处理（不需要你做，也不需要确认）。

- AI 正文
  - 权威数据：正文和图片根目录下的 正文/<节点ID>.html，以及它用 data-yb-asset-ref 相对该根目录引用的图片。编写或修改时遵守受限HTML生成规范和全局事实设定；新增图片按配图类型对照表选择本任务可用的生成方式。数据库中 AI 节点的 content 字段不使用。
  - 程序自动：检查改动正文的结构和图片引用，更新字数和小节状态，重新转换对应的小节 Word，刷新预览。
- 目录和非 AI 节点内容
  - 权威数据：数据库 technical_plan_outline_nodes。节点 ID 保持稳定，parent_node_id 与 sort_order 表示树关系，新增节点使用 crypto.randomUUID() 分配 ID。
  - 程序自动：按树顺序计算编号；增删节点或修改标题、描述、处理方式、层级后，重新编制规则和页码（不需要手改 rule-page-tables.json）；有商务文档时重新回填。
- 商务文档
  - 权威数据：有效底稿（有 base 底稿时它优先于 blank 底稿）、bid-template-fields.json 中的字段值和章节定位、rule-page-tables.json，按实际修改维护。saveBidTemplateFieldValues 的参数是整体填写值，未列出的字段会清除旧值，不是局部 patch。
  - 程序自动：按上述数据重新回填，生成商务预览文档；只改预览文档不会进入后续导出。
- 全局事实
  - 权威数据：正文和图片根目录下的 全局事实设定.md，调整阶段以它为准。要求改变了其中的事实时同步修改它，不修改数据库中的全局事实。
- 页码引用：写成 {{YBPAGE:节点ID}} 或 {{YBPAGE:节点ID|text}}，实际页码由导出时计算。

## 修改原则
- 先读取要修改的当前内容，以文件和工具返回的最新数据为准。
- 修改保存到上述权威数据中，保持现有存储格式；增删文件、节点、字段或图片时，同步维护权威数据之间的引用（例如正文中的图片引用、节点的父子关系与顺序）。
- 脚本可使用 node；通过 require('node:module').createRequire(process.env.YIBIAO_APP_PACKAGE) 加载应用自带的 adm-zip、cheerio、better-sqlite3。文本统一 UTF-8。脚本写在当前工作区，用绝对路径访问正式材料。图片工具的任务文件位于当前工作区，图片及源码相对路径属于上述正文根目录。
`;
  return [
    { path: OUTLINE_FILE, content: JSON.stringify(outline, null, 2) },
    { path: MATERIALS_FILE, content: materials },
  ];
}

// 同一持久会话先后承接人工修改和导出修复：每条任务写明类型并声明之前的任务已结束，完成方式按类型只写在这里。
const ADJUSTMENT_TASK_KINDS = {
  adjust: {
    title: '投标文件修改',
    heading: '修改要求',
    completion: `修改后结束本轮。程序会按改动完成${MATERIALS_FILE}中标为“程序自动”的处理并检查结果；发现问题会把具体报错发回本会话，届时再按报错修改。`,
  },
  export: {
    title: '导出修复',
    heading: '导出失败信息',
    completion: '以整本导出通过为目标，只修改造成这次失败的数据，改完结束本轮。程序会按原导出配置重新整本导出，成功即完成；失败会把新的报错和失败现场发回本会话。',
  },
};

// 业务提示只写任务类型、本次任务、完成方式和分工，长度不随目录增长。
function buildAdjustmentPrompt(context, { kind, requirement }) {
  const task = ADJUSTMENT_TASK_KINDS[kind];
  return `【新任务：${task.title}】
本会话之前的任务都已结束（无论成败），不再继续处理；只完成本条消息中的任务。

${task.heading}：
${requirement}

完成方式：${task.completion}

输入文件（在当前工作区，每次发送任务时由程序按最新数据重写，只读）：
- ${OUTLINE_FILE}：当前目录树（节点 ID、编号、标题、处理方式、描述、AI 正文文件）。
- ${MATERIALS_FILE}：各类数据的权威位置和修改方式，以及本轮结束后程序自动完成的处理。

分工：你只负责把本次任务落实到权威数据上，并维护这些数据之间的引用；材料中标为“程序自动”的处理不需要你做，也不需要确认。
做法：确定涉及的节点和数据，读取要改的当前内容，修改后结束本轮。只读取与本次任务直接相关的内容；材料已说明的事项不再到数据库结构或源码中求证；不编写校验、转换或导出脚本。只有材料没有覆盖、不了解就无法正确修改时，才只读查阅源码：${context.sourceDir}。
程序、源码或本机环境的问题不由你处理：确认报错无法通过修改本项目数据解决时，用 report-failure 说明原因，不结束进程、不编译程序、不修改运行环境。

结束时用一两句话说明实际修改和未完成事项。`;
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
