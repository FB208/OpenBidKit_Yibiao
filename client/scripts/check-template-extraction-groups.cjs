// 投标模版分组提取的程序步骤：分类按字段写的展开、按章节分组、模版正文和候选切分、各组分类合并、统稿字段清单与按统稿清单修改分类。
// 用法（client 目录）：node --test scripts/check-template-extraction-groups.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { expandClassification } = require('../electron/services/pi/piOpenXmlTool.cjs');
const {
  splitTemplateGroups,
  splitTemplateText,
  sliceTemplateText,
  sliceCandidates,
  mergeGroupClassifications,
  buildFieldList,
  applyNamingPlan,
  chaptersFromItems,
  hasAllSources,
} = require('../electron/services/templateExtractionTask.cjs');

const ITEMS = [
  { id: 'a', title: '投标书', source: { start: 0, end: 5 } },
  { id: 'b', title: '授权书', source: { start: 5, end: 9, source: '招标文件.docx' } },
  { id: 'c', title: '承诺书', source: { start: 9, end: 12 } },
  { id: 'd', title: '附件', source: { start: 12, end: 15 } },
];

function candidatesFor(counts) {
  return Object.entries(counts).flatMap(([chapter, count]) => Array.from({ length: count }, (_, index) => ({
    candidate_id: `c_${chapter}${index}`,
    kind: 'text-placeholder',
    chapter_id: chapter,
    context: `${chapter} 第 ${index} 处【▢】`,
    context_id: `ctx_${chapter}`,
  })));
}

test('分类按字段写：展开为逐候选结构，同名同属性的多项合并，属性不同时报错', () => {
  const expanded = expandClassification({
    fields: [
      { name: '投标人名称', subject: '投标人', fill_by: 'ai', candidate_ids: ['c1', 'p1'] },
      { name: '投标人名称', subject: '投标人', fill_by: 'ai', candidate_ids: ['c2'] },
      { name: '法定代表人身份证', subject: '法定代表人', fill_by: 'ai', candidate_ids: ['c3'], parts: [{ name: '人像面' }, { name: '国徽面' }] },
    ],
    ignored_candidate_ids: ['c4'],
    positions: [{ id: 'p1', at: 'b1', op: 'span', text: '␣项目' }],
  });
  assert.deepEqual(expanded.fields.map((item) => [item.candidate_id, item.name]), [
    ['c1', '投标人名称'], ['p1', '投标人名称'], ['c2', '投标人名称'], ['c3', '法定代表人身份证'],
  ]);
  assert.deepEqual(expanded.fields[3].parts, [{ name: '人像面' }, { name: '国徽面' }]);
  assert.deepEqual(expanded.ignored_candidate_ids, ['c4']);
  assert.equal(expanded.positions[0].text, '␣项目');
  assert.throws(() => expandClassification({
    fields: [
      { name: '项目名称', subject: '本项目', fill_by: 'ai', candidate_ids: ['c1'] },
      { name: '项目名称', subject: '本项目', fill_by: 'manual', candidate_ids: ['c2'] },
    ],
    ignored_candidate_ids: [],
  }), /字段名重复且主体、填写方式、说明或附件拆分不同：项目名称/);
});

test('分组：候选少时只分一组；按目录顺序装相邻章节，一章不拆，组数不超过并发上限和章节数', () => {
  assert.equal(splitTemplateGroups(ITEMS, candidatesFor({ a: 5, b: 5, c: 5, d: 5 }), 10).length, 1);
  const groups = splitTemplateGroups(ITEMS, candidatesFor({ a: 40, b: 30, c: 5, d: 30 }), 10);
  // 负载 41/31/6/31（每章另加 1），按 4 组均分约 27；c 加入 b 组会超出更多，放到下一组与 d 同组。
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [['a'], ['b'], ['c', 'd']]);
  assert.equal(splitTemplateGroups(ITEMS, candidatesFor({ a: 40, b: 30, c: 5, d: 30 }), 2).length, 2);
  assert.deepEqual(splitTemplateGroups(ITEMS, candidatesFor({ a: 400 }), 10).map((group) => group.map((item) => item.id)), [['a'], ['b', 'c', 'd']], '一章不拆');
  assert.equal(splitTemplateGroups(ITEMS, candidatesFor({ a: 100, b: 100, c: 100, d: 100 }), 10).length, 4, '组数不超过章节数');
  assert.equal(splitTemplateGroups(ITEMS, candidatesFor({ a: 400 }), 0).length, 1, '并发上限无效时只分一组');
  assert.deepEqual(splitTemplateGroups(ITEMS, candidatesFor({ a: 40, b: 30, c: 5, d: 30 }), 10).flat().map((item) => item.id), ['a', 'b', 'c', 'd']);
});

