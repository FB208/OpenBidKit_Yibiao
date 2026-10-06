const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { AI_UPSTREAM_UNAVAILABLE } = require('../utils/aiBatchGuard.cjs');
const { createContentImageProtection, imageStructure } = require('./contentGenerationEditTools.cjs');
const { warmSharedPrefix } = require('./contentGenerationPrefixWarmup.cjs');
const { writeListFile } = require('./contentGenerationTaskFiles.cjs');
const { runAiBatch, requestWithFollowUp, writeHtml } = require('./contentGenerationAiBatch.cjs');

// 落点从最近的边界向区间内收的比例，抵消改写结果整体偏少或偏多。
const WORD_ADJUST_MARGIN = 0.02;
// 单节调整量占本节可改文字的上限，避免为凑总数大幅删改或注水。
const WORD_ADJUST_SECTION_LIMIT = { shrink: 0.4, expand: 0.6 };
// 低于该字数的调整不值得整节改写。
const WORD_ADJUST_MIN_WORDS = 100;
const WORD_ADJUST_MAX_ROUNDS = 2;
// 单节结果与目标的允许偏差：调整量的比例与最小字数取大者，超出时追问一次。
const WORD_ADJUST_TOLERANCE = 0.25;
const WORD_ADJUST_MIN_TOLERANCE = 80;
const KEEP_PATTERN = /<!--\s*yibiao:keep-(\d+)\s*-->/g;
const WORD_ADJUST_TOOL = 'adjust-word-count';
// 字数校正阶段主 Agent 只调用校正工具。
const WORD_ADJUST_TOOLS = [WORD_ADJUST_TOOL, 'report-failure'];

// 统计实际 HTML 中的可读正文，排除图片提示词。
function countHtmlWords(html) {
  return countReadableWords(String(html).replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ''));
}

const readDecisions = workspaceDir => JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));

// 每轮按真实小节结果统计字数；提交检查可传入本次已读取的 sections，避免再次扫描正文。
function checkWordCount(workspaceDir, { sections: inspectedSections } = {}) {
  const decisions = readDecisions(workspaceDir);
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
  };
}

// 各节字数写入程序清单，模型只接收总数和缺失数量。
function reportWordCount(workspaceDir, words) {
  const { sections, missing_section_ids: missing, ...totals } = words;
  const file = writeListFile(workspaceDir, 'words', { total_words: words.total_words, sections, missing_section_ids: missing });
  return { ...totals, section_count: sections.length, missing_count: missing.length, detail_file: file };
}

// 图片块和表格不交给模型：含图片或表格的顶层元素整块换成占位注释，改写后原样换回。
function protectBlocks(html) {
  const $ = load(String(html).replace(/\r\n/g, '\n'), null, false);
  const blocks = [];
  $.root().children().each((_index, node) => {
    const element = $(node);
    if (!element.is('figure, img, table') && !element.find('figure, img, table').length) return;
    blocks.push($.html(node));
    element.replaceWith(`<!-- yibiao:keep-${blocks.length} -->`);
  });
  return { text: $.html(), blocks };
}

// 每个占位须按原顺序恰好出现一次，否则返回可交给模型修正的说明。
function restoreBlocks(text, blocks) {
  const found = [...text.matchAll(KEEP_PATTERN)].map(match => Number(match[1]));
  if (found.length !== blocks.length || found.some((value, index) => value !== index + 1)) {
    const names = values => values.map(value => `keep-${value}`).join('、') || '无';
    throw new Error(`占位注释须按原顺序各保留一次：应为 ${names(blocks.map((_block, index) => index + 1))}，实际为 ${names(found)}`);
  }
  return text.replace(KEEP_PATTERN, (_match, index) => blocks[Number(index) - 1]);
}

