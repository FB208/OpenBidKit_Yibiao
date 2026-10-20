// 暗标 AI 复核的数据协议：Agent 输出的 JSON 结构、提交校验、最终问题清单、修复范围、修复阶段的待处理清单，以及修复结果的逐条对账。
// 只有纯函数，不依赖 Electron，任务编排见 blindCheckAgent.cjs。
const Ajv = require('ajv');
const { normalizeForMatch, verifyEvidence } = require('./blindCheckPresetExtraction.cjs');

const REVIEW_OUTPUT_FILE = '复核结果.json';
const DISPOSITION_OUTPUT_FILE = '处理结果.json';
const CATEGORIES = ['privacy', 'structure', 'page', 'paragraph', 'font', 'text', 'table', 'consistency', 'image'];
const SEVERITIES = ['high', 'medium', 'low'];
const CLAUSE_STATUSES = ['pass', 'fail', 'unknown'];
const VERDICTS = ['problem', 'not_problem', 'uncertain'];
const MAX_PENDING_SAMPLES = 6;
const MAX_OPEN_LOCATIONS = 30;
const IMAGE_PART_LABELS = { alt: '（图片名称或替代文字）', content: '（图片画面）' };
// 人工核对条款与条款对照的覆盖判断：连续相同的最少字数。
const COVERAGE_WINDOW = 6;

const shortText = (maxLength) => ({ type: 'string', minLength: 1, maxLength });

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'clauses', 'candidates', 'issues'],
  properties: {
    summary: shortText(400),
    clauses: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'requirement', 'basis', 'status', 'explanation', 'issues'],
        properties: {
          id: { type: 'string', pattern: '^c[0-9]+$' },
          requirement: shortText(120),
          basis: shortText(300),
          status: { enum: CLAUSE_STATUSES },
          explanation: shortText(400),
          issues: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    candidates: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'string', pattern: '^g[0-9]+(#[0-9]+)?$' },
          verdict: { enum: VERDICTS },
          reason: shortText(300),
        },
      },
    },
    issues: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'severity', 'category', 'basis', 'detail', 'suggestion', 'locations'],
        properties: {
          id: { type: 'string', pattern: '^a[0-9]+$' },
          title: shortText(80),
          severity: { enum: SEVERITIES },
          category: { enum: CATEGORIES },
          basis: shortText(300),
          detail: shortText(400),
          suggestion: shortText(300),
          // 空数组表示全文性质的问题（如没有按模块拆分文件），不挂具体段落。
          locations: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['target', 'text'],
              properties: {
                target: { type: 'string', minLength: 1, maxLength: 40 },
                text: { type: 'string', maxLength: 300 },
                // 图片位置必填：alt 摘录的是图片名称或替代文字，content 是图片画面里的文字或标志。
                image_part: { enum: ['alt', 'content'] },
              },
            },
          },
        },
      },
    },
  },
};

const DISPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items', 'clauses'],
  properties: {
    summary: shortText(400),
    items: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action', 'reason', 'suggestion'],
        properties: {
          id: { type: 'string', pattern: '^(g|a)[0-9]+$' },
          action: { enum: ['fixed', 'manual'] },
          reason: { type: 'string', maxLength: 300 },
          suggestion: { type: 'string', maxLength: 300 },
        },
      },
    },
    clauses: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'explanation'],
        properties: {
          id: { type: 'string', pattern: '^c[0-9]+$' },
          status: { enum: CLAUSE_STATUSES },
          explanation: shortText(400),
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateReviewSchema = ajv.compile(REVIEW_SCHEMA);
const validateDispositionSchema = ajv.compile(DISPOSITION_SCHEMA);

function blocking(message, extra = {}) {
  return { severity: 'blocking', message, ...extra };
}

function parseJson(content, file) {
  const text = String(content || '').trim();
  if (!text) return { issues: [blocking(`${file} 未生成或内容为空，请写入完整 JSON`, { file })] };
  try {
    return { value: JSON.parse(text), issues: [] };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { issues: [blocking(`${file} 不是合法 JSON：${error.message}`, { file })] };
  }
}

function schemaIssues(validate, value, file) {
  if (validate(value)) return [];
  return validate.errors.slice(0, 20).map((item) => blocking(`${file} 结构无效：${item.instancePath || '/'} ${item.message}`, { file, path: item.instancePath || '/' }));
}

/** 问题组的对账键：与助手的归并键一致（规则 + 严重度 + 结论 + 是否候选），修复前后同一类问题按它对应。 */
function groupKey(group) {
  return `${group.ruleId}\u0001${group.severity}\u0001${group.message}\u0001${group.candidate ? 1 : 0}`;
}

function countByKey(groups) {
  const counts = new Map();
  for (const group of groups || []) counts.set(groupKey(group), (counts.get(groupKey(group)) || 0) + Number(group.count || 0));
  return counts;
}

// 标书结构导出加在行内的标注（区域、标题级别、域、图片、文本框、分页分节），不是标书原文，核对摘录前去掉。
// 只认这些固定写法，正文里本来就有的〔〕（如文号"〔2020〕12号"）保留。
const DUMP_ANNOTATION = /〔(?:封面|目录|标题\d+|段前分页|空段|文本框内|分页符|分节符|域：[^〕]*|文本框：[^〕]*|img\d+(?:、img\d+)*)〕/g;

/** 标书结构文本按段落编号拆成 Map：编号 -> 该段的标书原文（去掉标注，保留 ⏎ ⇥ ◇ 占位）。 */
function parseDumpParagraphs(dumpText) {
  const paragraphs = new Map();
  for (const line of String(dumpText || '').split(/\r?\n/)) {
    // 脚注、尾注的编号是 fn.1 / en.1，字母后面先有一个点。
    const match = line.match(/^\[([a-z]+\.?[0-9][0-9a-z.]*)\] (.*)$/);
    if (match && !match[1].startsWith('img')) paragraphs.set(match[1], match[2].replace(DUMP_ANNOTATION, '').trim());
  }
  return paragraphs;
}

function imageIdsOf(images) {
  return new Set((images || []).map((image) => image.id));
}

function quality(message, extra = {}) {
  return { severity: 'quality', message, ...extra };
}

/** 候选判定覆盖情况：每个候选组要么有整组结论，要么每条定位都有结论；超出条目上限的部分只能按整组结论。 */
function candidateCoverage(groups, verdicts) {
  const missing = [];
  for (const group of groups) {
    if (!group.candidate) continue;
    if (verdicts.has(group.id)) continue;
    const uncovered = group.items.filter((_item, index) => !verdicts.has(`${group.id}#${index}`)).length + Math.max(0, group.count - group.items.length);
    if (uncovered > 0) missing.push(`${group.id}（${group.message}，${uncovered} 处没有结论）`);
  }
  return missing;
}

/**
 * 核对一处标书摘录：只和段落的标书原文比对（不含标注）。很短的段落（如页脚只有页码"2"）允许整段引用；
 * 段落编号写错、但原文只在另一段出现时直接改正编号。返回核对不上的原因，核对通过返回空。
 */
function checkLocation(location, paragraphs, imageIds) {
  if (imageIds.has(location.target)) {
    if (location.image_part) return '';
    location.image_part = 'content';
    return `图片位置 ${location.target} 没写 image_part，已按图片画面处理；摘录的是名称或替代文字时写 alt`;
  }
  const paragraph = paragraphs.get(location.target);
  if (paragraph === undefined) return `${location.target} 不是标书正文里的段落或图片编号`;
  const wanted = normalizeForMatch(location.text);
  const own = normalizeForMatch(paragraph);
  if (!wanted) return `在 ${location.target} 没有摘录标书原文`;
  if (wanted.length < 2 && wanted !== own) return `在 ${location.target} 的摘录太短，至少 2 个字，或整段引用`;
  if (own.includes(wanted)) return '';
  const elsewhere = [...paragraphs.entries()].filter(([, value]) => normalizeForMatch(value).includes(wanted)).map(([target]) => target);
  if (elsewhere.length === 1) {
    location.target = elsewhere[0];
    return '';
  }
  return elsewhere.length
    ? `摘录的「${location.text.slice(0, 30)}」不在 ${location.target}，在 ${elsewhere.slice(0, 3).join('、')} 等 ${elsewhere.length} 段都有，请写明是哪一段`
    : `摘录的「${location.text.slice(0, 30)}」在 ${location.target} 中找不到（〔〕里的是标注，不是原文），请逐字摘录标书原文`;
}

/**
 * 预设里需人工核对的条款，在条款对照中是否有对应结论：条款的依据或要求与它有连续 6 个字以上相同即算覆盖，
 * 同一句招标原文被拆成几条、要求被概括改写时也能对上。
 */
function uncoveredManualItems(manualItems, clauses) {
  const covered = clauses.map((clause) => normalizeForMatch(`${clause.basis}${clause.requirement}`));
  return (manualItems || []).filter((item) => {
    const whole = normalizeForMatch(item);
    if (whole.length < COVERAGE_WINDOW) return false;
    for (let start = 0; start + COVERAGE_WINDOW <= whole.length; start += 1) {
      const piece = whole.slice(start, start + COVERAGE_WINDOW);
      if (covered.some((text) => text.includes(piece))) return false;
    }
    return true;
  });
}

/**
 * 检查阶段复核结果的提交校验。结构错误、引用不存在的问题编号、候选没有结论会阻塞，要求 Agent 修正；
 * 依据在招标原文（或预设出处）里找不到、标书摘录核对不上、人工核对条款没有对应结论只算质量问题：
 * 退回修正一两轮仍不改时照常接受，核对不上的依据和位置标为未核实，不让一处引用拖垮整份复核。
 */
function validateReviewOutput(content, context) {
  const parsed = parseJson(content, REVIEW_OUTPUT_FILE);
  if (!parsed.value) return { value: null, issues: parsed.issues };
  const review = parsed.value;
  const issues = schemaIssues(validateReviewSchema, review, REVIEW_OUTPUT_FILE);
  if (issues.length) return { value: null, issues };

  const groups = context.groups || [];
  const groupIds = new Set(groups.map((group) => group.id));
  const paragraphs = context.paragraphs || new Map();
  const imageIds = context.imageIds || new Set();
  const referenceText = normalizeForMatch(context.referenceText || '');
  const referenceLabel = context.hasTender ? '招标文件' : '格式预设的条款依据';
  const verifyBasis = (basis) => !referenceText || verifyEvidence(basis, referenceText);

  const seen = new Set();
  const duplicate = (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  };

  const issueIds = new Set();
  for (const item of review.issues) {
    if (duplicate(item.id)) issues.push(blocking(`问题编号 ${item.id} 重复`));
    issueIds.add(item.id);
    if (!verifyBasis(item.basis)) {
      item.basisUnverified = true;
      issues.push(quality(`问题 ${item.id} 的 basis 在${referenceLabel}中找不到，请逐字摘录原文：${item.basis.slice(0, 40)}`));
    }
    for (const location of item.locations) {
      const problem = checkLocation(location, paragraphs, imageIds);
      if (!problem) continue;
      if (!problem.startsWith('图片位置')) location.unverified = true;
      issues.push(quality(`问题 ${item.id}：${problem}`));
    }
  }

  for (const clause of review.clauses) {
    if (duplicate(clause.id)) issues.push(blocking(`条款编号 ${clause.id} 重复`));
    if (!verifyBasis(clause.basis)) {
      clause.basisUnverified = true;
      issues.push(quality(`条款 ${clause.id} 的 basis 在${referenceLabel}中找不到，请逐字摘录原文：${clause.basis.slice(0, 40)}`));
    }
    const unknown = clause.issues.filter((id) => !groupIds.has(id) && !issueIds.has(id));
    if (unknown.length) issues.push(blocking(`条款 ${clause.id} 引用的问题编号不存在：${unknown.join('、')}（程序问题用 g 编号，补充问题用 a 编号）`));
    if (clause.status === 'fail' && clause.issues.length === 0) issues.push(blocking(`条款 ${clause.id} 判为不符合，issues 里要列出对应的程序问题或补充问题编号`));
  }

  for (const item of uncoveredManualItems(context.manualItems, review.clauses)) {
    issues.push(quality(`格式要求里需人工核对的条款「${String(item).slice(0, 60)}」在条款对照里没有对应结论，请补一条（basis 逐字摘录招标原文）`));
  }

  const verdicts = new Map();
  for (const item of review.candidates) {
    const [groupId, index] = item.id.split('#');
    const group = groups.find((entry) => entry.id === groupId);
    if (!group || !group.candidate) {
      issues.push(blocking(`候选判定 ${item.id} 不是候选问题，只能对程序检查结果里 candidate 为 true 的问题下结论`));
      continue;
    }
    if (index !== undefined && Number(index) >= group.items.length) {
      issues.push(blocking(`候选判定 ${item.id} 超出 ${groupId} 的定位条目范围（共 ${group.items.length} 条）`));
      continue;
    }
    if (verdicts.has(item.id)) issues.push(blocking(`候选判定 ${item.id} 重复`));
    verdicts.set(item.id, { verdict: item.verdict, reason: item.reason });
  }
  const missing = candidateCoverage(groups, verdicts);
  if (missing.length) issues.push(blocking(`以下候选问题还没有结论，请逐条或整组判定：${missing.slice(0, 10).join('；')}`));

  if (issues.some((issue) => issue.severity === 'blocking')) return { value: null, issues };
  return {
    value: {
      summary: review.summary,
      clauses: review.clauses,
      verdicts: Object.fromEntries(verdicts),
      issues: review.issues,
    },
    issues,
  };
}

/** 候选组按复核结论分成三类数量；没有复核结论时全部按问题计。 */
function candidateCounts(group, verdicts) {
  const counts = { problem: 0, not_problem: 0, uncertain: 0 };
  if (!group.candidate || !verdicts) {
    counts.problem = Number(group.count || 0);
    return counts;
  }
  const groupVerdict = verdicts[group.id]?.verdict || 'problem';
  const items = group.items || [];
  items.forEach((_item, index) => {
    counts[verdicts[`${group.id}#${index}`]?.verdict || groupVerdict] += 1;
  });
  counts[groupVerdict] += Math.max(0, Number(group.count || 0) - items.length);
  return counts;
}

/** 候选组第 index 条的结论：逐条结论优先，否则用整组结论，都没有时按问题计。 */
function itemVerdict(group, index, verdicts) {
  return verdicts?.[`${group.id}#${index}`] || verdicts?.[group.id] || { verdict: 'problem', reason: '' };
}

/** 组内样本的修改方法相同时作为整组的修改方法；不同时返回空，由各处分别写。 */
function sharedHint(samples) {
  const hints = new Set((samples || []).map((sample) => sample.hint).filter(Boolean));
  return hints.size === 1 ? [...hints][0] : '';
}

function aiLocationOccurrence(location) {
  return {
    where: `${location.target}${IMAGE_PART_LABELS[location.image_part] || ''}`,
    text: location.text,
    notes: location.unverified ? ['位置未核实：摘录在该段找不到，请人工核对'] : [],
  };
}

/**
 * 最终问题清单：检查结论以复核后的结果为准，是检查页显示、修复范围和修复对账的唯一口径，计数单位都是"处"。
 * review 只在复核成功且与检查结果签名一致时传入；不传时程序结果就是最终结果，候选也算问题。
 * 候选里判为"不是问题"的位置不计；需人工确认的计入并标出。AI 补充的问题按位置数计。
 * 不符合的招标条款挂到关联的问题上作为招标要求；无法判断的条款，以及关联问题都被判掉的不符合条款，
 * 作为"其他"里的一条需人工确认的问题；符合的条款不显示。
 */
function buildIssueList(groups, review) {
  const verdicts = review?.verdicts;
  const issues = [];
  for (const group of groups || []) {
    const counts = candidateCounts(group, verdicts);
    const count = counts.problem + counts.uncertain;
    if (!count) continue;
    const samples = group.samples || [];
    const hint = sharedHint(samples);
    const occurrences = group.candidate && verdicts
      ? (group.items || []).flatMap((item, index) => {
        const verdict = itemVerdict(group, index, verdicts);
        if (verdict.verdict === 'not_problem') return [];
        const note = verdict.verdict === 'uncertain' ? `需人工确认：${verdict.reason}` : verdict.reason;
        return [{ where: item.where, text: item.text, notes: note ? [note] : [] }];
      })
      : samples.map((sample) => ({
        where: sample.where,
        text: sample.text,
        notes: [sample.detail, sample.origin ? `格式来自：${sample.origin}` : '', !hint && sample.hint ? `修改方法：${sample.hint}` : ''].filter(Boolean),
      }));
    issues.push({
      id: group.id,
      kind: 'rule',
      ruleId: group.ruleId,
      category: group.category,
      severity: group.severity,
      message: group.message,
      count,
      uncertain: counts.uncertain > 0,
      requirements: [],
      explanation: '',
      hint,
      occurrences,
      more: Math.max(0, count - occurrences.length),
    });
  }
  for (const issue of review?.issues || []) {
    issues.push({
      id: issue.id,
      kind: 'ai',
      ruleId: '',
      category: issue.category,
      severity: issue.severity,
      message: issue.title,
      count: Math.max(1, issue.locations.length),
      uncertain: false,
      requirements: [{ text: issue.basis, unverified: Boolean(issue.basisUnverified) }],
      explanation: issue.detail,
      hint: issue.suggestion,
      occurrences: issue.locations.length
        ? issue.locations.map(aiLocationOccurrence)
        : [{ where: '全文', text: '', notes: ['全文性质的问题，不对应具体段落'] }],
      more: 0,
    });
  }
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  for (const clause of review?.clauses || []) {
    if (clause.status === 'pass') continue;
    const requirement = { text: clause.basis, unverified: Boolean(clause.basisUnverified) };
    const linked = (clause.issues || []).map((id) => byId.get(id)).filter(Boolean);
    for (const issue of linked) {
      if (!issue.requirements.some((item) => item.text === requirement.text)) issue.requirements.push(requirement);
    }
    if (clause.status === 'fail' && linked.length) continue;
    issues.push({
      id: clause.id,
      kind: 'clause',
      ruleId: '',
      category: 'other',
      severity: 'low',
      message: clause.requirement,
      count: 1,
      uncertain: true,
      requirements: [requirement],
      explanation: clause.explanation,
      hint: '',
      occurrences: [],
      more: 0,
    });
  }
  return issues.sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity));
}

