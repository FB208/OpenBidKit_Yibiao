// 暗标 AI 复核的数据协议验证：复核结果与处理结果的提交校验、最终问题清单、修复范围、待处理清单和修复结果的逐条对账。
// 纯函数，不调用模型和助手：node --test scripts/check-blind-check-review.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildFixItems,
  buildIssueList,
  buildOpenItems,
  fixScope,
  issueSummary,
  newProblemGroups,
  parseDumpParagraphs,
  pendingSummary,
  validateDispositionOutput,
  validateReviewOutput,
} = require('../electron/services/blindCheckReview.cjs');

const dumpText = [
  '# 标书正文',
  '## 正文',
  '[p1] 〔标题1〕1、施工方案',
  '[p2] 本工程为某某泵站改造工程，由第一管网分公司负责验收。',
  '[p3] 监理单位为北京某某监理有限公司。',
  '[t1.r1.c1] 项目经理：张三',
  '## 图片和图形',
  '[img1] 位于 p4；嵌入图片 word/media/image1.png；名称「图片 1」；替代文字「某某项目工作计划」',
].join('\n');

const groups = [
  { id: 'g0', ruleId: 'privacy.keyword', ruleTitle: '敏感信息/身份泄露', category: 'privacy', severity: 'high', message: '出现企业名称「北京某某监理有限公司」', candidate: true, count: 3, samples: [{ hint: '替换为投标人' }], items: [{ locator: 'p3', where: '正文第 3 段', text: '北京某某监理有限公司' }, { locator: 'p2', where: '正文第 2 段', text: '第一管网分公司' }] },
  { id: 'g1', ruleId: 'table.size', ruleTitle: '表格字号', category: 'table', severity: 'medium', message: '表格内字号不是五号（10.5磅）', candidate: false, count: 4, samples: [{ hint: '改为五号' }], items: [] },
  { id: 'g2', ruleId: 'text.spaces', ruleTitle: '多余空格', category: 'text', severity: 'low', message: '存在多余空格', candidate: false, count: 2, samples: [{ hint: '删除空格' }], items: [] },
];

const goodReview = {
  summary: '写成了其他工程。',
  clauses: [
    { id: 'c1', requirement: '不得出现以往工程名称', basis: '不得出现以往工程名称', status: 'fail', explanation: '写成了其他工程', issues: ['a1'] },
    { id: 'c2', requirement: '表格字体五号', basis: '图表字体为宋体五号字', status: 'fail', explanation: '程序已报', issues: ['g1'] },
  ],
  candidates: [
    { id: 'g0', verdict: 'not_problem', reason: '招标人和监理单位' },
    { id: 'g0#0', verdict: 'uncertain', reason: '需确认是否为投标人' },
  ],
  issues: [
    { id: 'a1', title: '写成了其他工程', severity: 'high', category: 'privacy', basis: '以往工程名称', detail: '工程名称不符', suggestion: '改为本工程', locations: [{ target: 'p2', text: '某某泵站改造工程' }, { target: 'img1', text: '某某项目工作计划', image_part: 'alt' }] },
  ],
};

const reviewContext = {
  groups,
  paragraphs: parseDumpParagraphs(dumpText),
  imageIds: new Set(['img1']),
  hasTender: true,
  referenceText: '技术暗标中不得出现以往工程名称等信息。图表字体为宋体五号字。',
};

test('复核结果：引用的招标原文和标书摘录核对通过后收下，候选按整组和逐条结论覆盖', () => {
  const { value, issues } = validateReviewOutput(JSON.stringify(goodReview), reviewContext);
  assert.deepEqual(issues, []);
  assert.deepEqual(Object.keys(value.verdicts).sort(), ['g0', 'g0#0']);
  assert.deepEqual(parseDumpParagraphs(dumpText).get('t1.r1.c1'), '项目经理：张三');
});

test('段落解析：各区域的编号都能拆出来，图片清单不算段落', () => {
  const paragraphs = parseDumpParagraphs(['[p1] 正文', '[t1.r2.c3.2] 表格', '[hdr1.1] 页眉', '[ftr2.1] 页脚', '[fn.1] 脚注', '[en.2] 尾注', '[tb1] 文本框', '[img1] 位于 p1'].join('\n'));
  assert.deepEqual([...paragraphs.keys()], ['p1', 't1.r2.c3.2', 'hdr1.1', 'ftr2.1', 'fn.1', 'en.2', 'tb1']);
});

