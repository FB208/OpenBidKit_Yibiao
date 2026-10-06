const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { SUBMISSION_FIX_TOOL, editContentSections, batchResponse } = require('./contentGenerationEditTools.cjs');
const { TASK_FILE_WRITING, taskFilePath, readTaskFile, writeListFile, readListFile } = require('./contentGenerationTaskFiles.cjs');
const { warmPromptPrefix, sharedPrefixMessages } = require('../utils/promptPrefixCache.cjs');
const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');
const { AI_UPSTREAM_UNAVAILABLE, createAiBatchGuard, isBatchCancelled } = require('../utils/aiBatchGuard.cjs');

// 修改较多小节时通过 repair-sections 并发派发；主 Agent 也可直接修改少量小节，结果在提交时校验。
const CONSISTENCY_TOOLS = [...NATIVE_AGENT_TOOLS, 'ask-user', 'search-sections', 'recheck-sections', 'repair-sections', 'complete-consistency-round', SUBMISSION_FIX_TOOL, 'report-failure'];
const LEDGER_JSON = '正文一致性事实台账.json';
const LEDGER_FILE = '正文一致性事实台账.md';
// 核对口径或台账结构变化时递增，旧缓存整体失效。
const LEDGER_VERSION = 2;
const ISSUE_TYPES = ['与全局事实冲突', '小节内部矛盾'];
const FACT_CATEGORIES = ['人数与数量', '日期与期限', '频次与时限', '地点与范围', '金额', '技术参数', '编号与名称', '责任归属', '其他'];
const SEARCH_LIMIT = 80;
const SNIPPET_LENGTH = 400;
const REPAIR_INSTRUCTIONS = '只修复主 Agent 指定的矛盾及本批统一修复规则涉及的内容，遵循其统一结论，只改与矛盾直接相关的数值或陈述，其他用词、称谓和表述保持原样，不检查或调整总字数。主 Agent 给出的段落 ID 只用于定位：问题文字不在该段时，在本节内按语义找到同一问题所在位置修改，不因段落 ID 不符而失败；指定问题在本节已不存在（例如已经修复）时不修改，简短说明后结束；本轮修改后提交真实结果，未完全消除的矛盾交由主 Agent 统一验收；只有无法继续执行的实际阻断才调用 report-failure。';
const RULE_CHECK_INSTRUCTIONS = '本节无单独指定问题：按本批统一修复规则在本节全文按语义自查，发现相关表述即按规则修改；没有相关内容时不修改，直接简短回复“本节无需修改”结束。';

// ID 抄错时给出开头相同的目标小节（至少前 8 位或整段相同），便于主 Agent 直接改正后重新派发。
function unknownSectionMessage(id, targets) {
  const commonPrefix = value => { let index = 0; while (index < id.length && index < value.length && id[index] === value[index]) index += 1; return index; };
  const candidates = [...targets.values()].filter(section => commonPrefix(section.id) >= Math.min(8, section.id.length))
    .map(section => `${section.number} ${section.title}（${section.id}）`);
  return `未执行：小节 ID 不属于本轮目标：${id}。${candidates.length ? `ID 开头相同的目标小节：${candidates.join('；')}。` : ''}请从台账“小节目录”原样复制小节 ID 后重新派发。`;
}

const readDecisions = workspaceDir => JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));

// 本轮修复结果按小节累积：状态取最近一次派发，改动对比依次追加；新一轮开始时程序清单整体清空。
function mergeRepairResults(previous, batch) {
  const merged = new Map((previous?.results || []).map(item => [item.section_id, item]));
  for (const item of batch) {
    const old = merged.get(item.section_id);
    merged.set(item.section_id, old?.changes ? { ...item, changes: [...old.changes, ...(item.changes || [])] } : item);
  }
  const results = [...merged.values()];
  const repaired = results.filter(item => item.status === 'success').length;
  return { summary: { repaired, failed: results.length - repaired }, results };
}

// 审计范围：本轮目标需核对和修复；新增小节时，已完成的其他小节只作只读参考，按当前目录顺序排列。
function auditScope(workspaceDir) {
  const decisions = readDecisions(workspaceDir);
  const references = (decisions.completed_sections || [])
    .filter(section => fs.existsSync(path.join(workspaceDir, section.file)))
    .map(section => ({ ...section, reference: true }));
  const outlineFile = path.join(workspaceDir, '正文完整目录.json');
  const order = new Map();
  const visit = items => items.forEach(item => { order.set(item.id, order.size); if (item.children) visit(item.children); });
  if (fs.existsSync(outlineFile)) visit(JSON.parse(fs.readFileSync(outlineFile, 'utf8')).outline || []);
  const sections = [...decisions.targets, ...references]
    .sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity));
  return { decisions, targets: decisions.targets, references, sections };
}

