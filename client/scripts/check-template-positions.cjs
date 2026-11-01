// 投标模版字段识别验证：在系统临时目录的中文路径下手工构造抽章后的源模版和章节范围文件，
// 经 openXmlHelperService.runJob 调用真实的 OpenXmlHelper，断言模版正文、补充位置、去掉的原文、标题段、效果正文、写入与回填，以及规则表的行模型。
// 用法（client 目录）：node --test scripts/check-template-positions.cjs
// 开发客户端正在运行、Debug 版助手被占用时，可先把助手编译到别处，再设 YIBIAO_OPENXML_HELPER_DIR 指向该目录运行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const AdmZip = require('adm-zip');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const samples = require('./blind-check-samples.cjs');

const { cell, para, run, sectPr, table } = samples;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), '模版字段验证-'));
const workspace = path.join(userData, 'workspace');
const planDir = path.join(workspace, 'technical-plan');
const SOURCE = 'technical-plan/bid-template-source.docx';
const OUTPUT = 'technical-plan/bid-template.docx';
const FIELDS = 'technical-plan/bid-template-fields.json';
const FILLED = 'technical-plan/bid-template-filled.docx';
const app = {
  isPackaged: Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR),
  getPath: () => userData,
  getAppPath: () => path.join(__dirname, '..'),
};
let service;
let scan;

const CHAPTERS = [
  { id: 'n1', title: '法定代表人资格证明书', auto_fill: true, start_block: 0, end_block: 9 },
  { id: 'n2', title: '声明函', auto_fill: true, start_block: 9, end_block: 11 },
];

// 第一章覆盖：丢了空白的空位、括号提示、择一、带书签的段落、普通空白空位、只写材料名的单元格、超链接段落、示例文字；第二章标题带表单编号。
const BODY = [
  para('法定代表人资格证明书', '<w:pStyle w:val="1"/>'),
  para('兹证明，__________（先生/女士）在我公司任职务，现进行项目的投标（项目编号：），签署投标文件。'),
  `<w:p><w:bookmarkStart w:id="0" w:name="_Toc100"/>${run('从业人员人，营业收入为万元。')}<w:bookmarkEnd w:id="0"/></w:p>`,
  para('该声明函见投标文件第  页。'),
  table([[cell(para('法定代表人身份证正面') + para('')), cell(para('身份证号码：1234 （身份证复印件附后）'))]], 'TableGrid'),
  para('属于（请填写本项目采购文件中明确的所属行业）行业；'),
  para('我____________（姓名）系本单位员工。'),
  '<w:p><w:hyperlink w:anchor="x"><w:r><w:t>甲乙</w:t></w:r></w:hyperlink></w:p>',
  para('天津市XX项目'),
  para('附件2  声明函', '<w:pStyle w:val="1"/>'),
  para('本单位承诺所提供材料真实有效。'),
  sectPr(),
].join('');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspace, relativePath), 'utf8'));
}

function documentXml(relativePath) {
  return new AdmZip(path.join(workspace, relativePath)).readAsText('word/document.xml');
}

function candidate(predicate, label) {
  const found = scan.candidates.filter(predicate);
  assert.equal(found.length, 1, `应恰好找到一个候选：${label}，实际 ${found.length} 个`);
  return found[0];
}

// 应用分类，返回效果正文。
async function apply(classification) {
  const result = await service.runJob({
    action: 'apply-template-fields',
    request: { input: SOURCE, output: OUTPUT, fields_output: FIELDS, ...classification },
    timeoutMs: 60000,
  });
  return fs.readFileSync(path.join(result.jobDir, 'template-preview.txt'), 'utf8');
}

async function applyError(classification) {
  try {
    await apply(classification);
  } catch (error) {
    return error.message;
  }
  assert.fail('应当报错');
}

async function scanFile(name, body, chapters) {
  samples.buildDocx(planDir, `${name}.docx`, body);
  fs.writeFileSync(path.join(planDir, `${name}.chapters.json`), JSON.stringify({ version: 1, chapters }), 'utf8');
  const result = await service.runJob({ action: 'scan-template-fields', request: { input: `technical-plan/${name}.docx` }, timeoutMs: 60000 });
  return {
    candidates: JSON.parse(fs.readFileSync(path.join(result.jobDir, 'template-field-candidates.json'), 'utf8')).candidates,
    text: fs.readFileSync(path.join(result.jobDir, 'template-text.txt'), 'utf8'),
  };
}

