const fs = require('node:fs');
const path = require('node:path');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { AI_UPSTREAM_UNAVAILABLE } = require('../utils/aiBatchGuard.cjs');
const { warmSharedPrefix } = require('./contentGenerationPrefixWarmup.cjs');
const { runAiBatch, requestWithFollowUp, topLevelNodes, spliceHtml, writeHtml } = require('./contentGenerationAiBatch.cjs');

const LAYOUT_TOOL = 'supplement-layout-sections';
// 格式补写阶段主 Agent 只调用补写工具。
const LAYOUT_TOOLS = [LAYOUT_TOOL, 'report-failure'];
// 补写字数下限占建议字数的比例；超过建议字数会把内容挤到下一页，宁少勿多。
const LAYOUT_MIN_RATIO = 0.7;

// 阶段提示词只交代调用工具；定位、补写、核对和写回都由工具完成。
function buildLayoutPrompt(state) {
  if (state.submission) return `格式补写已经完成。调用 ${LAYOUT_TOOL} 读取结果，并在该调用上设置 task_complete=true；不要读取或修改正文，也不要调用其他工具。`;
  const gaps = state.jobs.reduce((sum, job) => sum + job.gaps.length, 0);
  return `正文生成、字数校正、一致性审计及可选的去表格已结束。程序已按当前模板导出 Word 并检测页栏留白：共 ${state.jobs.length} 个小节、${gaps} 处需要在图片前补写文字。调用 ${LAYOUT_TOOL}，并在该调用上设置 task_complete=true。工具由程序按图片定位、生成补写段落、核对字数并写回；不要读取或修改正文，也不要调用其他工具。工具返回后本阶段结束，程序随后重新导出复查。工具报错时按错误说明重新调用。`;
}

const gapKey = (sectionId, gap) => `${sectionId}:${gap.figure_ids?.[0] || `block-${gap.block_index}`}`;
const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 按图片标识定位留白后的图片块，标识缺失时退回检测时的顶层下标；补写段落 id 由图片块 id 确定，存在即已补写。
function locateGap(html, gap) {
  const { $, nodes } = topLevelNodes(html);
  const elements = nodes.filter(item => item.kind === 'element');
  const figureId = gap.figure_ids?.[0];
  const hasImage = item => $(item.node).find('figure').addBack('figure').length > 0;
  let index = figureId ? elements.findIndex(item => $(item.node).find('figure').addBack('figure').toArray().some(figure => $(figure).attr('id') === figureId)) : -1;
  if (index < 0 && !figureId && elements[gap.block_index] && hasImage(elements[gap.block_index])) index = gap.block_index;
  if (index < 0) return null;
  const element = elements[index];
  const leadId = `${String($(element.node).attr('id') || figureId).slice(0, 59)}_lead`;
  const position = nodes.indexOf(element);
  const marker = nodes[position - 1]?.kind === 'marker' ? nodes[position - 1] : null;
  const preceding = elements.slice(0, index).filter(item => ['p', 'ul', 'ol'].includes(item.node.name)).slice(-2)
    .map(item => $(item.node).text().replace(/\s+/g, ' ').trim()).join('\n');
  return {
    leadId, inserted: $('[id]').toArray().some(node => $(node).attr('id') === leadId),
    insertAt: marker ? marker.start : element.start, preceding,
    caption: $(element.node).find('figcaption').map((_index, node) => $(node).text().trim()).get().join('；'),
  };
}

// 全轮相同的补写规则放在 system，便于并发请求复用前缀缓存。
const SUPPLEMENT_SYSTEM = `你负责为投标正文补写一段过渡文字，插在指定图片之前，用于填补排版留白。
要求：写一段连贯的纯文本，承接前文并自然引出后面的图片；内容与本节标题和写作重点直接相关，有实际信息，不用重复套话填空；不新增无依据的事实、数值或承诺，全局事实未明确的信息按本项目事实缺失处理要求执行；不用标题、列表、Markdown、HTML 或 LaTeX。
字数口径：每个汉字计 1 字，连续的英文字母或数字计 1 字，标点和空白不计。字数必须在要求范围内，宁少勿多。
只输出这一段文字。`;

