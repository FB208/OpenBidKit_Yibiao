const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('cheerio');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { findHtmlStructureIssues } = require('../utils/htmlStructure.cjs');
const { AI_UPSTREAM_UNAVAILABLE } = require('../utils/aiBatchGuard.cjs');
const { runAiBatch, requestWithFollowUp, topLevelNodes, spliceHtml, collectIds, uniqueId, writeHtml } = require('./contentGenerationAiBatch.cjs');

const TABLE_CLEANUP_TOOL = 'remove-section-tables';
// 去表格阶段主 Agent 只调用去表格工具。
const TABLE_CLEANUP_TOOLS = [TABLE_CLEANUP_TOOL, 'report-failure'];
const IMAGE_TABLE_PRESETS = ['imageText', 'threeImages', 'fourImages'];
const NUMBER_PATTERN = /\d+(?:\.\d+)?%?/g;

// 图片表格属于配图布局，不参与数据表格清理。
function hasDataTables(html) {
  const $ = load(html, null, false);
  return $('table').toArray().some(node => !IMAGE_TABLE_PRESETS.includes($(node).attr('data-yb-preset')));
}

// 阶段提示词只交代调用工具；查找、转换、核对和写回都由工具完成。
function buildTableCleanupPrompt(state) {
  if (state.submission || state.status === 'completed') return `去表格已经完成。调用 ${TABLE_CLEANUP_TOOL} 读取结果，并在该调用上设置 task_complete=true；不要读取或修改正文，也不要调用其他工具。`;
  return `一致性审计已结束，用户选择“不要表格”，现在执行去表格。调用 ${TABLE_CLEANUP_TOOL}，并在该调用上设置 task_complete=true。工具由程序找出本轮目标小节中的全部数据表格，逐表转换为段落或列表并核对数值，图片表格保留；不要读取或修改正文，也不要调用其他工具。工具返回后本阶段结束，程序随后进入格式检测。工具报错时按错误说明重新调用。`;
}

