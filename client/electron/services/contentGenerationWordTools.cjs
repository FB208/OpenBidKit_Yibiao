const fs = require('node:fs');
const path = require('node:path');
const { countReadableWords } = require('../utils/wordCount.cjs');

const { createContentImageProtection, editContentSections } = require('./contentGenerationEditTools.cjs');

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
    description: '字数检查结果 difference 表示距离有效字数范围的差额，不是实际总字数。差额大于10000字时，为不同小节分配各自的增减字数和修改要求，各子任务用 Pi 原生 read/edit 修改 HTML；等待全部完成后复查总字数。差额为1～10000字时由主 Agent 直接 edit 调整；差额为0且目标完整时不调整。',
    parameters: Type.Object({ sections: Type.Array(Type.Object({
      section_id: Type.String(), instructions: Type.String(),
    }), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      if (activity.pending) throw new Error('请等待上一批生成或编辑任务全部结束');
      if (!enterAdjustment().complete) throw new Error('请先完成全部目标小节及配图，再进行扩缩写');
      return result({ results: await editContentSections({
        jobs: params.sections, targets, workspaceDir, agentService, signal, toolSignal, activity, validateHtml, onActivity,
        title: '正文扩缩写', instructions: '缩写时优先删除重复表述、冗余修饰和可合并的说明；扩写时补充与本节主题相关的实施细节。两种调整均须保留实质信息、事实参数和承诺，禁止通过删除必要信息或重复表达满足字数要求。',
      }) });
    },
  }];
}

module.exports = { countHtmlWords, checkWordCount, createContentGenerationWordTools };