// 逐处补写并写回工作区；state 提供 get/save，继续时已插入补写段落的位置跳过。
async function supplementLayoutGaps({ aiService, workspaceDir, signal, onActivity, state }) {
  let current = state.get();
  const save = next => {
    current = next;
    state.save(current);
  };
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = new Map(decisions.targets.map(section => [section.id, section]));
  const read = section => fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
  // 结果不可用的位置不再重试；服务端请求失败的位置在继续时重试。
  const failures = { ...current.failures };
  for (const [key, failure] of Object.entries(failures)) if (failure.retry) delete failures[key];
  save({ ...current, failures });
  const items = current.jobs.flatMap(job => job.gaps.map(gap => ({ job, gap, section: targets.get(job.section_id), key: gapKey(job.section_id, gap) })))
    .filter(item => !current.failures[item.key] && !locateGap(read(item.section), item.gap)?.inserted);
  const pendingBySection = new Map();
  for (const item of items) pendingBySection.set(item.job.section_id, (pendingBySection.get(item.job.section_id) || 0) + 1);
  const report = (entries, extra = {}) => onActivity?.({ progress: { step: 'layout-supplement', label: '正在补写排版留白', unit: '节', total: current.jobs.length, items: entries, ...extra } });
  report(current.jobs.map(job => ({ id: job.section_id, status: pendingBySection.has(job.section_id) ? 'pending' : 'success' })));
  const failedSections = new Set();
  // 一节的位置全部处理完才更新该节进度；全部补写成功的小节计入完成。
  const settle = (item, status) => {
    if (status === 'error') failedSections.add(item.job.section_id);
    const left = pendingBySection.get(item.job.section_id) - 1;
    pendingBySection.set(item.job.section_id, left);
    if (left) return;
    const failed = failedSections.has(item.job.section_id);
    if (!failed) save({ ...current, completed_section_ids: [...new Set([...current.completed_section_ids, item.job.section_id])] });
    report([{ id: item.job.section_id, status: failed ? 'error' : 'success' }]);
  };
  const sharedInput = `全局事实设定（完整内容）：\n${fs.readFileSync(path.join(workspaceDir, '全局事实设定.md'), 'utf8')}\n\n本项目事实缺失处理要求：\n${decisions.global_facts_requirements}`;
  if (items.length > 1) await warmSharedPrefix({ aiService, system: SUPPLEMENT_SYSTEM, sharedInput, signal, onActivity, logTitle: '格式补写-公共前缀预热', label: '格式补写公共材料' });
  await runAiBatch({
    items, signal,
    async run(item, guard) {
      report([{ id: item.job.section_id, status: 'running' }]);
      const located = locateGap(read(item.section), item.gap);
      if (!located) throw new Error('未找到对应的图片块');
      const maximum = item.gap.suggested_words;
      const minimum = Math.ceil(maximum * LAYOUT_MIN_RATIO);
      const text = await requestWithFollowUp({
        aiService, guard, logTitle: `格式补写-${item.section.number}-${item.section.title}`,
        messages: [
          { role: 'system', content: SUPPLEMENT_SYSTEM },
          { role: 'user', content: `${sharedInput}\n\n本节：${item.section.number} ${item.section.title}（${item.section.chapter_path || item.section.title}）\n本节写作重点：${item.section.content_plan?.writing_focus || '未提供'}\n补写位置前文：\n${located.preceding || '无'}\n其后图片的图注：${located.caption || '无'}\n补写字数：${minimum}～${maximum} 字。` },
        ],
        evaluate(reply) {
          const content = extractAiSource(reply, 'text').replace(/\s*\n\s*/g, '').trim();
          if (!content) throw new Error('没有输出文字');
          if (/[<>]/.test(content)) throw new Error('只输出一段纯文本，不使用 HTML 标签');
          const words = countReadableWords(content);
          if (words > maximum) return { feedback: `本次补写 ${words} 字，超过上限 ${maximum} 字。请删减到 ${minimum}～${maximum} 字，只输出一段纯文本。`, reason: `补写 ${words} 字，超过上限 ${maximum} 字` };
          if (words < minimum) return { value: content, distance: maximum - words, feedback: `本次补写 ${words} 字，少于 ${minimum} 字。请补充到 ${minimum}～${maximum} 字，只输出一段纯文本。`, reason: `补写 ${words} 字，少于 ${minimum} 字` };
          return { accept: true, value: content };
        },
      });
      guard.signal.throwIfAborted();
      // 写回前重读本节：同节其他位置可能已先插入，重新定位后插在图片块的分隔注释之前，其余内容不变。
      const file = path.join(workspaceDir, item.section.file);
      const html = fs.readFileSync(file, 'utf8');
      const target = locateGap(html, item.gap);
      if (!target) throw new Error('图片块在补写期间已变化，未写回');
      if (!target.inserted) writeHtml(file, spliceHtml(html, [{ start: target.insertAt, end: target.insertAt, text: `<!-- yibiao:block -->\n<p id="${target.leadId}">${escapeHtml(text)}</p>\n\n` }]));
      settle(item, 'success');
    },
    onError(item, error, { cancelled }) {
      if (cancelled) {
        report([{ id: item.job.section_id, status: 'cancelled' }]);
        return;
      }
      save({ ...current, failures: { ...current.failures, [item.key]: { reason: `${error?.message || error}`, retry: error?.isAiRequestError === true } } });
      settle(item, 'error');
    },
  });
  // 本轮结束按文件复查：全部位置已插入补写的小节完成，其余位置连同原因记入 failed_gaps。
  const completed = [];
  const failedGaps = [];
  for (const job of current.jobs) {
    const section = targets.get(job.section_id);
    const html = read(section);
    const missing = job.gaps.filter(gap => !locateGap(html, gap)?.inserted);
    if (!missing.length) completed.push(job.section_id);
    for (const gap of missing) {
      failedGaps.push({ section_id: job.section_id, number: section.number, title: section.title, figure_id: gap.figure_ids?.[0] || '',
        reason: current.failures[gapKey(job.section_id, gap)]?.reason || '补写未完成' });
    }
  }
  save({ ...current, completed_section_ids: completed, failed_gaps: failedGaps, submission: {} });
  report([], { label: `格式补写：完成 ${completed.length} 节${failedGaps.length ? `，${failedGaps.length} 处未补写` : ''}`, done: true });
  return current;
}