// 程序按偏差分配改写：优先把偏离本节目标最多的小节拉回目标，不够时从可改文字多的小节补足，尽量少改小节。
// 不需要调整时返回 null；返回的 jobs 可能为空，表示没有可调整的小节。
function planWordAdjustment(workspaceDir) {
  const words = checkWordCount(workspaceDir);
  if (!words.check_total_words || !words.complete || words.in_range) return null;
  const { direction, total_words: total, minimum_words: minimum, maximum_words: maximum } = words;
  const bound = direction === 'shrink' ? maximum : minimum;
  let margin = Math.round(bound * WORD_ADJUST_MARGIN);
  if (minimum > 0 && maximum > 0) margin = Math.min(margin, Math.floor((maximum - minimum) / 2));
  const goal = direction === 'shrink' ? bound - margin : bound + margin;
  const sign = direction === 'shrink' ? 1 : -1;
  const targetWords = new Map(readDecisions(workspaceDir).targets.map(section => [section.id, section.content_plan?.target_words || 0]));
  const sections = words.sections.map(section => {
    const adjustable = countHtmlWords(protectBlocks(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8')).text);
    const target = targetWords.get(section.section_id);
    return { ...section, amount: 0, limit: Math.floor(adjustable * WORD_ADJUST_SECTION_LIMIT[direction]),
      deviation: target > 0 ? (section.words - target) * sign : 0 };
  });
  let remaining = Math.abs(total - goal);
  // 余量很小时按最小调整量分配，略超出由落点余量吸收。
  const allocate = (section, available) => {
    const amount = Math.min(available, Math.max(remaining, WORD_ADJUST_MIN_WORDS));
    if (amount < WORD_ADJUST_MIN_WORDS) return;
    section.amount += amount;
    remaining -= amount;
  };
  for (const section of sections.filter(item => item.deviation > 0).sort((left, right) => right.deviation - left.deviation)) {
    if (remaining <= 0) break;
    allocate(section, Math.min(section.deviation, section.limit));
  }
  for (const section of [...sections].sort((left, right) => right.limit - left.limit)) {
    if (remaining <= 0) break;
    allocate(section, section.limit - section.amount);
  }
  return {
    direction, goal, total_words: total, minimum_words: minimum, maximum_words: maximum,
    need: Math.abs(total - goal), shortfall: Math.max(0, remaining),
    jobs: sections.filter(section => section.amount > 0)
      .map(section => ({ section_id: section.section_id, from_words: section.words, target_words: section.words - sign * section.amount })),
  };
}

// 字数校正的持久状态：results 只记录当前轮；rewritten_section_ids 与 failures 跨轮汇总，供结果和任务日志使用。
function createWordAdjustState(plan) {
  return { status: 'running', round: 1, direction: plan.direction, goal: plan.goal,
    minimum_words: plan.minimum_words, maximum_words: plan.maximum_words, initial_words: plan.total_words,
    round_start_words: plan.total_words, planned_count: plan.jobs.length, jobs: plan.jobs, results: {},
    rewritten_section_ids: [], failures: {}, history: [] };
}

const wordRange = state => `${state.minimum_words || '不限'}～${state.maximum_words || '不限'}`;

// 阶段提示词只交代调用工具；分配、改写和复查都由工具完成。
function buildWordAdjustPrompt(state) {
  if (state.status === 'completed') return `字数校正已经完成。调用 ${WORD_ADJUST_TOOL} 读取校正结果，并在该调用上设置 task_complete=true；不要读取或修改正文，也不要调用其他工具。`;
  return `现在执行字数校正。正文总字数 ${state.initial_words} 字，要求 ${wordRange(state)} 字；程序已按各节偏离目标字数的情况，为 ${state.jobs.length} 个小节分配调整量。调用 ${WORD_ADJUST_TOOL}，并在该调用上设置 task_complete=true。分配、改写、校验和复查都由工具完成，不要读取或修改正文，也不要调用其他工具；工具返回后本阶段结束，程序随后进入一致性审计。工具报错时按错误说明重新调用。`;
}

// 同一轮各小节方向相同，改写规则放在 system，便于并发请求复用前缀缓存。
function buildAdjustSystem(direction) {
  const rules = direction === 'shrink'
    ? '缩写要求：优先删除重复表述、冗余修饰、空泛过渡和可以合并的说明，相近段落可以合并；保留实质信息、事实参数、数量、时限、责任分工和承诺，禁止通过删除必要信息满足字数。'
    : '扩写要求：围绕本节标题和写作重点补充具体的实施措施、执行条件、责任分工、检查方式或交付成果，可在原段落中补充，也可新增段落；新增内容不得与全局事实冲突，全局事实未明确的信息按本项目事实缺失处理要求执行，不虚构具体数值、人员、证书或业绩；禁止重复已有内容凑字数。';
  return `你负责调整投标正文中一个小节的篇幅，本轮任务是${direction === 'shrink' ? '缩写' : '扩写'}：按本节目标字数改写，输出调整后的完整小节 HTML。
字数口径：每个汉字计 1 字，连续的英文字母或数字计 1 字；标点、空白、HTML 标签和注释不计入。结果尽量接近目标字数。
${rules}
保留原有实质信息、事实参数和承诺，不改变原有结论；事实冲突以全局事实设定为准。
格式要求：输出受限 HTML 片段，以 <!-- yibiao:block --> 开头，每个顶层块前单独一行 <!-- yibiao:block -->。顶层只使用 p、ol、ul；原有块沿用原 id，新增块使用本节相同的 id 前缀续编，不与已有 id 重复。除空元素外每个元素都写出结束标签。不使用 h1～h6、Markdown、代码围栏或解释文字。不使用 LaTeX，公式、参数和单位使用普通文字、Unicode 数学符号及 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、≥30 m<sup>3</sup>/(h·人)。
形如 <!-- yibiao:keep-1 --> 的注释代表本节已有的图片或表格，不可修改：每个占位注释必须原样保留一次并保持原有先后顺序，不删除、不复制、不改写，其前面同样保留 <!-- yibiao:block -->；可以在占位前后增删或改写文字段落。
只输出调整后的完整 HTML。`;
}

// 逐节直接调用模型改写并写回工作区；结果与目标偏差过大或输出不可用时在同一对话追问一次。
// state 提供 get/save，进度随每节完成保存；继续时只补未成功且非结果不可用的小节，服务端请求失败的小节会重试。
async function adjustContentWordCount({ aiService, workspaceDir, signal, onActivity, state, validateHtml }) {
  let current = state.get();
  const save = next => {
    current = next;
    state.save(current);
  };
  const itemId = sectionId => `r${current.round}:${sectionId}`;
  // 当前总字数 = 本轮开始字数 + 本轮已改写小节的字数变化，进度标签随每节完成实时更新。
  const currentWords = () => current.round_start_words + current.jobs.reduce((sum, job) => {
    const result = current.results[job.section_id];
    return result?.status === 'success' ? sum + result.words - job.from_words : sum;
  }, 0);
  const report = (items, extra = {}) => onActivity?.({ progress: { step: 'word-adjust',
    label: `字数校正第 ${current.round} 轮：当前 ${currentWords()} 字，目标约 ${current.goal} 字（要求 ${wordRange(current)} 字）`,
    unit: '节', total: current.planned_count, items, ...extra } });
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  while (current.status === 'running') {
    const decisions = readDecisions(workspaceDir);
    const targets = new Map(decisions.targets.map(section => [section.id, section]));
    const sign = current.direction === 'shrink' ? 1 : -1;
    const succeed = (job, words) => {
      const { [job.section_id]: _removed, ...failures } = current.failures;
      save({ ...current, results: { ...current.results, [job.section_id]: { status: 'success', words } },
        rewritten_section_ids: [...new Set([...current.rewritten_section_ids, job.section_id])], failures });
    };
    // 写回后、记录前中断的小节字数已变化，按已完成处理，避免重复改写。
    for (const job of current.jobs) {
      if (current.results[job.section_id]?.status === 'success') continue;
      const words = countHtmlWords(read(targets.get(job.section_id).file));
      if (words !== job.from_words) succeed(job, words);
    }
    const pending = current.jobs.filter(job => {
      const result = current.results[job.section_id];
      return result?.status !== 'success' && !(result?.status === 'error' && !result.retry);
    });
    report(current.jobs.map(job => ({ id: itemId(job.section_id), status: current.results[job.section_id]?.status === 'success' ? 'success' : 'pending' })));
    if (pending.length) {
      const system = buildAdjustSystem(current.direction);
      const sharedInput = `项目概述：\n${read('项目概述.md')}\n\n全局事实设定（完整内容）：\n${read('全局事实设定.md')}\n\n本项目事实缺失处理要求：\n${decisions.global_facts_requirements}\n\n用户额外要求：\n${decisions.user_requirement || '无'}`;
      if (pending.length > 1) await warmSharedPrefix({ aiService, system, sharedInput, signal, onActivity, logTitle: '字数校正-公共前缀预热', label: '字数校正公共材料' });
      await runAiBatch({
        items: pending, signal,
        async run(job, guard) {
          report([{ id: itemId(job.section_id), status: 'running' }]);
          const section = targets.get(job.section_id);
          const file = path.join(workspaceDir, section.file);
          const original = fs.readFileSync(file, 'utf8');
          const { text, blocks } = protectBlocks(original);
          // 模型只看到可改文字，目标按图片块和表格之外的字数换算。
          const fixed = countHtmlWords(original) - countHtmlWords(text);
          const target = job.target_words - fixed;
          const amount = Math.abs(job.target_words - job.from_words);
          const tolerance = Math.max(WORD_ADJUST_MIN_TOLERANCE, Math.round(amount * WORD_ADJUST_TOLERANCE));
          const structure = imageStructure(original);
          const best = await requestWithFollowUp({
            aiService, guard, logTitle: `字数校正-${section.number}-${section.title}`,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `${sharedInput}\n\n本节：${section.number} ${section.title}（${section.chapter_path || section.title}）\n本节写作重点：${section.content_plan?.writing_focus || '未提供'}\n本节文字当前 ${countHtmlWords(text)} 字（不含占位注释代表的图片和表格），目标约 ${target} 字，需要${current.direction === 'shrink' ? '删减' : '补充'}约 ${amount} 字。\n\n本节当前 HTML：\n${text}` },
            ],
            evaluate(reply) {
              const html = restoreBlocks(extractAiSource(reply, 'html').trim(), blocks);
              validateHtml(html);
              if (imageStructure(html) !== structure) throw new Error('图片或表格与原文不一致，请原样保留全部占位注释');
              const words = countHtmlWords(html);
              const distance = Math.abs(words - job.target_words);
              const reason = `改写结果 ${words} 字，目标 ${job.target_words} 字`;
              const feedback = `本次结果的文字为 ${words - fixed} 字，目标约 ${target} 字。请在这一结果基础上再${words > job.target_words ? '删减' : '补充'}约 ${distance} 字，其他要求不变，重新输出完整 HTML。`;
              if ((job.from_words - words) * sign <= 0) return { feedback, reason };
              if (distance <= tolerance) return { accept: true, value: { html, words } };
              return { value: { html, words }, distance, feedback, reason };
            },
          });
          guard.signal.throwIfAborted();
          writeHtml(file, best.html);
          succeed(job, best.words);
          report([{ id: itemId(job.section_id), status: 'success' }]);
        },
        onError(job, error, { cancelled }) {
          report([{ id: itemId(job.section_id), status: cancelled ? 'cancelled' : 'error' }]);
          if (cancelled) return;
          const section = targets.get(job.section_id);
          const reason = `${error?.message || error}${error?.isAiRequestError ? '' : '，已保留原文'}`;
          save({ ...current, results: { ...current.results, [job.section_id]: { status: 'error', error: reason, retry: error?.isAiRequestError === true } },
            failures: { ...current.failures, [job.section_id]: { number: section.number, title: section.title, reason } } });
        },
      });
    }
    // 本轮结束复查总字数：仍未达标、本轮向目标推进且未到轮数上限时按最新字数再分配一轮。
    const words = checkWordCount(workspaceDir);
    const results = Object.values(current.results);
    const history = [...current.history, { round: current.round, before_words: current.round_start_words, after_words: words.total_words,
      success: results.filter(item => item.status === 'success').length, failed: results.filter(item => item.status === 'error').length }];
    const progressed = (current.round_start_words - words.total_words) * sign > 0;
    const next = !words.in_range && progressed && current.round < WORD_ADJUST_MAX_ROUNDS ? planWordAdjustment(workspaceDir) : null;
    if (next?.jobs.length) {
      save({ ...current, round: current.round + 1, direction: next.direction, goal: next.goal, round_start_words: words.total_words,
        planned_count: current.planned_count + next.jobs.length, jobs: next.jobs, results: {}, history });
    } else {
      save({ ...current, status: 'completed', final_words: words.total_words, in_range: words.in_range, history });
    }
  }
  reportWordCount(workspaceDir, checkWordCount(workspaceDir));
  report([], { label: `字数校正完成：${current.initial_words} → ${current.final_words} 字（要求 ${wordRange(current)} 字），改写 ${current.rewritten_section_ids.length} 节${current.in_range ? '' : '，仍未达标'}`, done: true });
  return current;
}