before(async () => {
  service = createOpenXmlHelperService({ app });
  samples.buildDocx(planDir, 'bid-template-source.docx', BODY);
  fs.writeFileSync(path.join(planDir, 'bid-template-source.chapters.json'), JSON.stringify({ version: 1, chapters: CHAPTERS }), 'utf8');
  const result = await service.runJob({ action: 'scan-template-fields', request: { input: SOURCE }, timeoutMs: 60000 });
  scan = JSON.parse(fs.readFileSync(path.join(result.jobDir, 'template-field-candidates.json'), 'utf8'));
  scan.text = fs.readFileSync(path.join(result.jobDir, 'template-text.txt'), 'utf8');
});

after(async () => {
  await service?.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

// 规则候选的默认分类：两个下划线空位和附件说明作为字段，其余忽略。
function baseClassification() {
  const blank1 = candidate((item) => item.kind === 'text-placeholder' && item.context?.includes('兹证明'), '证明书姓名空位');
  const blank2 = candidate((item) => item.kind === 'text-placeholder' && item.context?.includes('系本单位员工'), '员工姓名空位');
  const note = candidate((item) => item.kind === 'attachment-note', '身份证复印件附后');
  const fields = [
    { candidate_id: blank1.candidate_id, name: '法定代表人姓名', subject: '法定代表人', fill_by: 'ai' },
    { candidate_id: blank2.candidate_id, name: '投标代表人姓名', subject: '投标代表人', fill_by: 'ai' },
    { candidate_id: note.candidate_id, name: '法定代表人身份证复印件', subject: '法定代表人', fill_by: 'ai' },
  ];
  const used = new Set(fields.map((item) => item.candidate_id));
  return { fields, ignored: scan.candidates.filter((item) => !used.has(item.candidate_id)).map((item) => item.candidate_id) };
}

const POSITIONS = [
  { id: 'p1', at: 'b1', op: 'insert', before: '任', after: '职务' },
  { id: 'p2', at: 'b1', op: 'insert', before: '项目编号：', after: '）' },
  { id: 'p3', at: 'b1', op: 'choose', text: '先生/女士', options: ['先生', '女士'] },
  { id: 'p4', at: 'b2', op: 'insert', before: '从业人员', after: '人' },
  { id: 'p5', at: 'b4.r1.c1.p1', op: 'attachment' },
  { id: 'p6', at: 'b5', op: 'span', text: '（请填写本项目采购文件中明确的所属行业）' },
  { id: 'p7', at: 'b8', op: 'span', text: 'XX项目' },
  { id: 'p8', at: 'b3', op: 'span', text: '␣␣' },
];

const POSITION_FIELDS = [
  { candidate_id: 'p1', name: '法定代表人职务', subject: '法定代表人', fill_by: 'ai' },
  { candidate_id: 'p2', name: '项目编号', subject: '本项目', fill_by: 'ai' },
  { candidate_id: 'p3', name: '法定代表人称谓', subject: '法定代表人', fill_by: 'ai' },
  { candidate_id: 'p4', name: '投标人从业人员人数', subject: '投标人', fill_by: 'ai' },
  { candidate_id: 'p5', name: '法定代表人身份证正面', subject: '法定代表人', fill_by: 'ai' },
  { candidate_id: 'p6', name: '本项目所属行业', subject: '本项目', fill_by: 'ai' },
  { candidate_id: 'p7', name: '项目名称', subject: '本项目', fill_by: 'ai' },
  { candidate_id: 'p8', name: '中小企业声明函所在页码', subject: '投标文件', fill_by: 'manual' },
];

const REMOVALS = [
  { at: 'b6', text: '（姓名）' },
  { at: 'b9', text: '附件2␣␣' },
];

function fullClassification(patch = {}) {
  const base = baseClassification();
  return {
    fields: [...base.fields, ...POSITION_FIELDS],
    ignored_candidate_ids: base.ignored,
    positions: POSITIONS,
    removals: REMOVALS,
    // 第二章标题带表单编号，按目录标题认定不出来，由 Agent 指定。
    headings: [{ chapter_id: 'n2', at: 'b9' }],
    ...patch,
  };
}

test('模版正文：定位号、候选标记、章节 id 与默认标题段、不可标记和书签段落；不再有括注、择一、空格和格式文字候选', () => {
  assert.match(scan.text, /^【章节 n1：法定代表人资格证明书】默认标题段：b0 法定代表人资格证明书$/m);
  assert.match(scan.text, /^【章节 n2：声明函】默认标题段：无$/m, '带编号的短标题认定不出来时为无，由 Agent 指定');
  assert.match(scan.text, /^b1 {2}兹证明，〔c_[0-9a-f]+：__________〕（先生\/女士）在我公司任职务/m);
  assert.match(scan.text, /^b3 {2}该声明函见投标文件第␣␣页。$/m);
  assert.match(scan.text, /^b2 {2}从业人员人，营业收入为万元。$/m, '带书签的段落应可写、不标〔不可标记〕');
  assert.match(scan.text, /^b7 {2}〔不可标记〕/m, '含超链接的段落不可写');
  assert.match(scan.text, /^b4\.r1\.c2\.p1 {2}身份证号码：1234 （身份证复印件附后）〔c_[0-9a-f]+〕$/m);
  assert.ok(!/^b4\.r1\.c1\.p2/m.test(scan.text), '空段落应省略');
  const kinds = new Set(scan.candidates.map((item) => item.kind));
  for (const kind of ['bracket-note', 'alternatives', 'space-gap', 'format-text', 'table-slot']) assert.ok(!kinds.has(kind), `不应再有 ${kind} 候选`);
});

test('只做可执行性校验：定位不唯一、找不到、补充位置没有字段、选项自拟、不可标记、去掉的文字找不到或与字段重叠、标题段无效', async () => {
  const ok = fullClassification();
  const message = async (patch) => applyError({ ...ok, ...patch });
  assert.match(await message({ positions: [...POSITIONS, { id: 'p9', at: 'b1', op: 'insert', after: '，' }] }), /p9：在 b1 中命中 3 处/);
  assert.match(await message({ positions: [...POSITIONS, { id: 'p9', at: 'b1', op: 'span', text: '不存在的文字' }] }), /p9：在 b1 中找不到/);
  assert.match(await message({ positions: [...POSITIONS, { id: 'p9', at: 'b8', op: 'insert', after: '天津' }] }), /补充位置没有对应字段.*p9/);
  assert.match(await message({ positions: POSITIONS.map((item) => (item.id === 'p3' ? { ...item, options: ['先生', '小姐'] } : item)) }), /p3：选项必须是 text 中原有的文字.*小姐/);
  assert.match(await message({ positions: [...POSITIONS, { id: 'p9', at: 'b7', op: 'insert', before: '甲' }] }), /p9：b7 标有〔不可标记〕/);
  assert.match(await message({ removals: [...REMOVALS, { at: 'b10', text: '不存在' }] }), /removals 第 3 项（b10）：在 b10 中找不到/);
  assert.match(await message({ removals: [...REMOVALS, { at: 'b5', text: '所属行业' }] }), /同一段内重叠/);
  assert.match(await message({ headings: [{ chapter_id: 'n9', at: null }] }), /chapter_id“n9”不是已确认目录的 id/);
  assert.match(await message({ headings: [{ chapter_id: 'n1', at: 'b10' }] }), /标题段 b10 不是该章的段落/);
  assert.match(await message({ headings: [{ chapter_id: 'n1', at: 'b4.r1.c1.p1' }] }), /必须是正文顶层段落/);
  assert.match(await message({ removals: [...REMOVALS, { at: 'b0', text: '法定代表人资格证明书' }], headings: [{ chapter_id: 'n1', at: 'b0' }] }), /文字全部被去掉了/);
  // 补充位置不需要时可以放入忽略。
  await apply({ ...ok, positions: [...POSITIONS, { id: 'p9', at: 'b8', op: 'insert', after: '天津' }], ignored_candidate_ids: [...ok.ignored_candidate_ids, 'p9'] });
});

test('写入：补充位置、去掉的原文、择一和附件位生成对应控件，标题段写书签，效果正文按分类显示，回填择一，截章去掉原文', async () => {
  const preview = await apply(fullClassification());
  assert.match(preview, /^【章节 n1：法定代表人资格证明书】标题段：b0 法定代表人资格证明书$/m);
  assert.match(preview, /^【章节 n2：声明函】标题段：b9 附件2␣␣声明函$/m);
  assert.match(preview, /^b1 {2}兹证明，【法定代表人姓名】（〔择一 法定代表人称谓：先生\/女士〕）在我公司任【法定代表人职务】职务，现进行项目的投标（项目编号：【项目编号】）/m);
  assert.match(preview, /^b5 {2}属于【本项目所属行业←（请填写本项目采购文件中明确的所属行业）】行业；$/m);
  assert.match(preview, /^b6 {2}我【投标代表人姓名】〔已去掉：（姓名）〕系本单位员工。$/m);
  assert.match(preview, /^b8 {2}天津市【项目名称←XX项目】$/m);
  assert.match(preview, /^b3 {2}该声明函见投标文件第【中小企业声明函所在页码】页。$/m);
  assert.match(preview, /^b9 {2}〔已去掉：附件2␣␣〕声明函$/m);
  assert.match(preview, /〔附件 法定代表人身份证正面〕/);

  const definitions = readJson(FIELDS);
  const byName = new Map(definitions.fields.map((item) => [item.name, item]));
  assert.equal(byName.get('法定代表人称谓').kind, 'select');
  assert.deepEqual(byName.get('法定代表人称谓').options, ['先生', '女士']);
  assert.equal(byName.get('法定代表人身份证正面').kind, 'attachment');
  assert.equal(byName.get('法定代表人身份证正面').table_id, 't4');
  assert.match(byName.get('法定代表人职务').context, /任【▢】职务/, '字段带原句');
  assert.deepEqual(definitions.chapters.map((item) => item.heading), [true, true]);

  const xml = documentXml(OUTPUT);
  for (const field of definitions.fields) {
    assert.equal(xml.split(`yibiao:field:${field.id}"`).length - 1, 1, `${field.name} 应恰好一个控件`);
  }
  assert.ok(xml.includes('yibiao:format:rm1') && xml.includes('yibiao:format:rm2'), '去掉的原文应包成格式文字控件');
  assert.ok(xml.includes('w:name="_YbH0"') && xml.includes('w:name="_YbH1"'), '标题段应写书签');
  assert.ok(!xml.includes('请填写本项目采购文件中明确的所属行业'), '作为字段的说明括注应被占位替换');
  assert.ok(xml.includes('先生/女士'), '择一写入时保留原文');

  await service.runJob({
    action: 'fill-template-fields',
    request: {
      input: OUTPUT,
      output: FILLED,
      values: [
        { id: byName.get('法定代表人称谓').id, option: '先生' },
        { id: byName.get('法定代表人职务').id, value: '总经理' },
      ],
    },
    timeoutMs: 60000,
  });
  const filled = documentXml(FILLED);
  assert.ok(!filled.includes('先生/女士'));
  assert.match(filled.replace(/<[^>]+>/g, ''), /（先生）在我公司任总经理职务/);

  const slice = async (id) => {
    const chapter = definitions.chapters.find((item) => item.id === id);
    const bytes = await service.createTemplateChapterDocx({ input: OUTPUT, startBlock: chapter.start_block, endBlock: chapter.end_block });
    return new AdmZip(Buffer.from(bytes)).readAsText('word/document.xml').replace(/<[^>]+>/g, '');
  };
  const first = await slice('n1');
  assert.ok(!first.includes('（姓名）') && first.includes('系本单位员工'), '截章应去掉要去掉的原文');
  const second = await slice('n2');
  assert.ok(!second.includes('附件2') && second.includes('声明函'), second);
});

test('标题段：指定其他段落、写 null 表示没有标题段；默认认定找不到时也记为没有标题段', async () => {
  await apply(fullClassification({ headings: [{ chapter_id: 'n1', at: 'b1' }, { chapter_id: 'n2', at: null }] }));
  const definitions = readJson(FIELDS);
  assert.deepEqual(definitions.chapters.map((item) => item.heading), [true, false]);
  const xml = documentXml(OUTPUT);
  assert.match(xml, /w:name="_YbH0"[\s\S]*?兹证明/, '指定的段落带标题书签');
  assert.ok(!xml.includes('w:name="_YbH1"'));

  const plain = await scanFile('heading-source', [
    para('致：某某公司'),
    para('本单位承诺。'),
    sectPr(),
  ].join(''), [{ id: 'h1', title: '承诺书', auto_fill: true, start_block: 0, end_block: 2 }]);
  assert.match(plain.text, /^【章节 h1：承诺书】默认标题段：无$/m, '正文段落不当作标题');
});

// 规则和页码表：Agent 按全部行逐行决定原地填写（from）、照某行新增（like）或整表重建；新增行落在所照行所在的分段。
const { collectRuleTableSpecs, checkRulePageResult, describeRuleBasis } = require('../electron/services/rulePageCompileTask.cjs');
const { buildRuleTableFills } = require('../electron/services/rulePageTables.cjs');
const { readTemplateLayout } = require('../electron/services/pi/piOpenXmlTool.cjs');

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const NODE_C = '33333333-3333-4333-8333-333333333333';
const RULE_OUTLINE = [
  { id: NODE_A, title: '应答表', content_mode: 'rule-page', rule_basis: 'technical' },
  { id: NODE_B, title: '页码检索表', content_mode: 'rule-page', rule_basis: 'both' },
  { id: NODE_C, title: '服务方案', content_mode: 'ai-generate' },
];

// 行为字符串时是整行合并的分段行。
function tableN(rows) {
  const count = rows.find(Array.isArray).length;
  const width = Math.floor(9000 / count);
  const tc = (text, span = 1) => `<w:tc><w:tcPr><w:tcW w:w="${width * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>${para(text)}</w:tc>`;
  return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    + `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(count)}</w:tblGrid>`
    + `${rows.map((cells) => `<w:tr>${Array.isArray(cells) ? cells.map((text) => tc(text)).join('') : tc(cells, count)}</w:tr>`).join('')}</w:tbl>`;
}

function tableRowsText(xml) {
  return [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((match) => [...match[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]
    .map((item) => item[0].replace(/<[^>]+>/g, '')).join('|'));
}

test('应答依据：按目录标明的依据只给对应评分要求，缺失时明确只依据原文条款', () => {
  const references = { technical: '技术评分', business: '' };
  assert.equal(describeRuleBasis('technical', references), '本表应答技术部分，参考 技术评分要求.md。');
  assert.equal(describeRuleBasis('business', references), '本表应答商务部分，本次没有商务评分要求，只依据招标原文条款。');
  assert.match(describeRuleBasis('both', references), /^本表同时应答技术和商务：技术条目参考 技术评分要求\.md；商务条目本次没有商务评分要求/);
  assert.match(describeRuleBasis(undefined, references), /未指定应答依据/);
});

test('规则表：分段表格新增行落在所照行的分段、照分段行新增分组行、空行删除而预印行保留；重建替换原表；新建表含分组行', async () => {
  const name = 'rule-source';
  const { candidates } = await scanFile(name, [
    para('应答表', '<w:pStyle w:val="1"/>'),
    tableN([
      ['序号', '招标要求', '投标应答', '页码'],
      ['1', '甲要求', '', ''],
      ['2', '乙要求', '', ''],
      '二、第二部分',
      ['序号', '招标要求', '投标应答', '备注'],
      ['', '', '', ''],
      ['', '', '', ''],
    ]),
    para('页码检索表', '<w:pStyle w:val="1"/>'),
    sectPr(),
  ].join(''), [
    { id: NODE_A, title: '应答表', auto_fill: true, rule_page: true, start_block: 0, end_block: 2 },
    { id: NODE_B, title: '页码检索表', auto_fill: true, rule_page: true, start_block: 2, end_block: 3 },
  ]);
  const cellOf = (row, column) => candidates.find((item) => item.table_id === 't1' && item.row_number === row && item.column_number === column);
  const fieldOf = (row, column, fieldName) => cellOf(row, column) && { candidate_id: cellOf(row, column).candidate_id, name: fieldName, subject: '招标条款', fill_by: 'rule' };
  const fields = [
    ...[2, 3].flatMap((row) => [fieldOf(row, 3, '投标应答'), fieldOf(row, 4, '页码')]),
    ...[6, 7].flatMap((row) => [fieldOf(row, 1, '序号'), fieldOf(row, 2, '招标要求'), fieldOf(row, 3, '投标应答'), fieldOf(row, 4, '备注')]),
  ].filter(Boolean);
  assert.ok(fields.length >= 10, `规则格候选不足：${fields.length}`);
  fields.push({ candidate_id: 'p1', name: '评分因素页码检索表', subject: '投标文件', fill_by: 'rule', instruction: '逐项列出评分因素和页码' });
  const used = new Set(fields.map((item) => item.candidate_id));
  await service.runJob({
    action: 'apply-template-fields',
    request: {
      input: `technical-plan/${name}.docx`,
      output: 'technical-plan/rule-template.docx',
      fields_output: 'technical-plan/rule-fields.json',
      fields,
      ignored_candidate_ids: candidates.filter((item) => !used.has(item.candidate_id)).map((item) => item.candidate_id),
      positions: [{ id: 'p1', at: 'b2', op: 'table' }],
    },
    timeoutMs: 60000,
  });

  const template = readJson('technical-plan/rule-fields.json');
  const layout = await readTemplateLayout({ openXmlHelperService: service, input: 'technical-plan/rule-template.docx' });
  const scope = {
    template,
    chapters: template.chapters.map((chapter) => ({
      ...chapter,
      blocks: layout.blocks.filter((block) => block.index >= chapter.start_block && block.index < chapter.end_block),
    })),
  };
  const specs = collectRuleTableSpecs(scope, RULE_OUTLINE);
  const [list, slot] = specs;
  assert.equal(list.basis, 'technical');
  assert.equal(slot.basis, 'both');
  assert.equal(slot.kind, 'new');
  assert.equal(list.rows.length, 7, '列出表格全部行');
  assert.deepEqual(list.rows[1].cells.map((cell) => [cell.label, cell.fill]), [['序号', false], ['招标要求', false], ['投标应答', true], ['页码', true]]);
  assert.deepEqual(list.rows[3].cells.map((cell) => cell.label), ['第1格'], '分段行');
  assert.deepEqual(list.rows[5].cells.map((cell) => cell.label), ['序号', '招标要求', '投标应答', '备注'], '第二段按本段表头命名');
  assert.match(list.rows[1].cells[2].text, /［待填：投标应答］/);

  const check = (t1, t2 = { id: 'T2', columns: ['评分因素', '页码'], rows: [{ group: '一、技术部分' }, { values: { 评分因素: '价格', 页码: '{{页码:3}}' } }] }) => checkRulePageResult(JSON.stringify({
    tables: [{ id: 'T1', ...t1 }, t2],
    unresolved: [],
  }), specs, RULE_OUTLINE);
  const messages = (t1) => check(t1).issues.map((item) => item.message).join('；');
  assert.match(messages({ rows: [{ from: 2, like: 2, values: {} }] }), /须且只能写 from 或 like/);
  assert.match(messages({ rows: [{ from: 3, values: { 投标应答: 'a', 页码: 'b' } }, { from: 2, values: { 投标应答: 'a', 页码: 'b' } }] }), /没有按行号递增/);
  assert.match(messages({ rows: [{ like: 9, values: {} }] }), /模版表格只有 7 行/);
  assert.match(messages({ rows: [{ from: 2, values: { 页码: 'x' } }] }), /“投标应答”没有取值/);
  assert.match(messages({ rows: [{ from: 2, values: { 投标应答: 'a', 页码: 'b', 备注: 'c' } }] }), /第 2 行没有的格子：备注/);
  assert.match(messages({ rows: [{ group: '三' }] }), /不写 group/);
  assert.match(messages({ columns: ['a', 'b'], rows: [] }), /不写 columns/);

  const filledRows = async (t1) => {
    const result = check(t1);
    assert.deepEqual(result.issues, []);
    await service.runJob({
      action: 'fill-template-fields',
      request: {
        input: 'technical-plan/rule-template.docx',
        output: 'technical-plan/rule-filled.docx',
        values: [],
        rule_tables: buildRuleTableFills({ tables: result.value.tables }, RULE_OUTLINE),
      },
      timeoutMs: 60000,
    });
    return documentXml('technical-plan/rule-filled.docx');
  };
  const xml = await filledRows({ rows: [
    { from: 2, values: { 投标应答: '响应甲', 页码: '{{页码:3}}' } },
    { like: 2, values: { 序号: '2', 招标要求: '甲二要求', 投标应答: '响应甲二', 页码: '{{页码:3}}' } },
    { like: 6, values: { 序号: '1', 招标要求: '丙要求', 投标应答: '响应丙', 备注: '无' } },
    { like: 6, values: { 序号: '2', 招标要求: '丁要求', 投标应答: '响应丁', 备注: '无' } },
    { like: 4, values: { 第1格: '三、第三部分' } },
    { like: 6, values: { 序号: '1', 招标要求: '戊要求', 投标应答: '响应戊', 备注: '无' } },
  ] });
  assert.deepEqual(tableRowsText(xml), [
    '序号|招标要求|投标应答|页码',
    '1|甲要求|响应甲|〔页码：服务方案〕',
    '2|甲二要求|响应甲二|〔页码：服务方案〕',
    '2|乙要求|【待填写：投标应答】|【待填写：页码】',
    '二、第二部分',
    '序号|招标要求|投标应答|备注',
    '1|丙要求|响应丙|无',
    '2|丁要求|响应丁|无',
    '三、第三部分',
    '1|戊要求|响应戊|无',
    '评分因素|页码',
    '一、技术部分',
    '价格|〔页码：服务方案〕',
  ]);
  assert.match(xml, /<w:gridSpan w:val="2" ?\/>[\s\S]*?一、技术部分/, '新建表的分组行整行合并');
  const plain = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  assert.ok(plain.indexOf('页码检索表') < plain.indexOf('评分因素'), '新建表格在标题段之后');

  const rebuilt = await filledRows({ rebuild: true, columns: ['序号', '要求', '应答'], rows: [
    { group: '一、技术' },
    { values: { 序号: '1', 要求: '甲要求', 应答: '响应甲' } },
  ] });
  assert.deepEqual(tableRowsText(rebuilt).slice(0, 3), ['序号|要求|应答', '一、技术', '1|甲要求|响应甲'], '重建替换原表');
  assert.ok(!rebuilt.includes('乙要求'));
});

test('回填不改取值文字：后文是另一个标签时只补空格，取值与后文重复的字由填写 Agent 按原句处理', async () => {
  const name = 'fit-source';
  const { candidates } = await scanFile(name, [
    para('单位信息', '<w:pStyle w:val="1"/>'),
    para('单位名称：____公司地址：____'),
    para('参加____项目（项目编号：____）'),
    sectPr(),
  ].join(''), [{ id: 'f1', title: '单位信息', auto_fill: true, start_block: 0, end_block: 3 }]);
  const blanks = candidates.filter((item) => item.kind === 'text-placeholder');
  assert.equal(blanks.length, 4);
  const names = ['单位名称', '单位地址', '项目名称', '项目编号'];
  await service.runJob({
    action: 'apply-template-fields',
    request: {
      input: `technical-plan/${name}.docx`,
      output: 'technical-plan/fit-template.docx',
      fields_output: 'technical-plan/fit-fields.json',
      fields: blanks.map((item, index) => ({ candidate_id: item.candidate_id, name: names[index], subject: '投标人', fill_by: 'ai' })),
      ignored_candidate_ids: candidates.filter((item) => !blanks.includes(item)).map((item) => item.candidate_id),
    },
    timeoutMs: 60000,
  });
  const ids = new Map(readJson('technical-plan/fit-fields.json').fields.map((item) => [item.name, item.id]));
  await service.runJob({
    action: 'fill-template-fields',
    request: {
      input: 'technical-plan/fit-template.docx',
      output: 'technical-plan/fit-filled.docx',
      values: [
        { id: ids.get('单位名称'), value: '北京建设公司' },
        { id: ids.get('单位地址'), value: '北京市朝阳区' },
        { id: ids.get('项目名称'), value: '某某运维' },
        { id: ids.get('项目编号'), value: 'ZX-1' },
      ],
    },
    timeoutMs: 60000,
  });
  const text = documentXml('technical-plan/fit-filled.docx').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  assert.ok(text.includes('单位名称：北京建设公司　　公司地址：北京市朝阳区'), text);
  assert.ok(text.includes('参加某某运维项目（项目编号：ZX-1）'), text);
});

test('制表符和分页段落可写入且保留断点；去掉的章末附件编号在截章时去掉', async () => {
  const name = 'mark-source';
  const { candidates: list, text } = await scanFile(name, [
    para('授权书', '<w:pStyle w:val="1"/>'),
    '<w:p><w:r><w:t xml:space="preserve">职务：</w:t><w:tab/><w:t>____</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>投标人名称：____</w:t><w:br w:type="page"/><w:t>附件4</w:t></w:r></w:p>',
    sectPr(),
  ].join(''), [{ id: 'm1', title: '授权书', auto_fill: true, start_block: 0, end_block: 3 }]);
  assert.match(text, /^b1 {2}职务：⇥〔c_[0-9a-f]+：____〕$/m);
  assert.match(text, /^b2 {2}投标人名称：〔c_[0-9a-f]+：____〕⏎附件4$/m);
  const duty = list.find((item) => item.context?.includes('职务'));
  const bidder = list.find((item) => item.context?.includes('投标人名称'));
  await service.runJob({
    action: 'apply-template-fields',
    request: {
      input: `technical-plan/${name}.docx`,
      output: 'technical-plan/mark-template.docx',
      fields_output: 'technical-plan/mark-fields.json',
      fields: [
        { candidate_id: duty.candidate_id, name: '法定代表人职务', subject: '法定代表人', fill_by: 'ai' },
        { candidate_id: bidder.candidate_id, name: '投标人名称', subject: '投标人', fill_by: 'ai' },
      ],
      ignored_candidate_ids: list.filter((item) => item !== duty && item !== bidder).map((item) => item.candidate_id),
      removals: [{ at: 'b2', text: '附件4' }],
    },
    timeoutMs: 60000,
  });
  const template = readJson('technical-plan/mark-fields.json');
  const ids = new Map(template.fields.map((item) => [item.name, item.id]));
  await service.runJob({
    action: 'fill-template-fields',
    request: {
      input: 'technical-plan/mark-template.docx',
      output: 'technical-plan/mark-filled.docx',
      values: [{ id: ids.get('法定代表人职务'), value: '总经理' }, { id: ids.get('投标人名称'), value: '北京建设公司' }],
    },
    timeoutMs: 60000,
  });
  const xml = documentXml('technical-plan/mark-filled.docx');
  const dutyParagraph = xml.match(/<w:p>(?:(?!<\/w:p>).)*总经理(?:(?!<\/w:p>).)*<\/w:p>/s)?.[0] || '';
  const tab = dutyParagraph.search(/<w:tab ?\/>/);
  assert.ok(tab >= 0 && tab < dutyParagraph.indexOf('总经理'), '制表符保留在值之前');
  const bidderParagraph = xml.match(/<w:p>(?:(?!<\/w:p>).)*北京建设公司(?:(?!<\/w:p>).)*<\/w:p>/s)?.[0] || '';
  const pageBreak = bidderParagraph.search(/<w:br w:type="page" ?\/>/);
  assert.ok(pageBreak > bidderParagraph.indexOf('北京建设公司') && pageBreak < bidderParagraph.indexOf('附件4'), '分页保留在值之后、附件4之前');
  const chapter = template.chapters[0];
  const bytes = await service.createTemplateChapterDocx({ input: 'technical-plan/mark-filled.docx', startBlock: chapter.start_block, endBlock: chapter.end_block });
  const sliced = new AdmZip(Buffer.from(bytes)).readAsText('word/document.xml').replace(/<[^>]+>/g, '');
  assert.ok(sliced.includes('投标人名称：北京建设公司') && !sliced.includes('附件4'), sliced);
});