// 工具结果：补写完成的小节数和未补写位置原因。
function layoutSupplementResult(state) {
  return { sections: state.jobs.length, completed: state.completed_section_ids.length,
    failed: state.failed_gaps.map(({ number, title, figure_id, reason }) => ({ number, title, figure_id, reason })) };
}

// 格式补写阶段的唯一工具；完成后提交结果，由主流程重新导出复查。
function createContentGenerationLayoutTools({ aiService, signal, onActivity, layout, failTask = () => {} }, { Type, workspaceDir }) {
  return [{
    name: LAYOUT_TOOL, label: '补写排版留白', executionMode: 'sequential',
    description: '仅在格式补写阶段调用：程序按检测到的留白逐处定位图片块，生成补写段落、核对字数后插在图片前，返回完成情况和未补写位置原因。本阶段只调用本工具，并在本次调用上设置 task_complete=true。',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      const state = layout.get();
      if (state?.status !== 'supplementing') throw new Error('当前不在格式补写阶段');
      if (!state.submission) {
        try {
          await supplementLayoutGaps({ aiService, workspaceDir, signal: AbortSignal.any([signal, toolSignal].filter(Boolean)), onActivity, state: layout });
        } catch (error) {
          // 服务端连续失败时结束整个任务，避免交回 Agent 反复重试；继续任务后接着补写剩余位置。
          if (error?.code === AI_UPSTREAM_UNAVAILABLE) failTask(error);
          throw error;
        }
      }
      const details = layoutSupplementResult(layout.get());
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  }];
}

module.exports = { LAYOUT_TOOL, LAYOUT_TOOLS, buildLayoutPrompt, createContentGenerationLayoutTools, supplementLayoutGaps, locateGap };