/** 与检查结果对应的复核结论：复核成功且签名一致时才用，否则按没有复核处理（程序结果就是最终结果）。 */
function reviewForResult(result, reviewState) {
  return reviewState?.status === 'success' && reviewState.inputSignature && reviewState.inputSignature === result?.inputSignature
    ? reviewState.review || null
    : null;
}

/** 按处数汇总高、中、低风险：检查页卡片和修复前后对比共用。 */
function issueSummary(issues) {
  const summary = { high: 0, medium: 0, low: 0, total: 0 };
  for (const issue of issues || []) {
    summary[issue.severity] += issue.count;
    summary.total += issue.count;
  }
  return summary;
}

/** 本次修复的范围：开着的修复项覆盖的问题；选了 AI 修复时再加上没有修复项覆盖的问题。关掉的修复项覆盖的问题不进入。 */
function fixScope(issues, { fixRules, fixableRules, ai }) {
  const selected = new Set(fixRules || []);
  return (issues || []).filter((issue) => (fixableRules.has(issue.ruleId) ? selected.has(issue.ruleId) : ai === true));
}

/**
 * 修复阶段交给 Agent 的待处理问题：程序修复后仍存在的问题（扣除判为"不是问题"的候选，
 * 以及用户没勾选、程序本可修复的项）和 AI 补充的问题。定位按修复副本的段落编号给出。
 */