test('复核结果：引用不存在的编号、判为不符合却没列问题、漏判候选会阻塞；依据和摘录核对不上只算质量问题', () => {
  const bad = {
    ...goodReview,
    clauses: [
      { ...goodReview.clauses[0], basis: '招标文件里没有这句话', issues: [] },
      { ...goodReview.clauses[1], issues: ['g9'] },
    ],
    candidates: [{ id: 'g0#0', verdict: 'problem', reason: '是投标人' }, { id: 'g1', verdict: 'problem', reason: '不是候选' }],
    issues: [{ ...goodReview.issues[0], locations: [{ target: 'p3', text: '某某泵站改造工程' }, { target: 'p8', text: '不存在' }] }],
  };
  const { value, issues } = validateReviewOutput(JSON.stringify(bad), reviewContext);
  assert.equal(value, null);
  const messages = issues.map((issue) => issue.message).join('\n');
  const severityOf = (pattern) => issues.find((issue) => pattern.test(issue.message))?.severity;
  assert.equal(severityOf(/条款 c1 的 basis 在招标文件中找不到/), 'quality');
  assert.equal(severityOf(/条款 c1 判为不符合，issues 里要列出/), 'blocking');
  assert.equal(severityOf(/条款 c2 引用的问题编号不存在：g9/), 'blocking');
  assert.equal(severityOf(/p8 不是标书正文里的段落或图片编号/), 'quality');
  assert.equal(severityOf(/候选判定 g1 不是候选问题/), 'blocking');
  assert.doesNotMatch(messages, /p3/, '原文只在另一段出现时直接改正段落编号，不再退回');
  const noPart = validateReviewOutput(JSON.stringify({ ...goodReview, issues: [{ ...goodReview.issues[0], locations: [{ target: 'img1', text: '某某项目工作计划' }] }] }), reviewContext);
  assert.match(noPart.issues[0].message, /没写 image_part，已按图片画面处理/);
  assert.equal(noPart.issues[0].severity, 'quality');
  assert.equal(noPart.value.issues[0].locations[0].image_part, 'content');
  assert.match(messages, /g0（出现企业名称「北京某某监理有限公司」，2 处没有结论）/);
  const notJson = validateReviewOutput('{', reviewContext);
  assert.match(notJson.issues[0].message, /不是合法 JSON/);
});

const fixable = new Set(['table.size', 'text.spaces']);

/** 测试用的复核结论：在 goodReview 之外再加无法判断、关联问题都不在清单里的不符合、符合三种条款。 */
function reviewWithClauses() {
  const review = validateReviewOutput(JSON.stringify(goodReview), reviewContext).value;
  return {
    ...review,
    clauses: [
      ...review.clauses,
      { id: 'c3', requirement: '按要求加密上传', basis: '投标文件须加密上传', status: 'unknown', explanation: '标书本身看不出是否加密', issues: [] },
      { id: 'c4', requirement: '不得出现监理单位名称', basis: '不得出现监理单位名称', status: 'fail', explanation: '出现了监理单位', issues: ['g9'] },
      { id: 'c5', requirement: '纸张 A4', basis: '纸张 A4', status: 'pass', explanation: '符合', issues: [] },
    ],
  };
}