test('切分：模版正文按章节标题行切分并保留开头说明；候选和上下文按章节切分', () => {
  const text = [
    '投标模版正文：说明',
    '第二行说明',
    '',
    '【章节 a：投标书】默认标题段：b0 投标书',
    'b0  投标书',
    'b1  项目名称：〔c_a0：␣␣〕项目',
    '',
    '【章节 b：授权书】默认标题段：无',
    'b5  被授权人：〔c_b0：____〕',
    '',
  ].join('\n');
  const parts = splitTemplateText(text);
  assert.equal(parts.locatorChapters.get('b1'), 'a');
  assert.equal(parts.locatorChapters.get('b5'), 'b');
  const sliced = sliceTemplateText(parts, ['b']);
  assert.ok(sliced.startsWith('投标模版正文：说明\n第二行说明'));
  assert.ok(sliced.includes('【章节 b：授权书】') && !sliced.includes('【章节 a'));
  const candidateData = { version: 1, contexts: [{ context_id: 'ctx_a' }, { context_id: 'ctx_b' }], candidates: candidatesFor({ a: 2, b: 1 }) };
  const slice = sliceCandidates(candidateData, ['b']);
  assert.deepEqual(slice.candidates.map((item) => item.candidate_id), ['c_b0']);
  assert.deepEqual(slice.contexts, [{ context_id: 'ctx_b' }]);
});

test('合并：补充位置 id 加组前缀并同步引用；同名同属性合并，属性不同改名并列为冲突；统稿字段清单', () => {
  const { classification, conflicts } = mergeGroupClassifications([
    {
      index: 1,
      classification: {
        fields: [
          { name: '投标人名称', subject: '投标人', fill_by: 'ai', candidate_ids: ['c_a0', 'p1'] },
          { name: '投标日期', subject: '投标文件', fill_by: 'ai', candidate_ids: ['p2'] },
        ],
        ignored_candidate_ids: ['c_a1'],
        positions: [{ id: 'p1', at: 'b1', op: 'span', text: '␣项目' }, { id: 'p2', at: 'b1', op: 'insert', before: '日期：' }],
        removals: [{ at: 'b0', text: '格式1' }],
        headings: [{ chapter_id: 'a', at: 'b0' }],
        boundary_issues: [{ chapter_id: 'a', problem: '混入了其他表单' }],
      },
    },
    {
      index: 2,
      classification: {
        fields: [
          { name: '投标人名称', subject: '投标人', fill_by: 'ai', candidate_ids: ['c_b0'] },
          { name: '投标日期', subject: '授权书', fill_by: 'ai', candidate_ids: ['p1'] },
        ],
        ignored_candidate_ids: ['p9'],
        positions: [{ id: 'p1', at: 'b5', op: 'span', text: '_年_月_日' }, { id: 'p9', at: 'b5', op: 'insert', after: '被' }],
        repeats: [{ entries: [{ from: 'b5' }, { from: 'b6' }] }],
      },
    },
  ], { candidates: candidatesFor({ a: 2, b: 1 }) });
  assert.deepEqual(classification.positions.map((item) => item.id), ['g1-p1', 'g1-p2', 'g2-p1', 'g2-p9']);
  assert.deepEqual(classification.ignored_candidate_ids, ['c_a1', 'g2-p9']);
  assert.deepEqual(classification.fields.map((item) => [item.name, item.candidate_ids]), [
    ['投标人名称', ['c_a0', 'g1-p1', 'c_b0']],
    ['投标日期', ['g1-p2']],
    ['投标日期〔第2组〕', ['g2-p1']],
  ]);
  assert.deepEqual(conflicts, [{ name: '投标日期', renamed: ['投标日期〔第2组〕'] }]);
  assert.equal(classification.removals.length, 1);
  assert.equal(classification.headings.length, 1);
  assert.equal(classification.repeats.length, 1);
  assert.ok(!('boundary_issues' in classification), '边界问题不进入合并后的分类');
  // 合并结果能按字段展开交给助手，冲突已改名不会报重复。
  assert.equal(expandClassification(classification).fields.length, 5);

  const textParts = splitTemplateText('说明\n【章节 a：投标书】默认标题段：无\nb1  日期：\n【章节 b：授权书】默认标题段：无\nb5  年月日\n');
  const list = buildFieldList(classification, { candidates: candidatesFor({ a: 2, b: 1 }) }, textParts, ITEMS);
  assert.deepEqual(list[0], {
    name: '投标人名称', subject: '投标人', fill_by: 'ai', kind: '文字', chapters: ['投标书', '授权书'], count: 3,
    contexts: ['a 第 0 处【▢】', '补充位置 b1：␣项目'],
  });
  assert.deepEqual(list[2].chapters, ['授权书']);
});