function buildOpenItems({ checkGroups, review, afterGroups, fixRules, fixableRules }) {
  const selected = new Set(fixRules || []);
  const afterByKey = new Map((afterGroups || []).map((group) => [groupKey(group), group]));
  const open = [];
  for (const group of checkGroups || []) {
    if (fixableRules.has(group.ruleId) && !selected.has(group.ruleId)) continue;
    const after = afterByKey.get(groupKey(group));
    const counts = candidateCounts(group, review?.verdicts);
    const remaining = Math.max(0, Number(after?.count || 0) - counts.not_problem);
    if (!remaining) continue;
    open.push({
      id: group.id,
      source: 'program',
      title: group.message,
      rule: group.ruleTitle,
      severity: group.severity,
      remaining,
      hint: (after?.samples || group.samples || []).map((sample) => sample.hint).find(Boolean) || '',
      locations: (after?.items || []).slice(0, MAX_OPEN_LOCATIONS).map((item) => ({ target: item.locator, where: item.where, text: item.text })),
      ...(group.candidate && review ? {
        verdicts: (group.items || []).map((item, index) => ({
          text: item.text,
          verdict: review.verdicts[`${group.id}#${index}`]?.verdict || review.verdicts[group.id]?.verdict || 'problem',
        })),
      } : {}),
    });
  }
  for (const issue of review?.issues || []) {
    open.push({
      id: issue.id,
      source: 'ai',
      title: issue.title,
      severity: issue.severity,
      detail: issue.detail,
      suggestion: issue.suggestion,
      locations: issue.locations,
    });
  }
  return open;
}