test('最终问题清单：判为不是问题的不计，需人工确认的标出，不符合的条款挂到关联问题，无法判断的条款进「其他」', () => {
  const issues = buildIssueList(groups, reviewWithClauses());
  const byId = Object.fromEntries(issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(issues.map((issue) => issue.id), ['g0', 'a1', 'g1', 'g2', 'c3', 'c4'], '按风险排序，符合的条款不出现');
  // g0：第 0 条需确认，第 1 条和超出条目的 1 处按整组"不是问题"，只剩 1 处。
  assert.deepEqual([byId.g0.count, byId.g0.uncertain, byId.g0.more], [1, true, 0]);
  assert.deepEqual(byId.g0.occurrences, [{ where: '正文第 3 段', text: '北京某某监理有限公司', notes: ['需人工确认：需确认是否为投标人'] }]);
  assert.deepEqual([byId.g1.count, byId.g1.hint, byId.g1.more], [4, '改为五号', 3], '整组修改方法相同时写到问题上，未列出的处数单独给出');
  assert.deepEqual(byId.g1.requirements.map((item) => item.text), ['图表字体为宋体五号字'], '不符合的条款挂到关联的程序问题上');
  assert.deepEqual(byId.a1.requirements.map((item) => item.text), ['以往工程名称', '不得出现以往工程名称']);
  assert.deepEqual([byId.a1.count, byId.a1.explanation, byId.a1.hint], [2, '工程名称不符', '改为本工程']);
  assert.deepEqual([byId.c3.category, byId.c3.severity, byId.c3.count, byId.c3.uncertain], ['other', 'low', 1, true]);
  assert.equal(byId.c4.category, 'other', '关联问题都不在清单里的不符合条款按无法判断处理');
  assert.deepEqual(issueSummary(issues), { high: 3, medium: 4, low: 4, total: 11 });

  const programOnly = buildIssueList(groups, null);
  assert.deepEqual(programOnly.map((issue) => [issue.id, issue.count]), [['g0', 3], ['g1', 4], ['g2', 2]], '没有复核时程序结果就是最终结果，候选也算问题');
});

test('修复范围：开着的修复项覆盖的问题；选了 AI 修复再加上没有修复项覆盖的问题；关掉的不进入', () => {
  const issues = buildIssueList(groups, reviewWithClauses());
  assert.deepEqual(fixScope(issues, { fixRules: ['table.size'], fixableRules: fixable, ai: false }).map((issue) => issue.id), ['g1']);
  assert.deepEqual(fixScope(issues, { fixRules: ['table.size'], fixableRules: fixable, ai: true }).map((issue) => issue.id), ['g0', 'a1', 'g1', 'c3', 'c4']);
});

test('待处理清单：没勾选的可修复规则不交给 AI，候选扣除不是问题的数量，AI 补充的问题全部列入', () => {
  const review = validateReviewOutput(JSON.stringify(goodReview), reviewContext).value;
  const afterGroups = [
    { ...groups[0], count: 3, items: [{ locator: 'p3', where: '正文第 3 段', text: '北京某某监理有限公司' }] },
    { ...groups[2], count: 2 },
  ];
  const open = buildOpenItems({ checkGroups: groups, review, afterGroups, fixRules: ['table.size'], fixableRules: fixable });
  assert.deepEqual(open.map((item) => item.id), ['g0', 'a1']);
  assert.equal(open[0].remaining, 1, '3 处里 2 处不是问题');
  assert.deepEqual(open[0].verdicts.map((item) => item.verdict), ['uncertain', 'not_problem']);
  assert.equal(open[1].source, 'ai');
});

test('处理结果：每个待处理问题恰好一条结论，留给人工的要写明原因和做法', () => {
  const openItems = [{ id: 'g0' }, { id: 'a1' }];
  const clauses = goodReview.clauses;
  const missing = validateDispositionOutput(JSON.stringify({ summary: '处理完成', items: [{ id: 'g0', action: 'manual', reason: '', suggestion: '' }, { id: 'g5', action: 'fixed', reason: '', suggestion: '' }], clauses: [{ id: 'c9', status: 'pass', explanation: '已改' }] }), { openItems, clauses });
  const messages = missing.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /g5 不在待处理问题里/);
  assert.match(messages, /g0 留给人工处理时 reason 和 suggestion 都要填写/);
  assert.match(messages, /还没有处理结论：a1/);
  assert.match(messages, /条款编号不存在：c9/);
  const ok = validateDispositionOutput(JSON.stringify({ summary: '处理完成', items: [{ id: 'g0', action: 'manual', reason: '需投标人确认', suggestion: '删除该名称' }, { id: 'a1', action: 'fixed', reason: '', suggestion: '' }], clauses: [] }), { openItems, clauses });
  assert.deepEqual(ok.issues, []);
});

