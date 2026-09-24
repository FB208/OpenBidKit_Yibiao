const fs = require('node:fs');
const path = require('node:path');

const WORD_ADJUSTMENT_TOOLS = ['read', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', 'check-word-count', 'adjust-sections', 'report-failure'];
const SECTION_EDIT_CHILD_TOOLS = ['read', 'edit', 'report-failure'];

// 只提取图片及其承载结构；表格里的普通说明文字不属于图片保护范围。
function imageStructure(html) {
  const $ = require('cheerio').load(String(html).replace(/\r\n/g, '\n'), null, false);
  // template 内有独立 Document 节点，沿真实父链遍历才能识别图片被移入不可见容器。
  function parents(node) {
    const result = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name) result.push(parent);
    }
    return result;
  }
  const images = $('figure, img').toArray().filter(node => !parents(node).some(parent => parent.name === 'figure'));
  const attributes = node => Object.fromEntries(Object.entries(node.attribs || {}).sort(([a], [b]) => a.localeCompare(b)));
  const tableTags = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
  // 保留表格布局和图片所在单元格，忽略普通文字及其段落/列表包装。
  function layout(node) {
    const imageIndex = images.indexOf(node);
    if (imageIndex >= 0) return [{ image: imageIndex }];
    const children = (node.children || []).flatMap(layout);
    return tableTags.has(node.name) ? [{ tag: node.name, attributes: attributes(node), children }] : children;
  }
  return JSON.stringify({
    images: images.map(node => ({
      html: $.html(node),
      parents: parents(node).map(parent => ({ tag: parent.name, attributes: attributes(parent) })),
    })),
    tables: $('table').toArray().filter(node => $(node).find('figure, img').length).map(layout),
  });
}

// 图片保护只控制正文编辑可写目标和图片结构，不参与 Pi 的文字匹配或替换。
function createContentImageProtection({ workspaceDir, files, active = false, allowManifest = false, setActiveTools = () => {}, toolNames = allowManifest ? WORD_ADJUSTMENT_TOOLS : SECTION_EDIT_CHILD_TOOLS, onEnter = () => {} }) {
  const fileKey = file => {
    const absolute = path.resolve(workspaceDir, file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const sectionFiles = new Set(files.map(fileKey));
  const manifest = allowManifest ? fileKey('正文生成结果.json') : '';
  if (active) setActiveTools(toolNames);

  // 与工具执行前和文件落盘前共用，防止路径别名或直接工具执行绕过目标限制。
  function assertWritable(toolName, filePath) {
    const key = fileKey(filePath);
    if (key === manifest) return;
    if (toolName !== 'edit' || !sectionFiles.has(key)) throw new Error('正文编辑只能用 edit 修改分配的正文小节；不能覆盖正文、图片或输入资料，write 仅可保存主任务结果清单。');
  }
  return {
    enter(names = toolNames) {
      if (!active) onEnter();
      active = true;
      toolNames = names;
      setActiveTools(toolNames);
    },
    beforeToolCall({ toolCall, args }) {
      if (!active) return;
      if (!toolNames.includes(toolCall.name)) throw new Error(`正文编辑期间不能调用 ${toolCall.name}，请使用 read/edit 调整文字并保留图片。`);
      if (toolCall.name === 'edit' || toolCall.name === 'write') assertWritable(toolCall.name, args.path);
    },
    beforeWrite({ filePath, content, originalContent, toolName }) {
      if (!active) return;
      assertWritable(toolName, filePath);
      if (fileKey(filePath) === manifest) return;
      if (typeof originalContent !== 'string' || imageStructure(originalContent) !== imageStructure(content)) {
        throw new Error('本次编辑修改了受保护图片或图片布局，文件未写入。请原样保留图片块、引用、数量和顺序，只调整普通文字。');
      }
    },
  };
}

// 扩缩写、一致性修复与去表格共用并发执行、原生 edit、图片保护和错误回传。
async function editContentSections({ jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, validateHtml, onActivity, title, instructions, preserveDataTables = true, onResult = () => {} }) {
  if (activity.pending) throw new Error('请等待上一批生成或编辑任务全部结束');
  const ids = jobs.map(section => section.section_id);
  if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能编辑本次目标小节，一批不能重复提交同一小节');
  const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
  const { global_facts_requirements: factsRequirements } = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  activity.pending += 1;
  try {
    const results = await Promise.all(jobs.map(async job => {
      const section = targets.get(job.section_id);
      try {
        combinedSignal.throwIfAborted();
        const childProtection = createContentImageProtection({ workspaceDir, files: [section.file], active: true });
        await agentService.runTask({
          title: `${title}-${section.number}-${section.title}`, primary_session: false,
          failure_handled_by_parent: true,
          workspace_dir: workspaceDir, active_tools: SECTION_EDIT_CHILD_TOOLS,
          before_tool_call: childProtection.beforeToolCall, before_file_write: childProtection.beforeWrite,
          output_file: section.file, summary_enabled: false, signal: combinedSignal,
          max_retries: 1, timeout_ms: 30 * 60 * 1000,
          prompt: `你负责编辑小节 ${section.number} ${section.title}，文件为 ${section.file}。先完整读取该文件及受限HTML生成规范.md，再按以下要求${title}：\n${job.instructions}\n本项目事实缺失处理要求（仅适用于本任务允许补充的内容，不扩大本次编辑范围）：${factsRequirements}\n只使用原生 edit 修改这一个小节文件；不要改其他小节、输入资料或结果清单。已有图片块（含图注与提示词）、图片引用和顺序、图片表格布局均受写入前保护，不得删除、替换或修改；可以调整图文表格中的普通说明文字。工具因图片保护拒绝编辑时，本次修改未写入文件。重新读取目标文件，将编辑范围限定为允许修改的普通文字，并原样保留受保护的图片块、引用、顺序和布局后重试。保留受限 HTML 结构、原有图片及引用、${preserveDataTables ? '原表格、' : '表格中的全部数据和含义、'}实质信息、事实参数和承诺。本次新增或改写的正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\\(...\\)、\\[...\\] 及 \\frac、\\text、\\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。${instructions} 事实冲突以全局事实设定.md为准，按需读取。无法完成时调用 report-failure。edit 返回文本未匹配等错误时，重新读取最新文件，依据实际原文修正编辑参数并重试。修改由当前子任务直接写入目标 HTML，不以返回补丁文本代替文件修改。完成本次要求后在最后一次成功 edit 上标记 task_complete=true${preserveDataTables ? '' : '；重试时若已无数据表格，核实信息完整后可以在 read 上标记完成'}，不承担全文达标或修改其他小节的任务。`,
          validateOutput: output => validateHtml(workspaceDir, output.output_content),
          onActivity,
        });
        combinedSignal.throwIfAborted();
        const result = { section_id: section.id, status: 'success' };
        onResult(result);
        return result;
      } catch (error) {
        return { section_id: section.id, status: 'error', error: error.message };
      }
    }));
    combinedSignal.throwIfAborted();
    return results;
  } finally {
    activity.pending -= 1;
  }
}

module.exports = { createContentImageProtection, editContentSections };