/** 修复阶段处理结果的提交校验：每个待处理问题恰好一条结论，人工处理要写明原因和做法，条款编号要存在。 */
function validateDispositionOutput(content, { openItems, clauses }) {
  const parsed = parseJson(content, DISPOSITION_OUTPUT_FILE);
  if (!parsed.value) return { value: null, issues: parsed.issues };
  const disposition = parsed.value;
  const issues = schemaIssues(validateDispositionSchema, disposition, DISPOSITION_OUTPUT_FILE);
  if (issues.length) return { value: null, issues };

  const openIds = new Set(openItems.map((item) => item.id));
  const seen = new Set();
  for (const item of disposition.items) {
    if (!openIds.has(item.id)) issues.push(blocking(`${item.id} 不在待处理问题里，只能对待处理问题.json 中的编号下结论`));
    if (seen.has(item.id)) issues.push(blocking(`${item.id} 重复`));
    seen.add(item.id);
    if (item.action === 'manual' && (!item.reason.trim() || !item.suggestion.trim())) {
      issues.push(blocking(`${item.id} 留给人工处理时 reason 和 suggestion 都要填写：为什么不能自动修改、人工应该怎么改`));
    }
  }
  const missing = [...openIds].filter((id) => !seen.has(id));
  if (missing.length) issues.push(blocking(`以下待处理问题还没有处理结论：${missing.join('、')}`));
  const clauseIds = new Set((clauses || []).map((clause) => clause.id));
  const unknown = disposition.clauses.filter((clause) => !clauseIds.has(clause.id)).map((clause) => clause.id);
  if (unknown.length) issues.push(blocking(`条款编号不存在：${unknown.join('、')}`));
  if (issues.length) return { value: null, issues };
  return { value: disposition, issues: [] };
}