test('逐条对账：只对修复范围，状态以复查为准；修复前 + 新出现 = 已修复 + 待人工', () => {
  const review = reviewWithClauses();
  const scope = fixScope(buildIssueList(groups, review), { fixRules: ['table.size'], fixableRules: fixable, ai: true });
  const newGroups = [{ ruleId: 'font.size', category: 'font', severity: 'medium', message: '字号不对', candidate: false, count: 2, samples: [{ where: '正文第 5 段', text: '某段', detail: '', hint: '改为小四' }] }];
  const items = buildFixItems({
    scope,
    checkGroups: groups,
    review,
    // g0 复查剩 2 处，正好是判为不是问题的 2 处；g1 已改完；g2 不在范围内，复查仍在也不出现。
    finalGroups: [{ ...groups[0], count: 2, samples: [{ where: '正文第 2 段', text: '第一管网分公司' }] }, { ...groups[2], count: 2 }],
    newGroups,
    dispositions: new Map([['g0', { action: 'fixed' }], ['a1', { action: 'fixed' }]]),
    edits: [{ issue: 'a1', op: 'replace', target: 'p2', before: '某某泵站改造工程', after: '本工程' }],
    refreshedClauses: [{ id: 'c3', status: 'pass', explanation: '已确认加密' }],
    unavailable: '',
    finalDumpText: dumpText.replace('某某泵站改造工程', '本工程'),
    reviewImages: [{ id: 'img1', name: '图片 1', description: '某某项目工作计划', title: '' }],
    finalImages: [{ id: 'img1', name: '图片 1', description: '', title: '' }],
  });
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.deepEqual(items.map((item) => item.id), ['g0', 'a1', 'g1', 'c3', 'c4', 'n0'], '不在范围内的 g2 不出现');
  assert.deepEqual([byId.g0.fixed, byId.g0.pending], [1, 0], '判为不是问题的位置复查仍在，不算待人工');
  assert.deepEqual([byId.g1.fixed, byId.g1.pending], [4, 0]);
  assert.deepEqual([byId.a1.fixed, byId.a1.pending, byId.a1.edits.length], [2, 0, 1], '正文工程名已改，图片摘录的替代文字清除后也算改掉');
  assert.deepEqual([byId.c3.fixed, byId.c4.pending, byId.c4.reason], [1, 1, '需要人工核对是否满足招标要求'], '条款看处理结果里是否刷新为符合');
  assert.deepEqual([byId.n0.isNew, byId.n0.pending, byId.n0.reason, byId.n0.suggestion], [true, 2, '修复后新出现，请人工核对', '改为小四']);
  const before = issueSummary(scope).total;
  const fixed = items.reduce((sum, item) => sum + item.fixed, 0);
  assert.deepEqual([before, fixed, pendingSummary(items).total], [9, 8, 3]);
  assert.equal(before + newGroups[0].count, fixed + pendingSummary(items).total);

  // AI 修复没能完成：程序问题的待人工位置排除判为不是问题的，原本交给 AI 的问题写明原因。
  const unfinished = buildFixItems({
    scope,
    checkGroups: groups,
    review,
    finalGroups: [{ ...groups[0], count: 3, samples: [{ where: '正文第 3 段', text: '北京某某监理有限公司' }, { where: '正文第 2 段', text: '第一管网分公司' }] }],
    newGroups: [],
    dispositions: new Map(),
    edits: [],
    refreshedClauses: [],
    unavailable: 'AI 复核会话已失效，请重新检查后再修复',
    finalDumpText: undefined,
  });
  const unfinishedById = Object.fromEntries(unfinished.map((item) => [item.id, item]));
  assert.deepEqual(unfinishedById.g0.pendingOccurrences.map((occurrence) => occurrence.text), ['北京某某监理有限公司']);
  assert.equal(unfinishedById.g0.reason, '无法确定是否违反要求，需要人工确认');
  assert.deepEqual([unfinishedById.a1.pending, unfinishedById.a1.reason], [2, '自动修复未完成：AI 复核会话已失效，请重新检查后再修复']);
});

test('修复后新出现的问题：复查比检查时多出来的组和数量', () => {
  const added = newProblemGroups(groups, [{ ...groups[1], count: 6 }, { ...groups[2], count: 1 }, { ruleId: 'font.size', severity: 'medium', message: '字号不对', candidate: false, count: 2 }]);
  assert.deepEqual(added.map((group) => [group.message, group.count]), [['表格内字号不是五号（10.5磅）', 2], ['字号不对', 2]]);
});