test('合并：跨组同名且主体、填写方式、说明都相同但类型不同的字段不合并，改名列为冲突交给统稿', () => {
  const candidates = [
    { candidate_id: 'c_a0', kind: 'text-placeholder', chapter_id: 'a' },
    { candidate_id: 'c_b0', kind: 'attachment-slot', chapter_id: 'b' },
    { candidate_id: 'c_c0', kind: 'checkbox-group', chapter_id: 'c' },
  ];
  const field = (ids) => ({ name: '营业执照', subject: '投标人', fill_by: 'ai', candidate_ids: ids });
  const { classification, conflicts } = mergeGroupClassifications([
    { index: 1, classification: { fields: [field(['c_a0'])], ignored_candidate_ids: [] } },
    { index: 2, classification: { fields: [field(['c_b0'])], ignored_candidate_ids: [] } },
    { index: 3, classification: { fields: [field(['p1'])], ignored_candidate_ids: [], positions: [{ id: 'p1', at: 'b9', op: 'attachment' }] } },
    { index: 4, classification: { fields: [field(['c_c0'])], ignored_candidate_ids: [] } },
  ], { candidates });
  // 与先出现的文字字段类型不同的改名列为冲突（补充的附件位置按 op 认定为附件），是否同一信息由统稿决定；
  // 第 2、3 组的附件写法类型和属性都相同，并成同一个改名字段。
  assert.deepEqual(classification.fields.map((item) => [item.name, item.candidate_ids]), [
    ['营业执照', ['c_a0']],
    ['营业执照〔第2组〕', ['c_b0', 'g3-p1']],
    ['营业执照〔第4组〕', ['c_c0']],
  ]);
  assert.deepEqual(conflicts, [{ name: '营业执照', renamed: ['营业执照〔第2组〕', '营业执照〔第4组〕'] }]);
  const list = buildFieldList(classification, { candidates }, splitTemplateText(''), ITEMS);
  assert.deepEqual(list.map((item) => item.kind), ['文字', '附件', '勾选']);
  // 统稿可以改名，不能把不同类型合成，也不能改成同名。
  const fieldList = list.map((item) => ({ name: item.name, kind: item.kind }));
  assert.deepEqual(applyNamingPlan(classification, { changes: [
    { from: ['营业执照〔第2组〕'], name: '营业执照扫描件' },
    { from: ['营业执照〔第4组〕'], name: '投标人是否提供营业执照勾选' },
  ] }, fieldList).errors, []);
  assert.match(applyNamingPlan(classification, { changes: [
    { from: ['营业执照', '营业执照〔第2组〕', '营业执照〔第4组〕'], name: '营业执照' },
  ] }, fieldList).errors.join('；'), /类型不同，不能合成/);
  assert.match(applyNamingPlan(classification, { changes: [
    { from: ['营业执照〔第2组〕'], name: '营业执照' },
    { from: ['营业执照〔第4组〕'], name: '投标人是否提供营业执照勾选' },
  ] }, fieldList).errors.join('；'), /都叫“营业执照”，但类型或附件拆分不同/);
});

