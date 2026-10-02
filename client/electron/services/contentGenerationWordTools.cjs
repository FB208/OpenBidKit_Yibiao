const fs = require('node:fs');
const path = require('node:path');
const { countReadableWords } = require('../utils/wordCount.cjs');

const { createContentImageProtection, editContentSections, batchResponse } = require('./contentGenerationEditTools.cjs');
const { TASK_FILE_WRITING, taskFilePath, readTaskFile, writeListFile } = require('./contentGenerationTaskFiles.cjs');

// 统计实际 HTML 中的可读正文，排除图片提示词。
function countHtmlWords(html) {
  return countReadableWords(String(html).replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ''));
}

// 每轮按真实小节结果统计字数；提交检查可传入本次已读取的 sections，避免再次扫描正文。
function checkWordCount(workspaceDir, { sections: inspectedSections } = {}) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const inspected = inspectedSections === undefined ? null : new Map(inspectedSections.map(section => [section.section_id, section]));
  const sections = [];
  const missing = [];
  for (const section of decisions.targets) {
    try {
      const words = inspected ? inspected.get(section.id)?.words || 0
        : countHtmlWords(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
      if (words <= 0) missing.push(section.id);
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

// 各节字数写入程序清单，模型只接收总数、差额和缺失数量。
function reportWordCount(workspaceDir, words) {
  const { sections, missing_section_ids: missing, ...totals } = words;
  const file = writeListFile(workspaceDir, 'words', { total_words: words.total_words, sections, missing_section_ids: missing });
  return { ...totals, section_count: sections.length, missing_count: missing.length, detail_file: file };
}

// 关闭字数不达标修复时，字数检查只报告实际字数，不向模型给出调整方式；说明只描述行为，不暴露用户开关。
const WORD_COUNT_ONLY_NOTE = '本次只统计实际字数：保持正文不变，不以任何方式（包括脚本批量删改）调整字数，直接提交结果清单。';

// 主 Agent 负责分配调整要求；每个子任务直接用 Pi 原生工具修改自己的文件。
function createContentGenerationWordTools({ agentService, signal, activity, inspectSection, onActivity, imageProtection, wordAdjustmentEnabled = true }, { Type, workspaceDir, setActiveTools }) {
  // 基础编排时先注册工具，执行字数检查时再读取程序保存的生效决策。
  const readDecisions = () => JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  let protection = imageProtection;
  // 正文和配图全部就绪才切换权限，避免把未完成配图锁在扩缩写阶段。
  function enterAdjustment() {
    const decisions = readDecisions();
    const inspections = decisions.targets.map(section => inspectSection(section, { checkStructure: true }));
    const words = checkWordCount(workspaceDir, { sections: inspections.map(item => item.section).filter(Boolean) });
    if (words.complete) {
      // 图片保护记录只建立在结构和引用有效的正文上，复用同一次检查得到的字数。
      for (let index = 0; index < inspections.length; index += 1) {
        const issues = inspections[index].issues;
        if (issues.length) throw new Error(`${decisions.targets[index].file}：${issues.map(issue => issue.message).join('；')}`);
      }
      protection ||= createContentImageProtection({ workspaceDir, files: decisions.targets.map(section => section.file), setActiveTools });
      protection.enter();
    }
    return words;
  }
  const result = (details, text = details) => ({ content: [{ type: 'text', text: JSON.stringify(text) }], details });
  return [{
    name: 'check-word-count', label: '检查正文总字数', executionMode: 'sequential',
    description: `仅在全部正文和配图完成后调用。读取实际 HTML，返回总字数、上下限、差额和缺失小节数，各节字数及缺失小节 ID 写入 程序清单/正文字数统计.json，按需读取；内容就绪后启用图片写入保护，不修改正文。${wordAdjustmentEnabled ? '' : WORD_COUNT_ONLY_NOTE}`,
    parameters: Type.Object({}),
    async execute() {
      if (activity.pending) throw new Error('仍有生成或编辑任务运行，请等待全部结束再检查字数');
      onActivity?.({ progress: { step: 'word-check', label: '正在统计正文总字数' } });
      const words = enterAdjustment();
      onActivity?.({ progress: { step: 'word-check', label: `实际 ${words.total_words} 字${words.check_total_words ? `，${words.in_range ? '已达标' : `距有效范围相差 ${words.difference} 字`}` : '，本轮仅统计字数'}`, done: true } });
      const report = reportWordCount(workspaceDir, words);
      return result(words, wordAdjustmentEnabled ? report : { ...report, adjustment: 'none', note: WORD_COUNT_ONLY_NOTE });
    },
  }, {
    name: 'adjust-sections', label: '并发扩缩写正文', executionMode: 'sequential',
    description: `字数检查结果 difference 表示距离有效字数范围的差额，不是实际总字数。差额大于10000字时，为不同小节分配各自的增减字数和修改要求，写入 ${taskFilePath('adjust')}，格式为 {"sections":[{"section_id":"小节ID","instructions":"本节增减字数及修改要求"}]}，再调用本工具；文件内容即本次派发的任务，下一轮按最新差额改写后再提交。${TASK_FILE_WRITING}各子任务用 Pi 原生 read/edit 修改 HTML；等待全部完成后复查总字数。差额为1～10000字时由主 Agent 直接 edit 调整；差额为0且目标完整时不调整。返回 total、success 和 unresolved（失败小节及原因）。`,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      if (activity.pending) throw new Error('请等待上一批生成或编辑任务全部结束');
      if (!enterAdjustment().complete) throw new Error('请先完成全部目标小节及配图，再进行扩缩写');
      const targets = new Map(readDecisions().targets.map(section => [section.id, section]));
      const { sections: jobs } = readTaskFile(workspaceDir, 'adjust');
      const { results, restored } = await editContentSections({
        jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, inspectSection, onActivity,
        title: '正文扩缩写', instructions: '缩写时优先删除重复表述、冗余修饰和可合并的说明；扩写时补充与本节主题相关的实施细节。两种调整均须保留实质信息、事实参数和承诺，禁止通过删除必要信息或重复表达满足字数要求。',
      });
      return result({ results, restored }, batchResponse(results, restored));
    },
  }];
}

module.exports = { countHtmlWords, checkWordCount, reportWordCount, createContentGenerationWordTools };