test('回归：页码段只有一个"2"、摘录混入〔〕标注时不再让整份复核失败，核对不上的位置标为未核实', () => {
  const footerDump = [
    '## 页眉页脚',
    '程序判断：页脚 ftr1：只有页码（PAGE 域，在文本框中，水平居中）',
    '[ftr1.1] ◇ 〔文本框：内容见 ftr1.2〕',
    '[ftr1.2] 〔文本框内〕2 〔域：PAGE〕',
    '[p1] 〔标题1〕1、施工方案',
    '[p2] 本工程为某某泵站改造工程，执行京政发〔2020〕12号文。',
  ].join('\n');
  const paragraphs = parseDumpParagraphs(footerDump);
  assert.equal(paragraphs.get('ftr1.2'), '2', '去掉标注后只剩标书原文');
  assert.equal(paragraphs.get('p2'), '本工程为某某泵站改造工程，执行京政发〔2020〕12号文。', '正文里本来就有的〔〕保留');
  const context = { ...reviewContext, groups: [], paragraphs, imageIds: new Set(), manualItems: ['每个评审模块的文件须独立生成连续的页码', '页码采用阿拉伯数字格式，宋体五号字'] };
  const review = (locations, clauses = []) => JSON.stringify({
    summary: '复核完成。',
    clauses,
    candidates: [],
    issues: [{ id: 'a1', title: '页脚问题', severity: 'medium', category: 'structure', basis: '不得出现以往工程名称', detail: '说明', suggestion: '建议', locations }],
  });

  const whole = validateReviewOutput(review([{ target: 'ftr1.2', text: '2' }, { target: 'p2', text: '京政发〔2020〕12号' }]), context);
  assert.ok(whole.value, '短段落整段引用、正文自带的〔〕都能核对');
  assert.ok(whole.value.issues[0].locations.every((location) => !location.unverified));

  const failed = validateReviewOutput(review([{ target: 'ftr1.2', text: '2 PAGE' }, { target: 'ftr1.1', text: 'PAGE' }, { target: 'ftr1.2', text: '某某泵站改造工程' }]), context);
  assert.ok(failed.value, '上次就是这一处引用让整份复核失败，现在照常收下');
  assert.ok(failed.issues.every((issue) => issue.severity === 'quality'));
  const [page, marker, moved] = failed.value.issues[0].locations;
  assert.equal(page.unverified, true);
  assert.equal(marker.unverified, true, '〔域：PAGE〕是标注，不能当原文引用');
  assert.deepEqual([moved.target, moved.unverified], ['p2', undefined], '编号写错但原文只在一段出现时直接改正');
  assert.ok(failed.issues.some((issue) => /每个评审模块的文件须独立生成连续的页码/.test(issue.message)), '人工核对条款没有对应结论时提醒补写');

  const covered = validateReviewOutput(review([], [
    { id: 'c1', requirement: '页码采用阿拉伯数字，宋体五号', basis: '不得出现以往工程名称', status: 'pass', explanation: '符合', issues: [] },
    { id: 'c2', requirement: '各评审模块文件独立生成连续页码', basis: '不得出现以往工程名称', status: 'fail', explanation: '没有拆分', issues: ['a1'] },
  ]), context);
  assert.deepEqual(covered.issues, [], '全文性质的问题可以不挂段落；条款要求与人工核对条款有 6 个字以上相同即算覆盖');

  const withWholeDocument = { ...failed.value, issues: [failed.value.issues[0], { ...failed.value.issues[0], id: 'a2', locations: [] }] };
  const items = buildFixItems({
    scope: fixScope(buildIssueList([], withWholeDocument), { fixRules: [], fixableRules: new Set(), ai: true }),
    checkGroups: [],
    review: withWholeDocument,
    finalGroups: [],
    newGroups: [],
    dispositions: new Map(),
    edits: [],
    refreshedClauses: [],
    unavailable: '',
    finalDumpText: '[p2] 本工程为本工程。',
    reviewImages: [],
    finalImages: [],
  });
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.deepEqual([byId.a1.fixed, byId.a1.pending], [1, 2], '未核实的摘录修复后"找不到"不算改掉');
  assert.deepEqual(byId.a1.pendingOccurrences[0].notes, ['位置未核实：摘录在该段找不到，请人工核对']);
  assert.deepEqual([byId.a2.count, byId.a2.pending], [1, 1], '全文性质的问题只能人工处理');
});