// 全角数字和千分位不影响数值核对。
function normalizeNumbers(text) {
  return String(text).replace(/[０-９．％]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
}
// 逐个文本节点取文字：Cheerio 的 text() 会把相邻单元格、列表项、段落及上下标直接拼接，如 10、20 变成 1020。
function textNodes(nodes) {
  const texts = [];
  const visit = node => {
    if (node.type === 'text') texts.push(node.data);
    else for (const child of node.children || []) visit(child);
  };
  nodes.forEach(visit);
  return texts;
}
// 原表与转换结果使用同一口径：逐个文本节点提取数值后合并。
function numbersOf(html) {
  const nodes = load(html, null, false).root().contents().toArray();
  return [...new Set(textNodes(nodes).flatMap(text => normalizeNumbers(text).match(NUMBER_PATTERN) || []))];
}
// 供模型参考的上下文文字，节点之间用空格分隔，避免文字粘连。
const readableText = node => textNodes([node]).join(' ').replace(/\s+/g, ' ').trim();

// 本节需转换的顶层数据表格及无法安全转换的原因；含图片或不在顶层的数据表格不转换。
function scanTables(html) {
  const { $, nodes } = topLevelNodes(html);
  const isData = node => !IMAGE_TABLE_PRESETS.includes($(node).attr('data-yb-preset'));
  const tables = [];
  const skipped = [];
  const elements = nodes.filter(item => item.kind === 'element');
  elements.forEach((item, index) => {
    if (item.node.name === 'table' && isData(item.node)) {
      const source = html.slice(item.start, item.end);
      if ($(item.node).find('figure, img').length) skipped.push('表格单元格内含图片');
      else tables.push({ id: $(item.node).attr('id') || '', source, preceding: index > 0 ? readableText(elements[index - 1].node).slice(-300) : '' });
    } else if ($(item.node).find('table').toArray().some(isData)) skipped.push('表格不在顶层');
  });
  return { tables, skipped };
}

const tableKey = (sectionId, table) => `${sectionId}:${table.id || crypto.createHash('sha256').update(table.source).digest('hex').slice(0, 16)}`;

// 全轮相同的转换规则放在 system，便于并发请求复用前缀缓存。
const CONVERT_SYSTEM = `你负责把投标正文中的一个数据表格转换为受限 HTML 段落或列表，用于“不要表格”的成稿要求。
转换要求：写清原表各项数据与行、列表头的对应关系；保留表题含义、全部数值、单位、条件、备注及承诺，数值保持阿拉伯数字原样；只改变表达形式，不增删信息，不作无关改写。
格式要求：顶层只使用 p、ul、ol，可使用 strong、em、sup、sub 等行内标签；不使用表格、图片、标题、Markdown、代码围栏或 LaTeX；不需要写 id 和 <!-- yibiao:block --> 分隔注释；除空元素外每个元素都写出结束标签。
只输出转换后的 HTML。`;

// 校验转换结果并返回可直接拼回的顶层块；结构不符或缺少原表数值时说明原因。
function parseConversion(reply, numbers) {
  const source = extractAiSource(reply, 'html').trim();
  const issues = findHtmlStructureIssues(source);
  if (issues.length) throw new Error(`HTML 结构不完整：${issues.slice(0, 3).join('；')}`);
  const $ = load(source, null, false);
  const elements = $.root().children().toArray();
  if (!elements.length) throw new Error('没有输出段落或列表');
  if (elements.some(element => !['p', 'ul', 'ol'].includes(element.name))) throw new Error('顶层只能使用 p、ul 或 ol');
  if ($('table, figure, img').length) throw new Error('转换结果不能包含表格或图片');
  if ($.root().contents().toArray().some(node => node.type === 'text' && node.data.trim())) throw new Error('段落和列表之外不能有文字');
  const present = new Set(numbersOf(source));
  const missing = numbers.filter(value => !present.has(value));
  if (missing.length) return { feedback: `转换结果缺少原表中的数值：${missing.join('、')}。请保留原表全部数值、单位和条件，重新输出完整转换结果。`, reason: `转换后缺少原表数值 ${missing.join('、')}` };
  return { accept: true, value: elements.map(element => $.html(element)) };
}

// 程序逐表转换并写回工作区；state 提供 get/save，继续时已转换的表格按原表源码已不在文件中跳过。
async function removeDataTables({ aiService, workspaceDir, signal, onActivity, state }) {
  let current = state.get();
  const save = next => {
    current = next;
    state.save(current);
  };
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const targets = decisions.targets;
  const read = section => fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
  // 结果不可用的表格不再重试；服务端请求失败的表格在继续时重试。
  const failures = { ...current.failures };
  for (const [key, failure] of Object.entries(failures)) if (failure.retry) delete failures[key];
  const scans = new Map(targets.map(section => [section.id, scanTables(read(section))]));
  const sectionIds = targets.filter(section => scans.get(section.id).tables.length || scans.get(section.id).skipped.length).map(section => section.id);
  save({ ...current, section_ids: [...new Set([...current.section_ids, ...sectionIds])], failures });
  const jobs = targets.flatMap(section => scans.get(section.id).tables
    .map(table => ({ section, table, key: tableKey(section.id, table) }))
    .filter(job => !current.failures[job.key]));
  const pendingBySection = new Map();
  for (const job of jobs) pendingBySection.set(job.section.id, (pendingBySection.get(job.section.id) || 0) + 1);
  const report = (items, extra = {}) => onActivity?.({ progress: { step: 'table-repair', label: '正在转换数据表格', unit: '节', total: current.section_ids.length, items, ...extra } });
  report(current.section_ids.map(id => ({ id, status: pendingBySection.has(id) ? 'pending' : 'success' })));
  const failedSections = new Set();
  // 一节的表格全部处理完才更新该节进度；全部转换成功的小节计入完成。
  const settle = (job, status) => {
    if (status === 'error') failedSections.add(job.section.id);
    const left = pendingBySection.get(job.section.id) - 1;
    pendingBySection.set(job.section.id, left);
    if (left) return;
    const failed = failedSections.has(job.section.id) || scans.get(job.section.id).skipped.length > 0;
    if (!failed) save({ ...current, completed_section_ids: [...new Set([...current.completed_section_ids, job.section.id])] });
    report([{ id: job.section.id, status: failed ? 'error' : 'success' }]);
  };
  await runAiBatch({
    items: jobs, signal,
    async run(job, guard) {
      report([{ id: job.section.id, status: 'running' }]);
      const blocks = await requestWithFollowUp({
        aiService, guard, logTitle: `去表格-${job.section.number}-${job.section.title}`,
        messages: [
          { role: 'system', content: CONVERT_SYSTEM },
          { role: 'user', content: `本节：${job.section.number} ${job.section.title}\n表格前文：${job.table.preceding || '无'}\n\n待转换的表格：\n${job.table.source}` },
        ],
        evaluate: reply => parseConversion(reply, numbersOf(job.table.source)),
      });
      guard.signal.throwIfAborted();
      // 写回前重读本节：同节其他表格可能已先写回，按原表源码定位后整块替换，其余内容不变。
      const file = path.join(workspaceDir, job.section.file);
      const html = fs.readFileSync(file, 'utf8');
      const start = html.indexOf(job.table.source);
      if (start < 0) throw new Error('原表格在转换期间已变化，未写回');
      const used = collectIds(load(html, null, false));
      const base = job.table.id || `${job.section.number.replace(/\W+/g, '_')}_tbl`;
      const $ = load('', null, false);
      const text = blocks.map((block, index) => {
        const element = $(block);
        element.attr('id', uniqueId(`${base}_c${index + 1}`, used));
        return $.html(element);
      }).join('\n\n<!-- yibiao:block -->\n');
      writeHtml(file, spliceHtml(html, [{ start, end: start + job.table.source.length, text }]));
      settle(job, 'success');
    },
    onError(job, error, { cancelled }) {
      if (cancelled) {
        report([{ id: job.section.id, status: 'cancelled' }]);
        return;
      }
      save({ ...current, failures: { ...current.failures, [job.key]: { section_id: job.section.id, reason: `${error?.message || error}`, retry: error?.isAiRequestError === true } } });
      settle(job, 'error');
    },
  });
  // 本轮结束按文件复查：没有数据表格的小节完成，仍有表格的小节连同原因记为遗留。
  const remaining = [];
  const completed = [];
  for (const section of targets.filter(item => current.section_ids.includes(item.id))) {
    const { tables, skipped } = scanTables(read(section));
    if (!tables.length && !skipped.length) {
      completed.push(section.id);
      continue;
    }
    const reasons = [...skipped, ...tables.map(table => current.failures[tableKey(section.id, table)]?.reason || '转换未完成')];
    remaining.push({ section_id: section.id, number: section.number, title: section.title, reason: [...new Set(reasons)].join('；') });
  }
  save({ ...current, completed_section_ids: completed, remaining, remaining_section_ids: remaining.map(item => item.section_id), submission: {} });
  report([], { label: `去表格：转换 ${completed.length} 节${remaining.length ? `，${remaining.length} 节保留表格` : ''}`, done: true });
  return current;
}

// 工具结果：处理小节数和保留表格的小节原因。
function tableCleanupResult(state) {
  return { sections: state.section_ids.length, converted: state.completed_section_ids.length,
    remaining: state.remaining.map(({ number, title, reason }) => ({ number, title, reason })) };
}

// 去表格阶段的唯一工具；完成后提交结果，由主流程进入格式检测。
function createContentGenerationTableTools({ aiService, signal, onActivity, tableCleanup, failTask = () => {} }, { Type, workspaceDir }) {
  return [{
    name: TABLE_CLEANUP_TOOL, label: '去除数据表格', executionMode: 'sequential',
    description: '仅在去表格阶段调用：程序找出本轮目标小节中的全部数据表格，逐表转换为段落或列表并核对数值后写回，图片表格保留；返回处理结果和保留表格的小节原因。本阶段只调用本工具，并在本次调用上设置 task_complete=true。',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal) {
      const state = tableCleanup.get();
      if (!state) throw new Error('当前不在去表格阶段');
      // 已提交或已完成时直接返回保存的结果，不再转换；去表格完成后在格式检测准备中失败，继续任务会回到本阶段读取结果。
      if (!state.submission && state.status !== 'completed') {
        try {
          await removeDataTables({ aiService, workspaceDir, signal: AbortSignal.any([signal, toolSignal].filter(Boolean)), onActivity, state: tableCleanup });
        } catch (error) {
          // 服务端连续失败时结束整个任务，避免交回 Agent 反复重试；继续任务后接着转换剩余表格。
          if (error?.code === AI_UPSTREAM_UNAVAILABLE) failTask(error);
          throw error;
        }
      }
      const details = tableCleanupResult(tableCleanup.get());
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  }];
}

module.exports = { TABLE_CLEANUP_TOOL, TABLE_CLEANUP_TOOLS, hasDataTables, buildTableCleanupPrompt, createContentGenerationTableTools, removeDataTables, scanTables, numbersOf };