/** 修复后新出现或增多的问题：复查结果里比基准多出来的组和数量。 */
function newProblemGroups(baselineGroups, finalGroups) {
  const baseline = countByKey(baselineGroups);
  const added = [];
  for (const group of finalGroups || []) {
    const extra = Number(group.count || 0) - (baseline.get(groupKey(group)) || 0);
    if (extra > 0) added.push({ ...group, count: extra });
  }
  return added;
}

function imageText(image) {
  return normalizeForMatch(`${image?.name || ''}${image?.description || ''}${image?.title || ''}`);
}

/**
 * AI 问题的位置是否已消除：摘录的标书原文在最终文档里找不到即视为已修改。
 * 图片位置只有摘录的是名称或替代文字（image_part 为 alt）时才能核对，清除后即消除；
 * 图片画面里的文字或标志，文字级修改改不了，始终算待处理。
 */
function locationResolved(location, finalText, reviewImages, finalImages) {
  const wanted = normalizeForMatch(location.text);
  // 检查时就核对不上的摘录，修复后"找不到"不能说明改掉了。
  if (!wanted || location.unverified) return false;
  if (/^img[0-9]+$/.test(location.target)) {
    if (location.image_part !== 'alt') return false;
    const before = (reviewImages || []).find((item) => item.id === location.target);
    if (!before || !imageText(before).includes(wanted)) return false;
    return !(finalImages || []).some((item) => imageText(item).includes(wanted));
  }
  return !finalText.includes(wanted);
}