test('合并：组内按章各写的同名同属性多项并成一个改名字段，统稿合回原名或只改回原名都能执行', () => {
  const candidates = ['c1', 'c4a', 'c4b', 'c5'].map((id) => ({ candidate_id: id, kind: 'text-placeholder', chapter_id: 'a' }));
  const own = (ids) => ({ name: '招标项目名称', subject: '本招标项目', fill_by: 'ai', candidate_ids: ids });
  const { classification, conflicts } = mergeGroupClassifications([
    { index: 1, classification: { fields: [{ name: '招标项目名称', subject: '本项目', fill_by: 'ai', candidate_ids: ['c1'] }] } },
    { index: 4, classification: { fields: [own(['c4a']), own(['c4b'])] } },
    { index: 5, classification: { fields: [own(['c5'])] } },
  ], { candidates });
  assert.deepEqual(classification.fields.map((item) => [item.name, item.candidate_ids]), [
    ['招标项目名称', ['c1']],
    ['招标项目名称〔第4组〕', ['c4a', 'c4b', 'c5']],
  ]);
  assert.deepEqual(conflicts, [{ name: '招标项目名称', renamed: ['招标项目名称〔第4组〕'] }]);
  const fieldList = buildFieldList(classification, { candidates }, splitTemplateText(''), ITEMS);
  const merged = applyNamingPlan(classification, { changes: [
    { from: ['招标项目名称', '招标项目名称〔第4组〕'], name: '招标项目名称', subject: '本招标项目' },
  ] }, fieldList);
  assert.deepEqual(merged.errors, []);
  assert.deepEqual(merged.classification.fields.map((item) => [item.name, item.subject, item.candidate_ids]), [
    ['招标项目名称', '本招标项目', ['c1', 'c4a', 'c4b', 'c5']],
  ]);
  // 只把改名字段改回原名：程序合成同名字段，主体取统稿写明的值，没写时沿用先出现的字段。
  const renamedBack = applyNamingPlan(classification, { changes: [{ from: ['招标项目名称〔第4组〕'], name: '招标项目名称', subject: '招标项目' }] }, fieldList);
  assert.deepEqual(renamedBack.errors, []);
  assert.deepEqual(renamedBack.classification.fields.map((item) => [item.name, item.subject, item.candidate_ids]), [
    ['招标项目名称', '招标项目', ['c1', 'c4a', 'c4b', 'c5']],
  ]);
  assert.equal(applyNamingPlan(classification, { changes: [{ from: ['招标项目名称〔第4组〕'], name: '招标项目名称' }] }, fieldList)
    .classification.fields[0].subject, '本项目');
  assert.match(applyNamingPlan(classification, { changes: [] }, fieldList).errors.join(), /仍带组号，必须处理：招标项目名称〔第4组〕/);
});