// 审计只看正文事实：按顶层元素拆块，去掉标签、注释和图片提示词，保留段落 ID、图注及表格数据。
function auditBlocks(html) {
  const $ = cheerio.load(String(html).replace(/\r\n/g, '\n'), null, false);
  $('template').remove();
  // 上下标和换行按原意转成可读符号：10<sup>3</sup> 写作 10^3 而非 103，换行前后文字不粘连。
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const [tag, symbol] of [['sup', '^'], ['sub', '_']]) {
    $(tag).each((_index, item) => {
      const value = $(item).text().trim();
      $(item).replaceWith(!value ? '' : escape(/^-?[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`));
    });
  }
  $('br').replaceWith(' ');
  const text = node => $(node).text().replace(/\s+/g, ' ').trim();
  const figure = node => `[图 ${$(node).attr('id') || ''}：${text($(node).find('figcaption')) || $(node).find('img').attr('alt') || '无图注'}]`;
  function cell(node) {
    const figures = $(node).find('figure').toArray().map(figure);
    const rest = $(node).clone();
    rest.find('figure').remove();
    return [...figures, text(rest)].filter(Boolean).join(' ');
  }
  return $.root().children().toArray().map((node, index) => {
    let body;
    if (node.name === 'figure') body = figure(node);
    else if (node.name === 'table') {
      const caption = text($(node).children('caption'));
      const rows = $(node).find('tr').toArray().map(row => $(row).children('th, td').toArray().map(cell).join(' | '));
      body = [caption && `表：${caption}`, ...rows].filter(Boolean).join('\n');
    } else if (node.name === 'ol' || node.name === 'ul') {
      body = $(node).children('li').toArray().map((item, itemIndex) => `${node.name === 'ol' ? `${itemIndex + 1}.` : '-'} ${text(item)}`).join('\n');
    } else body = text(node);
    const id = $(node).attr('id') || `第${index + 1}块`;
    // 与展示同源收集可引用 ID：顶层块（含程序补的块序号）及其内部图片等元素，不受属性引号写法影响。
    return { id, text: body, ids: [id, ...$(node).find('[id]').toArray().map(item => $(item).attr('id'))] };
  }).filter(block => block.text);
}

const formatAuditBlocks = blocks => blocks.map(block => `[${block.id}] ${block.text}`).join('\n');

function sectionAuditText(html) {
  return formatAuditBlocks(auditBlocks(html));
}

// 修复结果只返回改动段落的前后文本，主 Agent 据此核实，无须整节重读。
function blockChanges(beforeHtml, afterHtml) {
  const before = new Map(auditBlocks(beforeHtml).map(block => [block.id, block.text]));
  const after = auditBlocks(afterHtml);
  const changes = after.filter(block => before.get(block.id) !== block.text)
    .map(block => ({ block_id: block.id, before: before.get(block.id) ?? '', after: block.text }));
  const afterIds = new Set(after.map(block => block.id));
  for (const [id, text] of before) if (!afterIds.has(id)) changes.push({ block_id: id, before: text, after: '' });
  return changes;
}

function readLedger(workspaceDir) {
  const file = path.join(workspaceDir, LEDGER_JSON);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sections: {} };
}

function writeWorkspaceFile(workspaceDir, file, content) {
  const target = path.join(workspaceDir, file);
  fs.writeFileSync(`${target}.tmp`, content, 'utf8');
  fs.renameSync(`${target}.tmp`, target);
}

const hashHtml = html => crypto.createHash('sha256').update(html).digest('hex');

const writeLedgerJson = (workspaceDir, ledger) => writeWorkspaceFile(workspaceDir, LEDGER_JSON, JSON.stringify(ledger, null, 2));

// 按目录顺序列出本轮目标的问题，事实按类别和主体排列；参考小节只提供事实，便于相邻比对跨节取值。
// 核对失败的小节单独列出原因，交给主 Agent 重新核对或自行核对。
function buildLedgerMarkdown(sections, ledger) {
  const incremental = sections.some(section => section.reference);
  const label = section => `${section.number} ${section.title}`;
  const tag = section => !incremental ? '' : section.reference ? '[参考·只读] ' : '[本轮目标] ';
  const checked = sections.filter(section => ledger.sections[section.id]);
  const failed = sections.filter(section => !ledger.sections[section.id]);
  const issues = checked.filter(section => !section.reference)
    .flatMap(section => ledger.sections[section.id].issues.map(issue => ({ section, issue })));
  const facts = checked.flatMap(section => ledger.sections[section.id].facts.map(fact => ({ section, fact })));
  const factLines = FACT_CATEGORIES.flatMap(category => {
    const group = facts.filter(({ fact }) => fact.category === category)
      .sort((left, right) => left.fact.subject.localeCompare(right.fact.subject, 'zh-Hans-CN'));
    return group.length ? [`### ${category}`, ...group.map(({ section, fact }) => `- ${fact.subject}：${fact.value} —— ${section.number}${section.reference ? '（参考）' : ''} [${fact.block_id || '未定位'}]${fact.quote ? `“${fact.quote}”` : ''}`), ''] : [];
  });
  return [
    '# 正文一致性事实台账',
    `程序并发核对${incremental ? '本轮新增小节，并汇总已完成小节的事实作为只读参考' : '本轮各目标小节'}，只读。方括号内为原小节 HTML 中元素的 id；核实原文时使用 search-sections 或定点读取原小节文件。`,
    '',
    '## 小节目录',
    ...sections.map(section => `- ${tag(section)}${label(section)}｜小节 ID：${section.id}｜文件：${section.file}`),
    '',
    ...(failed.length ? [
      `## 核对失败的小节（共 ${failed.length} 节，其问题和事实未列入本台账）`,
      '先调用 recheck-sections 重新核对（失败原因指向本节 HTML 时可先修正再核对）；仍失败时读取原小节文件自行核对问题和事实，提交结论时在 manually_checked_section_ids 中列出。',
      ...failed.map(section => `- ${tag(section)}${label(section)}｜小节 ID：${section.id}｜文件：${section.file}｜原因：${ledger.failures?.[section.id] || '尚未核对'}`),
      '',
    ] : []),
    `## 一、${incremental ? '本轮目标' : ''}小节核对发现的问题（共 ${issues.length} 项）`,
    ...(issues.length ? issues.map(({ section, issue }, index) => `${index + 1}. [${label(section)}｜${section.id}｜${issue.block_id || '未定位'}] ${issue.type}：${issue.problem}；依据：${issue.evidence}；建议：${issue.suggestion}`) : ['无']),
    '',
    `## 二、可核对事实（共 ${facts.length} 条，按类别及主体排列${incremental ? '；标注“参考”的来自已完成小节，只读' : ''}）`,
    ...(facts.length ? factLines : ['无']),
  ].join('\n');
}

// 全轮相同的核对规则放在 system，只提供全局事实公共段和本节正文，便于并发请求复用前缀缓存。
function buildExtractionSystem() {
  return `你负责投标正文一致性审计中的单小节核对，只处理本次请求提供的一个小节，不改写正文。一致性审计只关注两类问题：正文前后矛盾，以及正文与全局事实设定冲突。任务包括两部分。
一、核对问题（issues），只报告两类：
1. 与全局事实冲突：本节说法与全局事实设定中明确写出的内容相反，或数量、日期、期限、地点、金额、编号、名称、参数等取值不一致。
2. 小节内部矛盾：本节对同一对象、同一条件和时间范围的两处说法不能同时成立，例如数量、日期、期限、频次、时限、地点、金额、技术参数不一致，或同一事项的责任方互相排斥。
判断前核对对象、适用条件和时间范围，因对象、条件或阶段不同产生的差异不属于问题。以下情况不是问题，不报告：用词、称谓、表述不同或详略不同；全局事实未提及的补充内容（例如岗位、流程、交付物、频次、承诺），只要不与全局事实或本节其他内容冲突；承诺语气强弱；文风、润色和篇幅。不追究内容是否有材料依据。只报告会影响阅读理解或项目实施的明显问题；没有问题时 issues 为空数组。
二、可核对事实（facts）：抽取本节中有具体取值或明确归属、其他小节可能写出不同说法的陈述，用于跨小节比对，例如人数与数量、日期与期限、频次与时限、地点与范围、金额、技术参数、编号与名称，以及某项工作明确由哪一方负责。value 使用简短写法；同一事实只记一次；不抽取流程说明、一般性职责描述或没有具体取值、具体归属的表述。
输出一个 JSON 对象：{"issues":[{"block_id":"段落编号","type":"问题类型","problem":"矛盾说明","evidence":"依据，引用全局事实或本节原文","suggestion":"建议的统一结论"}],"facts":[{"category":"类别","subject":"事实主体，如“服务期”","value":"本节中的取值或归属，如“一年”","block_id":"段落编号","quote":"本节原文摘录，不超过40字"}]}
type 只能取：${ISSUE_TYPES.join('、')}。category 只能取：${FACT_CATEGORIES.join('、')}。block_id 原样填写正文方括号内的段落编号（如 B3），无法对应具体段落时填空字符串。只输出 JSON，不输出其他内容。`;
}

const reportExtraction = (onActivity, total, items, extra = {}) => onActivity?.({ progress: { step: 'consistency-extract', label: '正在并发核对小节事实', unit: '节', total, items, ...extra } });

// 并发核对指定小节并逐节写入台账：成功写入 sections，失败原因记入 failures 交给主 Agent 处理。
// 暂停时按暂停抛出；服务端连续失败时停止派发剩余小节并抛出，已完成的核对保留。
async function checkLedgerSections({ aiService, workspaceDir, ledger, pending, total, signal, onActivity, onChecked = () => {} }) {
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  const report = (items, extra) => reportExtraction(onActivity, total, items, extra);
  const guard = createAiBatchGuard({ signal });
  const system = buildExtractionSystem();
  const sharedInput = `全局事实设定（完整内容）：\n${read('全局事实设定.md')}`;
  ledger.failures ||= {};
  if (pending.length > 1) await warmPromptPrefix({ aiService, messages: sharedPrefixMessages(system, sharedInput), signal: guard.signal, onActivity, logTitle: '一致性核对-公共前缀预热', label: '一致性核对公共材料' });
  const results = await Promise.allSettled(pending.map(async section => {
    try {
      guard.signal.throwIfAborted();
      report([{ id: section.id, status: 'running' }]);
      const html = read(section.file);
      const blocks = auditBlocks(html);
      const ids = new Set(blocks.flatMap(block => block.ids));
      // 核对输入使用程序分配的段落编号，模型无从改写不规范的原始 ID；返回时换回真实 ID，无法对应的置空。
      const labels = new Map(blocks.map((block, index) => [`B${index + 1}`, block.id]));
      const blockId = value => {
        const raw = String(value ?? '').trim().replace(/^\[|\]$/g, '').trim();
        return labels.get(raw) || (ids.has(raw) ? raw : '');
      };
      const result = await aiService.requestJson({
        signal: guard.signal, logTitle: `一致性核对-${section.number}-${section.title}`, progressLabel: `一致性核对 ${section.number}`,
        failureMessage: `小节 ${section.number} ${section.title} 的一致性核对结果无效`,
        messages: sharedPrefixMessages(system, sharedInput, `本节：${section.number} ${section.title}（小节 ID：${section.id}）\n${section.reference ? '本节为已完成的参考小节：issues 返回空数组，只抽取 facts。\n' : ''}本节正文（方括号内为段落编号）：\n${blocks.map((block, index) => `[B${index + 1}] ${block.text}`).join('\n')}`),
        normalizer: output => ({
          issues: section.reference ? [] : (output?.issues || []).map(issue => ({ ...issue, block_id: blockId(issue?.block_id) })),
          facts: (output?.facts || []).map(fact => ({ ...fact, block_id: blockId(fact?.block_id) })),
        }),
        validator(output) {
          const text = value => typeof value === 'string' && value.trim();
          for (const issue of output.issues) {
            if (!ISSUE_TYPES.includes(issue.type) || !text(issue.problem) || typeof issue.evidence !== 'string' || typeof issue.suggestion !== 'string') throw new Error('issues 每项须包含合法 type 及 problem、evidence、suggestion');
          }
          for (const fact of output.facts) {
            if (!FACT_CATEGORIES.includes(fact.category) || !text(fact.subject) || !text(fact.value) || typeof fact.quote !== 'string') throw new Error('facts 每项须包含合法 category 及 subject、value、quote');
          }
        },
      });
      guard.signal.throwIfAborted();
      guard.success();
      ledger.sections[section.id] = { version: LEDGER_VERSION, hash: hashHtml(html), ...(section.reference ? { reference: true } : {}), ...result };
      delete ledger.failures[section.id];
      writeLedgerJson(workspaceDir, ledger);
      report([{ id: section.id, status: 'success' }]);
      onChecked();
    } catch (error) {
      const cancelled = isBatchCancelled(error, guard.signal);
      if (!cancelled) {
        guard.failure(error);
        ledger.failures[section.id] = error?.message || String(error);
        writeLedgerJson(workspaceDir, ledger);
      }
      report([{ id: section.id, status: cancelled ? 'cancelled' : 'error' }]);
      throw error;
    }
  }));
  signal.throwIfAborted();
  if (guard.error) throw guard.error;
  const paused = results.find(item => item.status === 'rejected' && item.reason?.code === AI_QUEUE_SCOPE_PAUSED);
  if (paused) throw paused.reason;
}

// 各小节并发核对并落盘，暂停后只补未完成的小节；程序步骤不经过主会话模型。
// 个别小节核对失败不中断审计，失败原因写入台账交给主 Agent；服务端连续失败时报错，继续后只补剩余小节。
// checkChanges 为 true 时按正文哈希识别已变化的小节并重新核对，未变化的参考小节直接复用上次结果。
async function extractConsistencyLedger({ aiService, workspaceDir, signal, onActivity, checkChanges = true, onProgress = () => {} }) {
  const { sections } = auditScope(workspaceDir);
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  const stored = readLedger(workspaceDir);
  const ledger = { version: LEDGER_VERSION, sections: {}, failures: {} };
  for (const section of sections) {
    const entry = stored.sections?.[section.id];
    // 参考小节只抽取事实，其结果不能用于同一小节作为本轮目标时。
    if (entry?.version === LEDGER_VERSION && (section.reference || !entry.reference)
      && (!checkChanges || entry.hash === hashHtml(read(section.file)))) ledger.sections[section.id] = entry;
  }
  const done = () => sections.filter(section => ledger.sections[section.id]).length;
  const pending = sections.filter(section => !ledger.sections[section.id]);
  // 比对修复中续跑且没有缺失小节时直接沿用台账，不重写文件，也不把页面切回核对步骤。
  if (!checkChanges && !pending.length) return ledger;
  writeLedgerJson(workspaceDir, ledger);
  reportExtraction(onActivity, sections.length, sections.map(section => ({ id: section.id, status: ledger.sections[section.id] ? 'success' : 'pending' })));
  onProgress(done(), sections.length);
  if (pending.length) {
    await checkLedgerSections({ aiService, workspaceDir, ledger, pending, total: sections.length, signal, onActivity,
      onChecked: () => onProgress(done(), sections.length) });
  }
  writeWorkspaceFile(workspaceDir, LEDGER_FILE, buildLedgerMarkdown(sections, ledger));
  const failed = Object.keys(ledger.failures).length;
  reportExtraction(onActivity, sections.length, [], { label: failed ? `小节事实核对完成，${failed} 节核对失败交由主 Agent 处理` : '小节事实核对完成', done: true });
  return ledger;
}

// 单轮审计：只处理正文前后矛盾和与全局事实冲突；主 Agent 基于台账比对，统一经 repair-sections 修复。
function buildConsistencyPrompt(state, { hasKnowledgeBase, workspaceDir }) {
  if (state.status === 'completed') return '一致性审计已经结束。保留现有正文及结果清单，读取正文生成结果.json并标记 task_complete=true；不要重新审计、修复或调整字数。';
  const incremental = auditScope(workspaceDir).references.length > 0;
  return `现在执行全文一致性审计，一次完成审计和修复，不分轮次。一致性审计只处理两类问题：正文前后矛盾（同一小节内部或不同小节之间），以及正文与全局事实设定冲突。程序已${incremental ? '核对本轮新增小节，并汇总已完成小节的事实作为参考' : '并发核对本轮每个目标小节'}，结果在《${LEDGER_FILE}》：包括小节与全局事实的冲突、小节内部矛盾，以及按类别排列的可核对事实。
${incremental ? '本轮为新增小节审计：只审计和修改本轮目标小节；台账中标注“参考·只读”的已完成小节不修改，只作为比对依据。新增小节与参考小节不一致时，修改新增小节，使其与参考小节保持一致。\n' : ''}1. 阅读全局事实设定.md和该台账。台账的阅读方式自行决定，可按类别分段读取，但须覆盖其中全部问题和全部类别的事实；不必逐节通读正文。台账列出“核对失败的小节”时，这些小节的问题和事实未列入台账：先调用 recheck-sections 重新核对（失败原因指向本节 HTML 时可先修正再核对）；仍失败时读取原小节文件自行核对问题和事实，提交结论时在 manually_checked_section_ids 中列出。
2. 复核台账列出的小节问题，剔除因对象、适用条件或阶段不同而产生的差异；再按类别比对各小节事实，找出同一事实取值不同或说法互相排斥的地方，例如数量、日期、期限、频次、时限、地点、金额、技术参数、编号与名称不一致，或同一事项的责任方互相排斥。需要核实原文时，用 search-sections 按关键词定位具体矛盾所在段落，或定点读取原小节文件；不要逐节通读全部正文，不为寻找近义说法反复检索。
3. 统一取值：与全局事实冲突的，以全局事实设定为准；全局事实未规定的，可参考项目概述.md、招标文件关键信息.md${hasKnowledgeBase ? '及知识库' : ''}等材料；没有可确认的材料或材料之间互相冲突时，由你选定一个合理取值。一致性审计的目标是全文一致、正文自身不矛盾，外部材料只作参考，不因缺少依据而保留矛盾。
4. 以下内容不是问题，不修改：用词、称谓、表述不同或详略不同；全局事实未提及的补充内容（例如岗位、流程、交付物、频次、承诺），只要不与全局事实或其他内容冲突；承诺语气强弱；文风和润色。不追究内容是否有材料依据，不撤回或削弱承诺，只处理会影响阅读理解或项目实施的矛盾。
5. 确定统一结论后，将需要修改的小节写入 ${taskFilePath('repair')}，格式为 {"rules":"可选，统一修复规则","sections":[{"section_id":"小节 ID","instructions":"本节具体矛盾及统一结论"}]}，再调用 repair-sections 派发；section_id 从台账“小节目录”原样复制${incremental ? '，只能提交本轮目标小节' : ''}。${TASK_FILE_WRITING}同一取值需要在多个小节统一时，写成统一规则放入 rules（写明统一后的取值及适用范围，例如“服务期统一为一年”），并列出涉及的小节，这些小节 instructions 可填空字符串，子任务会在各自小节按规则修改；个别矛盾在该节 instructions 写清段落 ID、矛盾内容及统一结论。子任务按该结论修复，不自行选择另一套取值。需要修改的小节超过 5 个时通过 repair-sections 并发修复；5 个及以下可以直接修改对应小节文件，按同一结论修改。
6. repair-sections 返回本批统计和未成功项；程序清单/一致性修复结果.json 按小节累积本轮全部派发结果（summary 为已修复与未成功小节数，各节 status 为最近一次结果，changes 为改动段落修改前后的文本），按需读取核实修复结果；未执行的项（ID 不属于本轮目标、正在编辑或缺少要求）按提示改正后重新派发，未解决项如实保留，本轮处理后交由统一提交校验决定是否继续修复；任务文件内容即本次派发的任务，再次派发时改写为失败、未执行或明显漏改的小节，已修好的小节不重复派发。需要分批时可以依次改写任务文件并多次提交。
7. 本轮处理并核实真实结果后调用 complete-consistency-round 提交结论，完成标记放在该调用上；程序统一校验，由统一规则决定继续修复或结束审计进入后续流程。remaining_issues 只记录确实无法在本轮修复的矛盾${incremental ? '（例如参考小节之间、或参考小节与全局事实之间的矛盾）' : ''}；本次目标内没有问题时直接提交。
已插入的图片块、图注、提示词、引用、顺序和图片表格布局不得修改，提交时程序逐节核对，不一致会退回并附上原始图片块；普通文字可改，原表格和实质信息应保留。不检查或调整总字数。正文留在原小节 HTML 文件中，不修改输入资料、台账、其他小节或业务数据库。`;
}

// 汇总本轮尚未完成的修复与核对目标；原本允许记录的 remaining_issues 不新增失败条件。
function collectConsistencySubmissionIssues(workspaceDir, state) {
  if (!state.submission) return [];
  const scope = auditScope(workspaceDir);
  const byId = new Map(scope.sections.map(section => [section.id, section]));
  const issues = (state.failed_sections || []).map(id => {
    const section = byId.get(id);
    return { severity: 'quality', type: 'consistency-repair', section_id: id,
      file: section.file, number: section.number, title: section.title, fixable: false,
      message: `小节 ${section.number} ${section.title} 的一致性修复尚未成功，请按已确定的统一结论继续处理并提交真实结果。` };
  });
  const ledger = readLedger(workspaceDir);
  const manual = new Set(state.submission.manually_checked_section_ids || []);
  for (const section of scope.sections) {
    if (ledger.sections?.[section.id] || manual.has(section.id)) continue;
    issues.push({ severity: 'quality', type: 'consistency-check', section_id: section.id,
      file: section.file, number: section.number, title: section.title, fixable: false,
      message: `小节 ${section.number} ${section.title} 尚无核对结果；可重新核对，或读取原文自行核对后在 manually_checked_section_ids 中列出。` });
  }
  return issues;
}

// 主 Agent 检索、重新核对、派发修复及提交结论；子任务失败随持久会话保存。
// 程序改写台账后调用 protectLedger 重新登记；服务端连续失败时 failTask 结束整个任务，不交回 Agent 反复重试。
function createContentGenerationConsistencyTools({ agentService, aiService, signal, activity, inspectSection, onActivity, consistency, protectLedger = () => {}, failTask = () => {} }, { Type, workspaceDir }) {
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  function requireAuditing() {
    const state = consistency.get();
    if (!state || state.status !== 'running') throw new Error('当前不在可修复的一致性审计阶段');
    return state;
  }
  return [{
    name: 'search-sections', label: '检索正文小节',
    description: '在本轮目标小节及已完成参考小节的最新正文纯文本中按关键词检索段落，任一关键词命中即返回小节及段落 ID，用于定位具体矛盾；参考小节结果标记 reference=true，只读。检索文本不含 HTML 标记和图片提示词。',
    parameters: Type.Object({
      keywords: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '关键词，按原文字面匹配，不支持正则。' }),
      section_ids: Type.Optional(Type.Array(Type.String(), { description: '可选，限定检索的小节 ID；不填检索全部审计范围。' })),
    }),
    async execute(_callId, params) {
      const scope = params.section_ids?.length ? new Set(params.section_ids) : null;
      const keywords = params.keywords.map(keyword => keyword.toLowerCase());
      const matches = [];
      let total = 0;
      for (const section of auditScope(workspaceDir).sections) {
        if (scope && !scope.has(section.id)) continue;
        for (const block of auditBlocks(read(section.file))) {
          const lower = block.text.toLowerCase();
          const positions = keywords.map(keyword => lower.indexOf(keyword)).filter(index => index >= 0);
          if (!positions.length) continue;
          total += 1;
          if (matches.length >= SEARCH_LIMIT) continue;
          const start = Math.max(0, Math.min(...positions) - SNIPPET_LENGTH / 2);
          const text = block.text.length <= SNIPPET_LENGTH ? block.text
            : `${start ? '…' : ''}${block.text.slice(start, start + SNIPPET_LENGTH)}${start + SNIPPET_LENGTH < block.text.length ? '…' : ''}`;
          matches.push({ section_id: section.id, number: section.number, title: section.title, block_id: block.id, text, ...(section.reference ? { reference: true } : {}) });
        }
      }
      return result({ total, truncated: total > matches.length, matches });
    },
  }, {
    // 程序核对失败的小节由主 Agent 决定重试时机，可先修正本节 HTML 再重新核对。
    name: 'recheck-sections', label: '重新核对小节', executionMode: 'sequential',
    description: '对台账“核对失败的小节”重新执行程序核对；失败原因指向本节 HTML 时可先修正再核对。只处理审计范围内尚无核对结果的小节，成功后问题和事实写入台账并更新台账文件。返回 total、success 和 unresolved（未执行或仍失败的小节及原因）；仍失败时读取原小节文件自行核对，并在 complete-consistency-round 的 manually_checked_section_ids 中列出。',
    parameters: Type.Object({
      section_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true, description: '从台账“核对失败的小节”原样复制的小节 ID。' }),
    }, { additionalProperties: false }),
    async execute(_callId, params, toolSignal) {
      requireAuditing();
      const { sections } = auditScope(workspaceDir);
      const byId = new Map(sections.map(section => [section.id, section]));
      const ledger = readLedger(workspaceDir);
      ledger.failures ||= {};
      const skipped = new Map();
      const pending = [];
      for (const id of params.section_ids) {
        if (!byId.has(id)) skipped.set(id, `未执行：小节 ID 不属于审计范围：${id}。请从台账“小节目录”原样复制小节 ID。`);
        else if (ledger.sections[id]) skipped.set(id, '未执行：该小节已有核对结果，无需重新核对。');
        else pending.push(byId.get(id));
      }
      try {
        if (pending.length) {
          await checkLedgerSections({ aiService, workspaceDir, ledger, pending, total: sections.length, signal: AbortSignal.any([signal, toolSignal].filter(Boolean)), onActivity });
        }
      } catch (error) {
        if (error?.code === AI_UPSTREAM_UNAVAILABLE) failTask(error);
        throw error;
      } finally {
        writeWorkspaceFile(workspaceDir, LEDGER_FILE, buildLedgerMarkdown(sections, ledger));
        protectLedger();
      }
      reportExtraction(onActivity, sections.length, [], { label: '小节事实核对完成', done: true });
      const results = params.section_ids.map(id => skipped.has(id) ? { section_id: id, status: 'error', error: skipped.get(id) }
        : ledger.sections[id] ? { section_id: id, status: 'success' } : { section_id: id, status: 'error', error: ledger.failures[id] || '核对未完成' });
      return result({ total: results.length, success: results.filter(item => item.status === 'success').length,
        unresolved: results.filter(item => item.status !== 'success') });
    },
  }, {
    // 任务来自固定任务文件，按顺序派发；同一次派发内各小节并发修复。
    name: 'repair-sections', label: '并发修复一致性问题', executionMode: 'sequential',
    description: `主 Agent 确定统一结论后，读取 ${taskFilePath('repair')} 中需要修改的目标小节，分配给子任务并发修复。格式为 {"rules":"可选，统一修复规则","sections":[{"section_id":"从台账“小节目录”原样复制的本轮目标小节 ID","instructions":"本节具体矛盾：段落 ID、矛盾内容及统一结论；只需按 rules 修改时填空字符串"}]}。rules 适用于本次派发的每个小节：同一取值需要在多个小节统一时写明统一后的取值及适用范围，子任务在各自小节按规则修改相关表述。${TASK_FILE_WRITING}文件内容即本次派发的任务，再次派发前按需改写。各子任务原生 edit 自己的小节，只改与矛盾直接相关的内容，保留图片，不检查或调整字数。返回 total、success 和 unresolved：ID 错误、参考小节、正在编辑或缺少要求的项未执行并说明原因，其他小节照常修复，未成功项返回主 Agent，在本轮提交时统一处理；程序清单/一致性修复结果.json 按小节累积本轮各次派发的最新状态及成功项的 changes（改动段落修改前后的纯文本）。`,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_callId, _params, toolSignal, onUpdate) {
      requireAuditing();
      const params = readTaskFile(workspaceDir, 'repair');
      // 注册工具时编排尚未完成，实际修复时才读取最终目标；参考小节只读。
      const { targets: targetList, references } = auditScope(workspaceDir);
      const targets = new Map(targetList.map(section => [section.id, section]));
      const referenceIds = new Set(references.map(section => section.id));
      const rules = params.rules?.trim() || '';
      activity.editing ||= new Set();
      // 模型输入边界：同节要求合并，ID 错误、参考小节、编辑中和缺少要求的项逐项返回，不拖累同批其他小节。
      const order = [];
      const requests = new Map();
      const skipped = new Map();
      for (const job of params.sections) {
        const id = job.section_id.trim();
        if (!order.includes(id)) order.push(id);
        if (referenceIds.has(id)) skipped.set(id, '未执行：该小节为已完成的参考小节，本轮只修改新增小节；请调整新增小节与其保持一致。');
        else if (!targets.has(id)) skipped.set(id, unknownSectionMessage(id, targets));
        else requests.set(id, [...(requests.get(id) || []), job.instructions.trim()].filter(Boolean));
      }
      const jobs = [];
      for (const [id, parts] of requests) {
        if (activity.editing.has(id)) skipped.set(id, '未执行：该小节正在其他批次中修复，请等待该批结束后再派发。');
        else if (!parts.length && !rules) skipped.set(id, '未执行：instructions 为空且本批未提供 rules，缺少修复要求。');
        else jobs.push({ section_id: id, instructions: parts.join('\n') || RULE_CHECK_INSTRUCTIONS });
      }
      const ids = jobs.map(job => job.section_id);
      const before = new Map(ids.map(id => [id, read(targets.get(id).file)]));
      // 先登记待完成项，取消或中断恢复后仍需处理；并发批次只增删本批小节，基于最新状态更新。
      const registered = consistency.get();
      consistency.save({ ...registered, failed_sections: [...new Set([...(registered.failed_sections || []), ...ids])] });
      const { results: edited, restored } = jobs.length ? await editContentSections({ jobs, targets, workspaceDir, agentService, signal, toolSignal, activity, inspectSection,
        onActivity: (event) => {
          // 保留原有业务进度和日志更新。
          onActivity?.(event);

          // 一致性修复子任务结束后，通过工具进度刷新主 Agent 计时。
          if (event.progress?.step !== 'consistency-repair') return;

          for (const item of event.progress.items) {
            if (!['success', 'error', 'cancelled'].includes(item.status)) {
              continue;
            }

            onUpdate?.(result({
              section_id: item.id,
              status: item.status,
            }));
          }
        },
        title: '一致性修复', preloadInput: true, instructions: `${REPAIR_INSTRUCTIONS}${rules ? `\n本批统一修复规则（适用于本批每个小节，按语义判断本节全文中的相关表述）：\n${rules}` : ''}`,
      }) : { results: [], restored: [] };
      const succeeded = new Set(edited.filter(item => item.status === 'success').map(item => item.section_id));
      const latest = consistency.get();
      // 已修复小节随持久状态保存，暂停、失败或重启后仍可知道本轮修复进度。
      consistency.save({ ...latest, failed_sections: (latest.failed_sections || []).filter(id => !succeeded.has(id)),
        repaired_section_ids: [...new Set([...(latest.repaired_section_ids || []), ...succeeded])] });
      const byId = new Map(edited.map(item => [item.section_id, item.status === 'success'
        ? { ...item, changes: blockChanges(before.get(item.section_id), read(targets.get(item.section_id).file)) } : item]));
      const results = order.map(id => byId.get(id) || { section_id: id, status: 'error', error: skipped.get(id) });
      // 改动对比随修复小节数增长，按小节累积写入程序清单；模型只接收本批统计和未成功项。
      const file = writeListFile(workspaceDir, 'repair', mergeRepairResults(readListFile(workspaceDir, 'repair'), results));
      return { content: [{ type: 'text', text: JSON.stringify(batchResponse(results, restored, { detail_file: file })) }], details: { results, restored } };
    },
  }, {
    name: 'complete-consistency-round', label: '提交一致性审计结论', executionMode: 'sequential',
    description: '本轮处理后提交真实审计结论，由程序统一校验；接受后结束审计并进入后续流程。',
    parameters: Type.Object({
      summary: Type.String(),
      remaining_issues: Type.Array(Type.String(), { description: '只记录确实无法在本轮修复的矛盾，注明小节、证据和原因；可以统一的矛盾须在提交前修复。为空表示本次目标内无已知未解决矛盾。' }),
      manually_checked_section_ids: Type.Optional(Type.Array(Type.String(), { description: '台账“核对失败的小节”中，重新核对仍未成功、已由你读取原文自行核对问题和事实的小节 ID；没有核对失败的小节时不填。' })),
    }),
    async execute(_callId, params) {
      const state = requireAuditing();
      if (activity.pending) throw new Error('请等待全部并发任务结束');
      // 只登记本轮结论；统一提交检查接受后再结束审计。
      consistency.save({ ...state, submission: params });
      return result({ submitted: true });
    },
  }];
}

module.exports = { CONSISTENCY_TOOLS, LEDGER_FILE, LEDGER_JSON, sectionAuditText, extractConsistencyLedger, buildConsistencyPrompt, collectConsistencySubmissionIssues, createContentGenerationConsistencyTools };
