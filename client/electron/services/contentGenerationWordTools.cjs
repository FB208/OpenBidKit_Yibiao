const fs = require('node:fs');
const path = require('node:path');
const { countReadableWords } = require('../utils/wordCount.cjs');

const WORD_ADJUSTMENT_TOOLS = ['read', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', 'check-word-count', 'adjust-sections', 'report-failure'];
const WORD_ADJUSTMENT_CHILD_TOOLS = ['read', 'edit', 'report-failure'];

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

// 图片保护只控制扩缩写可写目标和图片结构，不参与 Pi 的文字匹配或替换。
function createContentImageProtection({ workspaceDir, files, active = false, allowManifest = false, setActiveTools = () => {}, onEnter = () => {} }) {
  const fileKey = file => {
    const absolute = path.resolve(workspaceDir, file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const sectionFiles = new Set(files.map(fileKey));
  const manifest = allowManifest ? fileKey('正文生成结果.json') : '';
  const toolNames = allowManifest ? WORD_ADJUSTMENT_TOOLS : WORD_ADJUSTMENT_CHILD_TOOLS;
  if (active) setActiveTools(toolNames);

  // 与工具执行前和文件落盘前共用，防止路径别名或直接工具执行绕过目标限制。
  function assertWritable(toolName, filePath) {
    const key = fileKey(filePath);
    if (key === manifest) return;
    if (toolName !== 'edit' || !sectionFiles.has(key)) throw new Error('扩缩写只能用 edit 修改分配的正文小节；不能覆盖正文、图片或输入资料，write 仅可保存主任务结果清单。');
  }
  return {
    enter() {
      if (active) return;
      onEnter();
      active = true;
      setActiveTools(toolNames);
    },
    beforeToolCall({ toolCall, args }) {
      if (!active) return;
      if (!toolNames.includes(toolCall.name)) throw new Error(`扩缩写期间不能调用 ${toolCall.name}，请使用 read/edit 调整文字并保留图片。`);
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

// 统计实际 HTML 中的可读正文，排除图片提示词。
function countHtmlWords(html) {
  return countReadableWords(String(html).replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ''));
}

// 每轮所有任务结束后读取文件；单节重生只报告字数，不承担全文目标。
function checkWordCount(workspaceDir) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const sections = [];
  const missing = [];
  for (const section of decisions.targets) {
    try {
      const words = countHtmlWords(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
      if (!words) missing.push(section.id);
      else sections.push({ section_id: section.id, number: section.number, file: section.file, words });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(section.id);
    }
  }
  const total = sections.reduce((sum, section) => sum + section.words, 0);
  const { minimumWords, maximumWords, checkTotalWords } = decisions.word_control;
  const difference = !checkTotalWords ? 0 : minimumWords > 0 && total < minimumWords
    ? minimumWords - total : maximumWords > 0 && total > maximumWords ? total - maximumWords : 0;
  const direction = !difference ? 'none' : minimumWords > 0 && total < minimumWords ? 'expand' : 'shrink';
  return {
    complete: missing.length === 0, missing_section_ids: missing, sections,
    total_words: total, minimum_words: minimumWords, maximum_words: maximumWords,
    check_total_words: checkTotalWords, difference, direction,
    in_range: missing.length === 0 && difference === 0,
    adjustment: difference > 10000 ? 'parallel' : difference > 0 ? 'main' : 'none',
  };
}

// 主 Agent 负责分配调整要求；每个子任务直接用 Pi 原生工具修改自己的文件。
function createContentGenerationWordTools({ agentService, signal, activity, validateHtml, onActivity, imageProtection }, { Type, workspaceDir, setActiveTools }) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const protection = imageProtection || createContentImageProtection({ workspaceDir, files: decisions.targets.map(section => section.file), allowManifest: true, setActiveTools });
  // 正文和配图全部就绪才切换权限，避免把未完成配图锁在扩缩写阶段。
  function enterAdjustment() {
    const words = checkWordCount(workspaceDir);
    if (words.complete) {
      for (const section of decisions.targets) validateHtml(workspaceDir, fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
      protection.enter();
    }
    return words;
  }
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  return [{
    name: 'check-word-count', label: '检查正文总字数', executionMode: 'sequential',
    description: '仅在全部正文和配图完成后调用。读取实际 HTML，返回各节字数、总字数、上下限和差额；内容就绪后启用图片写入保护，不修改正文。',
    parameters: Type.Object({}),
    async execute() {
      if (activity.pending) throw new Error('仍有生成或编辑任务运行，请等待全部结束再检查字数');
      return result(enterAdjustment());
    },
  }, {
    name: 'adjust-sections', label: '并发扩缩写正文', executionMode: 'sequential',
    description: '全文差额大于10000字时使用。为不同小节分配扩缩写要求，各子任务用 Pi 原生 read/edit 直接修改 HTML，等待全部完成后再检查总字数。差额小于等于10000字时由主 Agent 直接 edit 微调。',
    parameters: Type.Object({ sections: Type.Array(Type.Object({
      section_id: Type.String(), instructions: Type.String(),
    }), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      if (activity.pending) throw new Error('请等待上一批生成或编辑任务全部结束');
      if (!enterAdjustment().complete) throw new Error('请先完成全部目标小节及配图，再进行扩缩写');
      const ids = params.sections.map(section => section.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能编辑本次目标小节，一批不能重复提交同一小节');
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      activity.pending += 1;
      try {
        const results = await Promise.all(params.sections.map(async job => {
          const section = targets.get(job.section_id);
          try {
            combinedSignal.throwIfAborted();
            const childProtection = createContentImageProtection({ workspaceDir, files: [section.file], active: true });
            await agentService.runTask({
              title: `正文扩缩写-${section.number}-${section.title}`, primary_session: false,
              failure_handled_by_parent: true,
              workspace_dir: workspaceDir, active_tools: WORD_ADJUSTMENT_CHILD_TOOLS,
              before_tool_call: childProtection.beforeToolCall, before_file_write: childProtection.beforeWrite,
              output_file: section.file, summary_enabled: false, signal: combinedSignal,
              max_retries: 1, timeout_ms: 30 * 60 * 1000,
              prompt: `你负责编辑小节 ${section.number} ${section.title}，文件为 ${section.file}。先完整读取该文件及受限HTML生成规范.md，再按以下要求扩缩写：\n${job.instructions}\n只使用原生 edit 修改这一个小节文件；不要改其他小节、输入资料或结果清单。已有图片块（含图注与提示词）、图片引用和顺序、图片表格布局均受写入前保护，不得删除、替换或修改；可以调整图文表格中的普通说明文字。图片保护拒绝编辑时文件没有写入，应重读后仅修改文字。保留受限 HTML 结构、原有图片及引用、原表格、实质信息、事实参数和承诺。精简重复冗余文字，扩写应具体且不重复凑字；事实冲突以全局事实设定.md为准，按需读取。不得为压字数删去必须保留的实质内容，无法完成时调用 report-failure。编辑未命中时读取最新原文再修正；不要输出补丁让主 Agent 执行。完成本次要求后在最后一次成功 edit 上标记 task_complete=true，不承担全文达标或修改其他小节的任务。`,
              validateOutput: output => validateHtml(workspaceDir, output.output_content),
              onActivity,
            });
            return { section_id: section.id, status: 'success' };
          } catch (error) {
            return { section_id: section.id, status: 'error', error: error.message };
          }
        }));
        combinedSignal.throwIfAborted();
        return result({ results });
      } finally {
        activity.pending -= 1;
      }
    },
  }];
}

module.exports = { countHtmlWords, checkWordCount, createContentImageProtection, createContentGenerationWordTools };