test('统稿清单：合成、改名、省略时沿用原写法，以及各类不能执行的情况', () => {
  const classification = {
    fields: [
      { name: '投标人名称', subject: '投标人', fill_by: 'ai', instruction: '填写全称', candidate_ids: ['c1'] },
      { name: '供应商名称', subject: '供应商', fill_by: 'ai', candidate_ids: ['c2'] },
      { name: '投标人名称〔第2组〕', subject: '承诺人', fill_by: 'ai', candidate_ids: ['c3'] },
      { name: '投标代表人姓名', subject: '投标代表人', fill_by: 'ai', candidate_ids: ['c4'] },
      { name: '投标人代表签字', subject: '投标人代表', fill_by: 'manual', candidate_ids: ['c5'] },
      { name: '营业执照', subject: '投标人', fill_by: 'ai', candidate_ids: ['c6'] },
      { name: '身份证', subject: '投标人代表', fill_by: 'ai', candidate_ids: ['c7'], parts: [{ name: '人像面' }, { name: '国徽面' }] },
    ],
    ignored_candidate_ids: ['c9'],
    positions: [{ id: 'g1-p1', at: 'b1', op: 'span', text: '␣' }],
  };
  const fieldList = classification.fields.map((item) => ({ name: item.name, kind: ['营业执照', '身份证'].includes(item.name) ? '附件' : '文字' }));
  const { classification: next, errors } = applyNamingPlan(classification, {
    changes: [
      { from: ['投标人名称', '供应商名称', '投标人名称〔第2组〕'], name: '投标人名称', subject: '投标人' },
      { from: ['投标代表人姓名'], name: '投标人代表姓名', subject: '投标人代表', instruction: '' },
    ],
  }, fieldList);
  assert.deepEqual(errors, []);
  assert.deepEqual(next.fields.map((item) => [item.name, item.subject, item.fill_by, item.instruction, item.candidate_ids]), [
    ['投标人名称', '投标人', 'ai', '填写全称', ['c1', 'c2', 'c3']],
    ['投标人代表姓名', '投标人代表', 'ai', undefined, ['c4']],
    ['投标人代表签字', '投标人代表', 'manual', undefined, ['c5']],
    ['营业执照', '投标人', 'ai', undefined, ['c6']],
    ['身份证', '投标人代表', 'ai', undefined, ['c7']],
  ]);
  assert.deepEqual(next.positions, classification.positions, '补充位置、忽略等其他内容不变');
  assert.equal(classification.fields.length, 7, '不改动传入的分类');

  const failures = (changes) => applyNamingPlan(classification, { changes }, fieldList).errors.join('\n');
  assert.match(applyNamingPlan(classification, {}, fieldList).errors[0], /changes/);
  assert.match(failures([{ from: ['投标人名称〔第2组〕'], name: '承诺人名称' }]), /^$/);
  assert.match(failures([]), /仍带组号，必须处理：投标人名称〔第2组〕/);
  assert.match(failures([{ from: ['不存在'], name: 'x' }]), /清单中没有字段“不存在”/);
  assert.match(failures([{ from: ['供应商名称'], name: 'a' }, { from: ['供应商名称'], name: 'b' }]), /在多项中出现/);
  // 改成已有字段的名称即合成到该字段；填写方式不同时须写在同一项并写明 fill_by。
  const renamedInto = applyNamingPlan(classification, { changes: [
    { from: ['供应商名称'], name: '投标人名称' },
    { from: ['投标人名称〔第2组〕'], name: '承诺人名称' },
  ] }, fieldList);
  assert.deepEqual(renamedInto.errors, []);
  assert.deepEqual(renamedInto.classification.fields[0], { name: '投标人名称', subject: '投标人', fill_by: 'ai', instruction: '填写全称', candidate_ids: ['c1', 'c2'] });
  assert.match(failures([{ from: ['投标代表人姓名'], name: '投标人代表签字' }, { from: ['投标人名称〔第2组〕'], name: '承诺人名称' }]), /都叫“投标人代表签字”，但填写方式不同/);
  assert.match(failures([{ from: ['供应商名称'], name: '营业执照' }, { from: ['投标人名称〔第2组〕'], name: '承诺人名称' }]), /都叫“营业执照”，但类型或附件拆分不同/);
  assert.match(failures([{ from: ['投标代表人姓名', '投标人代表签字'], name: '投标人代表' }]), /填写方式不同，请写明 fill_by/);
  assert.match(failures([{ from: ['投标代表人姓名'], name: '投标人代表姓名', fill_by: 'auto' }]), /fill_by 只能是/);
  assert.match(failures([{ from: ['供应商名称', '营业执照'], name: '供应商材料' }]), /类型不同，不能合成/);
  assert.match(failures([{ from: ['营业执照', '身份证'], name: '证件' }]), /附件拆分不同，不能合成/);
});

test('全部条目带原文位置时直接得到抽章参数', () => {
  assert.equal(hasAllSources(ITEMS), true);
  assert.equal(hasAllSources([...ITEMS, { id: 'e', title: '其他' }]), false);
  assert.deepEqual(chaptersFromItems(ITEMS.slice(0, 2)), [
    { id: 'a', title: '投标书', startBlock: 0, endBlock: 5 },
    { id: 'b', title: '授权书', startBlock: 5, endBlock: 9, source: '招标文件.docx' },
  ]);
});