// 工具结果：总字数变化、改写节数及失败小节原因。
function wordAdjustResult(state) {
  return { initial_words: state.initial_words, final_words: state.final_words, minimum_words: state.minimum_words, maximum_words: state.maximum_words,
    in_range: state.in_range, rewritten: state.rewritten_section_ids.length, failed: Object.values(state.failures) };
}

// 主 Agent 只统计字数，字数要求由程序在正文阶段提交后统一处理；说明只描述行为，不暴露用户开关。
const WORD_COUNT_ONLY_NOTE = '本工具只统计实际字数：保持正文不变，不以任何方式（包括脚本批量删改）调整字数；字数要求由程序在本阶段提交后按设置统一处理。';

// 统计字数并启用图片保护；字数校正阶段由 adjust-word-count 执行程序改写。
function createContentGenerationWordTools({ aiService, signal, activity, inspectSection, onActivity, imageProtection, wordAdjust, validateHtml, failTask = () => {} }, { Type, workspaceDir, setActiveTools }) {
  let protection = imageProtection;
  // 正文和配图全部就绪才启用保护，避免把未完成配图锁在保护阶段。
  function enterProtection() {
    const decisions = readDecisions(workspaceDir);
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
    description: `仅在全部正文和配图完成后调用。读取实际 HTML，返回总字数、上下限和缺失小节数，各节字数及缺失小节 ID 写入 程序清单/正文字数统计.json，按需读取；内容就绪后启用图片写入保护，不修改正文。${WORD_COUNT_ONLY_NOTE}`,
    parameters: Type.Object({}),
    async execute() {
      if (activity.pending) throw new Error('仍有生成或编辑任务运行，请等待全部结束再检查字数');
      onActivity?.({ progress: { step: 'word-check', label: '正在统计正文总字数' } });
      const words = enterProtection();
      onActivity?.({ progress: { step: 'word-check', label: `实际 ${words.total_words} 字${words.check_total_words ? `，${words.in_range ? '已达标' : `距有效范围相差 ${words.difference} 字`}` : '，本轮仅统计字数'}`, done: true } });
      // 差额和方向只用于程序校正及进度展示，不交给模型，避免主 Agent 自行增删字数。
      const { difference: _difference, direction: _direction, in_range: _inRange, ...facts } = reportWordCount(workspaceDir, words);
      return result(words, { ...facts, note: WORD_COUNT_ONLY_NOTE });
    },
  }, {
    name: WORD_ADJUST_TOOL, label: '字数校正', executionMode: 'sequential',
    description: '仅在字数校正阶段调用：程序按已分配的调整量逐节改写、校验并复查总字数，返回校正前后字数、改写节数和失败小节。本阶段只调用本工具，并在本次调用上设置 task_complete=true。',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      const state = wordAdjust.get();
      if (!state) throw new Error('当前不在字数校正阶段');
      if (state.status !== 'completed') {
        try {
          await adjustContentWordCount({ aiService, workspaceDir, signal: AbortSignal.any([signal, toolSignal].filter(Boolean)), onActivity, state: wordAdjust, validateHtml });
        } catch (error) {
          // 服务端连续失败时结束整个任务，避免交回 Agent 反复重试；继续任务后从已保存的进度接着改写。
          if (error?.code === AI_UPSTREAM_UNAVAILABLE) failTask(error);
          throw error;
        }
      }
      return result(wordAdjustResult(wordAdjust.get()));
    },
  }];
}

module.exports = {
  WORD_ADJUST_TOOL, WORD_ADJUST_TOOLS, countHtmlWords, checkWordCount, reportWordCount, protectBlocks, restoreBlocks,
  planWordAdjustment, createWordAdjustState, buildWordAdjustPrompt, adjustContentWordCount, createContentGenerationWordTools,
};