/**
 * 修复结果逐条对账：只对本次修复范围内的问题，加上修复后新出现的问题。每条给出已修复、待人工处理的处数，
 * 不区分程序还是 AI 修的；数量关系是"修复前 + 新出现 = 已修复 + 待人工"。处理状态以复查为准，不采信 Agent 的说法：
 * 程序问题按对账键比较检查时与最终复查的数量（扣除判为"不是问题"的位置），AI 补充的问题按摘录原文是否已从文档中消失判断，
 * 条款问题看处理结果里是否刷新为符合。unavailable 是 AI 修复没能完成的原因（失败或会话失效），写进待人工的原因。
 */
function buildFixItems({ scope, checkGroups, review, finalGroups, newGroups, dispositions, edits, refreshedClauses, unavailable, finalDumpText, reviewImages, finalImages }) {
  const groupsById = new Map((checkGroups || []).map((group) => [group.id, group]));
  const aiIssuesById = new Map((review?.issues || []).map((issue) => [issue.id, issue]));
  const finalByKey = new Map((finalGroups || []).map((group) => [groupKey(group), group]));
  const clauseStatus = new Map((refreshedClauses || []).map((clause) => [clause.id, clause.status]));
  const finalText = normalizeForMatch(finalDumpText || '');
  const editsByIssue = new Map();
  for (const edit of edits || []) {
    if (!edit.issue) continue;
    editsByIssue.set(edit.issue, [...(editsByIssue.get(edit.issue) || []), edit]);
  }
  const sampleOccurrence = (sample) => ({ where: sample.where, text: sample.text, notes: sample.detail ? [sample.detail] : [] });

  const pendingReason = (issue, pending) => {
    const disposition = dispositions?.get(issue.id);
    if (issue.uncertain && !disposition) return { reason: '无法确定是否违反要求，需要人工确认', suggestion: issue.hint };
    if (disposition?.action === 'manual') return { reason: disposition.reason, suggestion: disposition.suggestion || issue.hint };
    if (disposition?.action === 'fixed') return { reason: `已尝试修改，复查仍有 ${pending} 处`, suggestion: issue.hint };
    if (unavailable) return { reason: `自动修复未完成：${unavailable}`, suggestion: issue.hint };
    return { reason: '自动修复无法处理', suggestion: issue.hint };
  };

  const items = (scope || []).map((issue) => {
    let pending = issue.count;
    let pendingOccurrences = issue.occurrences;
    if (issue.kind === 'rule') {
      const group = groupsById.get(issue.id);
      const counts = candidateCounts(group, review?.verdicts);
      const finalGroup = finalByKey.get(groupKey(group));
      pending = Math.min(Math.max(0, Number(finalGroup?.count || 0) - counts.not_problem), issue.count);
      // 复查不知道复核结论，判为"不是问题"的位置按原文摘录排除，不列为待人工。
      const dismissed = new Set((group.candidate && review ? group.items || [] : [])
        .filter((_item, index) => itemVerdict(group, index, review.verdicts).verdict === 'not_problem')
        .map((item) => normalizeForMatch(item.text)));
      pendingOccurrences = (finalGroup?.samples || []).filter((sample) => !dismissed.has(normalizeForMatch(sample.text))).map(sampleOccurrence);
    } else if (issue.kind === 'ai') {
      const locations = aiIssuesById.get(issue.id)?.locations || [];
      const unresolved = finalDumpText ? locations.filter((location) => !locationResolved(location, finalText, reviewImages, finalImages)) : locations;
      pending = locations.length ? unresolved.length : issue.count;
      pendingOccurrences = locations.length ? unresolved.map(aiLocationOccurrence) : issue.occurrences;
    } else {
      pending = clauseStatus.get(issue.id) === 'pass' ? 0 : 1;
    }
    const reason = pending
      ? issue.kind === 'clause' ? { reason: '需要人工核对是否满足招标要求', suggestion: issue.explanation } : pendingReason(issue, pending)
      : { reason: '', suggestion: '' };
    return {
      id: issue.id,
      category: issue.category,
      severity: issue.severity,
      message: issue.message,
      count: issue.count,
      fixed: issue.count - pending,
      pending,
      isNew: false,
      reason: reason.reason,
      suggestion: reason.suggestion,
      pendingOccurrences: pending ? pendingOccurrences.slice(0, MAX_PENDING_SAMPLES) : [],
      edits: editsByIssue.get(issue.id) || [],
    };
  });

  (newGroups || []).forEach((group, index) => {
    items.push({
      id: `n${index}`,
      category: group.category,
      severity: group.severity,
      message: group.message,
      count: Number(group.count || 0),
      fixed: 0,
      pending: Number(group.count || 0),
      isNew: true,
      reason: '修复后新出现，请人工核对',
      suggestion: sharedHint(group.samples),
      pendingOccurrences: (group.samples || []).slice(0, MAX_PENDING_SAMPLES).map(sampleOccurrence),
      edits: [],
    });
  });
  return items;
}

/** 修复后的风险汇总：按逐条对账的待人工处理处数计（含修复后新出现的）。 */
function pendingSummary(items) {
  const summary = { high: 0, medium: 0, low: 0, total: 0 };
  for (const item of items || []) {
    summary[item.severity] += item.pending;
    summary.total += item.pending;
  }
  return summary;
}

module.exports = {
  CATEGORIES,
  DISPOSITION_OUTPUT_FILE,
  DISPOSITION_SCHEMA,
  REVIEW_OUTPUT_FILE,
  REVIEW_SCHEMA,
  buildFixItems,
  buildIssueList,
  buildOpenItems,
  candidateCounts,
  fixScope,
  groupKey,
  imageIdsOf,
  issueSummary,
  newProblemGroups,
  parseDumpParagraphs,
  pendingSummary,
  reviewForResult,
  validateDispositionOutput,
  validateReviewOutput,
};
