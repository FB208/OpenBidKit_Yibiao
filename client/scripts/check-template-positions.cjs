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

// 可重复条目：Agent 标出的段落条目按条编号、逐条填写，未使用的条目整本导出时删除。
const { groupFieldUnits, buildFieldsInput } = require('../electron/services/businessTemplateFillTask.cjs');

test('可重复条目：字段按条编号并逐条填写，只校验能否执行；未使用的条目回填时标记、截章时删除', async () => {
  const name = 'repeat-source';
  const { candidates } = await scanFile(name, [
    para('中小企业声明函', '<w:pStyle w:val="1"/>'),
    para('本公司郑重声明，具体情况如下：'),
    para('1.__________（标的名称），承接企业为__________；'),
    para('2.__________（标的名称），承接企业为__________；'),
    para('以上企业不属于大企业的分支机构。'),
    table([[cell(para('甲')), cell(para('乙'))]], 'TableGrid'),
    sectPr(),
  ].join(''), [{ id: 'm1', title: '中小企业声明函', auto_fill: true, start_block: 0, end_block: 6 }]);
  const blanks = (prefix) => candidates.filter((item) => item.kind === 'text-placeholder' && item.context?.startsWith(prefix));
  const entryFields = [1, 2].flatMap((number) => {
    const [subjectBlank, companyBlank] = blanks(`${number}.`);
    assert.ok(subjectBlank && companyBlank, `第 ${number} 条应有两个空位`);
    return [
      { candidate_id: subjectBlank.candidate_id, name: '标的名称', subject: '采购标的', fill_by: 'ai' },
      { candidate_id: companyBlank.candidate_id, name: '标的承接企业名称', subject: '标的承接企业', fill_by: 'ai' },
    ];
  });
  const used = new Set(entryFields.map((item) => item.candidate_id));
  const applyRepeats = async (repeats) => {
    const result = await service.runJob({
      action: 'apply-template-fields',
      request: {
        input: `technical-plan/${name}.docx`,
        output: 'technical-plan/repeat-template.docx',
        fields_output: 'technical-plan/repeat-fields.json',
        fields: entryFields,
        ignored_candidate_ids: candidates.filter((item) => !used.has(item.candidate_id)).map((item) => item.candidate_id),
        repeats,
      },
      timeoutMs: 60000,
    });
    return fs.readFileSync(path.join(result.jobDir, 'template-preview.txt'), 'utf8');
  };
  const repeatError = async (repeats) => {
    try {
      await applyRepeats(repeats);
    } catch (error) {
      return error.message;
    }
    assert.fail('应当报错');
  };
  assert.match(await repeatError([{ entries: [{ from: 'b2' }] }]), /至少需要两条/);
  assert.match(await repeatError([{ entries: [{ from: 'b2', to: 'b5.r1.c1.p1' }, { from: 'b3' }] }]), /不在同一层级/);
  assert.match(await repeatError([{ entries: [{ from: 'b2', to: 'b3' }, { from: 'b3' }] }]), /范围重叠/);
  assert.match(await repeatError([{ entries: [{ from: 'b2' }, { from: 'b4' }] }]), /第 2 条 中没有选用的字段/);
  assert.match(await repeatError([{ entries: [{ from: 'b3' }, { from: 'b2' }] }, { entries: [{ from: 'b1' }, { from: 'b0' }] }]), /包含章节标题段/);

  const preview = await applyRepeats([{ entries: [{ from: 'b2' }, { from: 'b3' }] }]);
  assert.match(preview, /^b2 {2}〔条目 e1·第1条〕1\.【标的名称】/m);
  assert.match(preview, /^b3 {2}〔条目 e1·第2条〕2\.【标的名称】/m);
  assert.match(preview, /^b4 {2}以上企业/m, '条目外的段落不加前缀');

  const definitions = readJson('technical-plan/repeat-fields.json');
  assert.deepEqual(
    definitions.fields.map((field) => [field.name, field.table_id, field.row, field.entry]),
    [['标的名称', 'e1', 1, true], ['标的承接企业名称', 'e1', 1, true], ['标的名称', 'e1', 2, true], ['标的承接企业名称', 'e1', 2, true]],
  );
  const units = groupFieldUnits(definitions.fields);
  assert.equal(units.length, 4, '两条各自成为填写项');
  const input = buildFieldsInput(units);
  assert.deepEqual(input.fields, []);
  assert.deepEqual(input.tables.map((item) => [item.table_id, item.entries, item.rows]), [['e1', true, [1, 2]]]);

  const [first, second] = [1, 2].map((row) => definitions.fields.filter((field) => field.row === row));
  const chapter = definitions.chapters[0];
  const fillAndSlice = async (removeIds) => {
    await service.runJob({
      action: 'fill-template-fields',
      request: {
        input: 'technical-plan/repeat-template.docx',
        output: 'technical-plan/repeat-filled.docx',
        values: [
          { id: first[0].id, value: '运维服务' },
          { id: first[1].id, value: '甲公司' },
          ...second.map((field) => ({ id: field.id, blank: true })),
        ],
        remove_row_field_ids: removeIds,
      },
      timeoutMs: 60000,
    });
    const filled = documentXml('technical-plan/repeat-filled.docx');
    const bytes = await service.createTemplateChapterDocx({ input: 'technical-plan/repeat-filled.docx', startBlock: chapter.start_block, endBlock: chapter.end_block });
    return { filled, sliced: new AdmZip(Buffer.from(bytes)).readAsText('word/document.xml') };
  };
  const removed = await fillAndSlice(second.map((field) => field.id));
  assert.ok(removed.filled.includes('w:name="_YbR1_1"') && removed.filled.includes('w:name="_YbD1_2"'), '回填时只把未使用的条目改名为待删');
  const removedText = removed.sliced.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  assert.match(removedText, /1\.运维服务（标的名称），承接企业为甲公司；/);
  assert.ok(!removedText.includes('2.'), '未使用的条目在截章时删除');
  assert.ok(removedText.includes('以上企业不属于大企业的分支机构。'));
  assert.ok(!/_YbR|_YbD/.test(removed.sliced), '截章后不留条目书签');

  const kept = await fillAndSlice([]);
  assert.ok(!kept.filled.includes('_YbD'));
  assert.ok(kept.sliced.replace(/<[^>]+>/g, '').includes('2.'), '不在未使用列表中的条目保留');
});

// 金额联动：填写 Agent 声明同值和大写，程序只校验能否执行，确认弹窗按来源同步、换算大写。
const { checkBusinessTemplateFillResult, buildConfirmedEntries } = require('../electron/services/businessTemplateFillTask.cjs');

test('金额联动：links 校验能否执行并记下联动，确认时保留联动；金额换算中文大写', async () => {
  const fields = [
    { id: 'f1', name: '投标总价', subject: '投标人', fill_by: 'ai', kind: 'text' },
    { id: 'f2', name: '投标总价大写', subject: '投标人', fill_by: 'ai', kind: 'text' },
    ...[2, 3].flatMap((row) => [
      { id: `s${row}`, name: '服务名称', subject: '报价项目', fill_by: 'ai', kind: 'text', table_id: 't1', row },
      { id: `p${row}`, name: '投标总价', subject: '报价项目', fill_by: 'ai', kind: 'text', table_id: 't1', row },
    ]),
  ];
  const units = groupFieldUnits(fields);
  const tableTotal = { table_id: 't1', row: 2, name: '投标总价' };
  const check = (patch) => checkBusinessTemplateFillResult(JSON.stringify({
    values: [],
    rows: [{ table_id: 't1', row: 2, values: [{ name: '服务名称', value: '运维服务' }] }],
    unresolved: [{ name: '投标总价', reason: '金额由投标人填写' }],
    links: [
      { target: tableTotal, source: { name: '投标总价' }, form: 'same' },
      { target: { name: '投标总价大写' }, source: { name: '投标总价' }, form: 'uppercase' },
    ],
    ...patch,
  }), units);
  const messages = (patch) => check(patch).issues.map((item) => item.message).join('；');

  const result = check({});
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.value.entries.p2, { link: { source: 'f1', form: 'same' }, unresolved_reason: '随“投标总价”填写' });
  assert.deepEqual(result.value.entries.f2, { link: { source: 'f1', form: 'uppercase' }, unresolved_reason: '按“投标总价”换算大写' });
  assert.deepEqual(result.value.entries.p3, { blank: true }, '未使用的行照常留空，不带联动');

  assert.match(messages({ unresolved: [{ name: '投标总价', reason: '金额' }, { name: '投标总价大写', reason: '金额' }] }), /已声明联动/);
  assert.match(messages({ links: [
    { target: { name: '投标总价大写' }, source: { name: '投标总价' }, form: 'uppercase' },
    { target: tableTotal, source: { name: '投标总价大写' }, form: 'same' },
  ] }), /是另一条 links 的 target/);
  assert.match(messages({ links: [{ target: { ...tableTotal, row: 3 }, source: { name: '投标总价' }, form: 'same' }] }), /第 3 行没有写入 rows/);
  assert.match(messages({ links: [{ target: { name: '投标总价' }, source: { name: '投标总价' }, form: 'same' }] }), /同一个位置/);

  // 来源已有取值时，同值联动一并写入。
  const copied = check({ values: [{ name: '投标总价', value: '100000' }], unresolved: [] });
  assert.deepEqual(copied.value.entries.p2, { link: { source: 'f1', form: 'same' }, value: '100000' });

  // 确认时联动随填写项保留，弹窗提交的计算值照常写入。
  const saved = fields.map((field) => ({ ...field, ...(result.value.entries[field.id] || {}) }));
  const unitKey = (id) => units.find((unit) => unit.field_ids.includes(id)).key;
  const confirmed = buildConfirmedEntries(saved, [
    { key: unitKey('f1'), value: '123456' },
    { key: unitKey('f2'), value: '壹拾贰万叁仟肆佰伍拾陆元整' },
  ]);
  assert.deepEqual(confirmed.f2, { value: '壹拾贰万叁仟肆佰伍拾陆元整', link: { source: 'f1', form: 'uppercase' } });
  assert.deepEqual(confirmed.p2, { unresolved_reason: '随“投标总价”填写', link: { source: 'f1', form: 'same' } });

  const { toChineseAmount } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/features/technical-plan/services/amountUppercase.ts')).href);
  assert.equal(toChineseAmount('123456'), '壹拾贰万叁仟肆佰伍拾陆元整');
  assert.equal(toChineseAmount('￥1,234,567.89元'), '壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分');
  assert.equal(toChineseAmount('10005'), '壹万零伍元整');
  assert.equal(toChineseAmount('100000'), '壹拾万元整');
  assert.equal(toChineseAmount('1010'), '壹仟零壹拾元整');
  assert.equal(toChineseAmount('50000300'), '伍仟万零叁佰元整');
  assert.equal(toChineseAmount('100000001'), '壹亿零壹元整');
  assert.equal(toChineseAmount('12.3'), '壹拾贰元叁角整');
  assert.equal(toChineseAmount('12.05'), '壹拾贰元零伍分');
  assert.equal(toChineseAmount('0.05'), '伍分');
  assert.equal(toChineseAmount('0'), '零元整');
  assert.equal(toChineseAmount('十二万'), null);
  assert.equal(toChineseAmount('1.234'), null);
});

// 证明材料：填写 Agent 列出材料和承诺书，程序只校验放置位置和图片，导出时在小节之后插入标题和图片。
const { renderMaterialsHtml } = require('../electron/services/technicalPlanExport.cjs');
const { defaultExportFormat } = require('../electron/services/exportFormatDefaults.cjs');

test('证明材料：校验放置位置和图片并换成节点 ID；导出 HTML 逐项另起一页、附图、缺少时待填写；转换后标题带段前分页且进大纲', async () => {
  const outline = [
    { id: 'n-perf', title: '业绩一览表', content_mode: 'template-fill' },
    { id: 'n-parent', title: '其他', children: [{ id: 'n-other', title: '其他资料', content_mode: 'template-fill' }] },
  ];
  const fields = [{ id: 'f1', name: '投标人名称', subject: '投标人', fill_by: 'ai', kind: 'text' }];
  const check = (patch) => checkBusinessTemplateFillResult(JSON.stringify({
    values: [{ name: '投标人名称', value: '甲公司' }], rows: [], unresolved: [], ...patch,
  }), groupFieldUnits(fields), new Set(['img1', 'img2']), outline);
  const messages = (patch) => check(patch).issues.map((item) => item.message).join('；');

  const result = check({
    materials: [
      { after: '1', title: '某项目合同及验收证明', basis: '评分标准“供应商实施能力”', image_ids: ['img1', 'img2', 'img1'] },
      { after: '2.1', title: '被授权人社保证明', basis: '资格要求第 5 条', image_ids: [], missing: '资信库没有授权代表的社保证明' },
    ],
    commitments: [{ after: '2.1', title: '技术要求承诺书', basis: '技术要求（二）', paragraphs: ['致：招标人', '我公司承诺：……'] }],
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.value.materials.map((item) => [item.after, item.image_ids]), [['n-perf', ['img1', 'img2']], ['n-other', []]]);
  assert.equal(result.value.commitments[0].after, 'n-other');
  assert.match(messages({ materials: [{ after: '2', title: '甲', basis: '乙', image_ids: ['img1'] }] }), /不是 投标文件目录\.md 中的目录叶子编号/);
  assert.match(messages({ materials: [{ after: '1', title: '甲', basis: '乙', image_ids: ['img9'] }] }), /图片不在资信库中：img9/);
  assert.match(messages({ materials: [{ after: '1', title: '甲', basis: '乙', image_ids: [] }] }), /没有图片，请选择资信库图片或写 missing/);
  assert.match(messages({ commitments: [{ after: '9', title: '甲', basis: '乙', paragraphs: ['丙'] }] }), /after“9”不是/);

  const images = new Map([['img1', { relativePath: 'test/a.png', originalName: '合同.png' }]]);
  const rendered = renderMaterialsHtml([
    ...result.value.materials,
    ...result.value.commitments,
  ], { level: 1, images, companyName: '甲公司' });
  assert.deepEqual([...rendered.refs], ['credential-library/test/a.png']);
  assert.equal(rendered.pendingCount, 2, '缺少和图片已删除各一处，承诺书落款日期不算缺少');
  assert.match(rendered.html, /<p>YIBIAOPAGEBREAK<\/p>\n<h2>某项目合同及验收证明<\/h2>\n<figure data-yb-size="page" data-yb-fit="contain"><img data-yb-asset-ref="credential-library\/test\/a\.png" alt="合同\.png"><\/figure>/);
  assert.match(rendered.html, /【待填写：某项目合同及验收证明：所选资信库图片已删除】/);
  // 用户在确认弹窗移除了全部图片、又没有缺少说明的材料，同样标为待填写并计数。
  const emptied = renderMaterialsHtml([{ after: 'n-perf', title: '某项目合同', basis: '评分标准', image_ids: [] }], { level: 1, images, companyName: '甲公司' });
  assert.equal(emptied.pendingCount, 1);
  assert.match(emptied.html, /【待填写：某项目合同（评分标准）】/);
  assert.match(rendered.html, /【待填写：被授权人社保证明：资信库没有授权代表的社保证明】/);
  assert.match(rendered.html, /<h2>技术要求承诺书<\/h2>\n<p>致：招标人<\/p>\n<p>我公司承诺：……<\/p>\n<p>投标人名称（公章）：甲公司<\/p>\n<p>日期：【待填写：日期】<\/p>/);

  // 真实助手转换：分页标记换成标题段前分页，标题进大纲，图片按整页尺寸嵌入。
  const imageDir = path.join(workspace, 'credential-library', 'test');
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const html = `<section data-yb-export-template="false" data-yb-export-page-template="false"><h1>业绩一览表</h1><p>正文</p>\n${rendered.html}</section>`;
  const converted = await service.createRestrictedHtmlDocx(html, defaultExportFormat, { copyAssets: true, wholeDocument: true, workspaceAssets: rendered.refs });
  const xml = new AdmZip(Buffer.from(converted.bytes)).readAsText('word/document.xml');
  assert.ok(!xml.includes('YIBIAOPAGEBREAK'), '分页标记已移除');
  const headings = [...xml.matchAll(/<w:p>(?:(?!<\/w:p>).)*?<w:outlineLvl w:val="1" \/>(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map((match) => match[0]);
  assert.equal(headings.length, 3, '两项材料和承诺书的标题都进大纲');
  assert.ok(headings.every((item) => item.includes('<w:pageBreakBefore />')), '每项另起一页');
  assert.equal(xml.split('<w:drawing>').length - 1, 1, '附上资信库图片');
});

test('整本导出分页：证明材料之后的商务章节另起一页；一级标题另起页对商务章节和范围外标题全文生效', async () => {
  // 投标书章末、资格证明书章首各有一个只承载分页的段落（模版的“附件N”去掉后留下的），声明函章首是表格。
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  samples.buildDocx(planDir, 'page-break-source.docx', [
    para('投标书'), para('投标书正文'), pageBreak,
    para('授权书'), para('授权书正文'),
    pageBreak, para('资格证明书'), para('资格证明书正文'),
    table([[cell(para('声明函内容')), cell(para(''))]]), para('声明函'),
    sectPr(),
  ].join(''));
  const chapters = [
    { id: 'b1', title: '投标书', auto_fill: true, start_block: 0, end_block: 3 },
    { id: 'b2', title: '授权书', auto_fill: true, start_block: 3, end_block: 5 },
    { id: 'b3', title: '资格证明书', auto_fill: true, start_block: 5, end_block: 8 },
    { id: 'b4', title: '声明函', auto_fill: true, start_block: 8, end_block: 10 },
  ];
  const chapter = (id, title) => `<section data-yb-business-chapter="${id}" data-yb-business-level="1" data-yb-business-title="${title}" data-yb-anchor-start="" data-yb-anchor-end="" data-yb-export-template="false" data-yb-export-page-template="business"></section>`;
  const materials = renderMaterialsHtml([{ after: 'b1', title: '投标书附件', basis: '资格要求', image_ids: [], missing: '资信库没有该材料' }], { level: 1, images: new Map(), companyName: '甲公司' });
  const html = [
    chapter('b1', '投标书'),
    `<section data-yb-export-template="false" data-yb-export-page-template="business" data-yb-materials="true">${materials.html}</section>`,
    chapter('b2', '授权书'),
    chapter('b3', '资格证明书'),
    chapter('b4', '声明函'),
    '<section data-yb-export-template="false" data-yb-export-page-template="false"><h1>附录一</h1><p>正文</p><h1>附录二</h1><p>正文</p></section>',
  ].join('\n');
  const render = async (level1PageBreak) => {
    const format = { ...defaultExportFormat, heading_level1_page_break_before: level1PageBreak };
    const converted = await service.createRestrictedHtmlDocx(html, format, {
      copyAssets: true,
      wholeDocument: true,
      businessTemplate: { input: 'technical-plan/page-break-source.docx', chapters },
    });
    const xml = new AdmZip(Buffer.from(converted.bytes)).readAsText('word/document.xml');
    const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => match[0]);
    const text = (paragraph) => [...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
    const index = (value) => paragraphs.findIndex((paragraph) => text(paragraph) === value);
    const breakBefore = (value) => paragraphs[index(value)].includes('<w:pageBreakBefore />');
    // 声明函表格前一段是不是段前分页的空段。
    const tableStart = xml.indexOf('<w:tbl>', xml.indexOf('授权书正文'));
    const beforeTable = xml.slice(xml.lastIndexOf('<w:p', tableStart), tableStart);
    return { paragraphs, index, breakBefore, tableBreak: beforeTable.includes('<w:pageBreakBefore />') && !/<w:t[ >]/.test(beforeTable) };
  };

  const off = await render(false);
  assert.ok(off.breakBefore('授权书'), '证明材料之后的章节另起一页');
  assert.ok(!off.breakBefore('资格证明书'), '开关关闭时不加段前分页');
  assert.match(off.paragraphs[off.index('资格证明书') - 1], /<w:br w:type="page" \/>/, '保留模版自带的分页段');
  assert.ok(!off.tableBreak);
  assert.ok(!off.breakBefore('附录二'));

  const on = await render(true);
  assert.ok(!on.breakBefore('投标书'), '页面组首章不加段前分页');
  assert.ok(on.breakBefore('授权书'));
  assert.ok(on.breakBefore('资格证明书'), '商务一级章节另起一页');
  assert.equal(on.paragraphs[on.index('资格证明书') - 1].includes('<w:br w:type="page" />'), false, '章首的分页段已去掉，不与段前分页叠加');
  assert.ok(on.tableBreak, '章首是表格时前插分页空段');
  assert.ok(!on.breakBefore('附录一'), '页面组首段不分页');
  assert.ok(on.breakBefore('附录二'), '样式范围外的一级标题同样另起一页');
});

test('各级标题样式全文生效：商务章节标题段和样式范围外标题套用模板标题样式，封面等前置页保持模版原样', async () => {
  samples.buildDocx(planDir, 'heading-style-source.docx', [
    para([run('投标文件', '<w:sz w:val="52"/>')], '<w:jc w:val="center"/>'), para('封面正文'),
    para('授权书', '<w:ind w:firstLine="420"/>'), para('授权书正文'),
    sectPr(),
  ].join(''));
  const chapters = [
    { id: 'c0', title: '投标文件封面', auto_fill: true, start_block: 0, end_block: 2 },
    { id: 'c1', title: '授权书', auto_fill: true, start_block: 2, end_block: 4 },
  ];
  const chapter = (id, title, number) => `<section data-yb-business-chapter="${id}" data-yb-business-level="1" data-yb-business-title="${title}"${number ? ` data-yb-outline-number="${number}"` : ''} data-yb-anchor-start="" data-yb-anchor-end="" data-yb-export-template="false" data-yb-export-page-template="business"></section>`;
  const html = [
    chapter('c0', '投标文件封面'),
    chapter('c1', '授权书', '2'),
    '<section data-yb-export-template="false" data-yb-export-page-template="false"><h1 data-yb-outline-number="3">附录</h1><p>正文</p></section>',
  ].join('\n');
  const format = {
    ...defaultExportFormat,
    headings: defaultExportFormat.headings.map((heading, index) => (index === 0
      ? { ...heading, font: '楷体', size: '三号', alignment: '左对齐', bold: true, text_color: '#FF0000', spacing_before_pt: 24, first_line_indent_chars: 2, numbering_format: 'custom', numbering_template: '第{zh}章' }
      : heading)),
  };
  const converted = await service.createRestrictedHtmlDocx(html, format, {
    copyAssets: true,
    wholeDocument: true,
    businessTemplate: { input: 'technical-plan/heading-style-source.docx', chapters },
  });
  const zip = new AdmZip(Buffer.from(converted.bytes));
  const paragraphs = [...zip.readAsText('word/document.xml').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const find = (value) => paragraphs.find((paragraph) => [...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('') === value);
  const styled = (paragraph) => paragraph.includes('w:eastAsia="楷体"') && /<w:color w:val="FF0000" ?\/>/.test(paragraph);

  const title = find('第二章 授权书');
  assert.ok(title, '商务章节标题按模板格式编号');
  assert.ok(styled(title) && /<w:sz w:val="32" ?\/>/.test(title) && /<w:b ?\/>/.test(title), '字体、字号、颜色、加粗套用一级标题样式');
  assert.match(title, /<w:jc w:val="left" ?\/>/);
  assert.match(title, /w:before="480"/);
  assert.match(title, /<w:ind w:firstLine="420" ?\/>/, '首行缩进保留模版原样');
  assert.ok(!find('授权书正文').includes('楷体'), '表单正文保持模版原样');
  assert.ok(!styled(find('投标文件')), '前置页的封面标题保持模版原样');

  const appendix = find('第三章 附录');
  assert.ok(appendix && styled(appendix), '样式范围外的标题同样套用并按模板格式编号');
  assert.doesNotMatch(appendix, /w:firstLine=/, '首行缩进按样式范围，范围外不缩进');
  assert.match(zip.readAsText('word/styles.xml'), /楷体/, 'Word 的标题样式同样取模板标题样式');
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

// 页码引用：普通字段和规则表共用换算，Agent 按原句选数字或文字写法，助手按写法生成页码域并按域代码回填。
const { convertAgentPageRefs, toAgentPageRefs, numberedNodes, createPageRefDisplay } = require('../electron/services/rulePageTables.cjs');

test('页码引用：两种写法换成节点标记并可换回，字段值校验与确认换回，预览和相邻合并，助手按写法回填页码', async () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const T = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const outline = [
    { id: A, title: '中小企业声明函', content_mode: 'template-fill' },
    { id: D, title: '残疾人声明函', content_mode: 'template-fill' },
    { id: T, title: '目录', content_mode: 'directory-generate' },
  ];
  const nodes = numberedNodes(outline);
  assert.deepEqual(convertAgentPageRefs('见{{页码:1}}；{{页码文字：2}}', nodes, '目录.md'), { value: `见{{YBPAGE:${A}}}；{{YBPAGE:${D}|text}}`, problems: [] });
  assert.match(convertAgentPageRefs('{{页码:9}}', nodes, '目录.md').problems.join(''), /目录编号不存在，编号须取自 目录\.md/);
  assert.match(convertAgentPageRefs('{{页码:3}}', nodes, '目录.md').problems.join(''), /指向投标文件目录/);
  assert.match(convertAgentPageRefs('{{其他:1}}', nodes, '目录.md').problems.join(''), /无法识别的 \{\{…\}\}/);
  assert.equal(toAgentPageRefs(`{{YBPAGE:${A}}}、{{YBPAGE:${D}|text}}`, new Map([[A, '1'], [D, '2']])), '{{页码:1}}、{{页码文字:2}}');

  // 商务填写：字段值里的引用换成标记；确认时弹窗显示的写法换回，手填数字照原样保存。
  const fields = [{ id: 'f1', name: '中小企业声明函所在页码', subject: '投标文件', fill_by: 'ai', kind: 'text' }];
  const units = groupFieldUnits(fields);
  const filled = checkBusinessTemplateFillResult(JSON.stringify({ values: [{ name: '中小企业声明函所在页码', value: '{{页码:1}}' }], rows: [], unresolved: [] }), units, new Set(), outline);
  assert.deepEqual(filled.issues, []);
  assert.deepEqual(filled.value.entries.f1, { value: `{{YBPAGE:${A}}}` });
  assert.match(checkBusinessTemplateFillResult(JSON.stringify({ values: [{ name: '中小企业声明函所在页码', value: '{{页码:9}}' }], rows: [], unresolved: [] }), units, new Set(), outline).issues[0].message, /“中小企业声明函所在页码”：页码引用 \{\{页码:9\}\} 中的目录编号不存在/);
  assert.deepEqual(buildConfirmedEntries(fields, [{ key: units[0].key, value: '{{页码文字:2}}' }], outline).f1, { value: `{{YBPAGE:${D}|text}}` });
  assert.deepEqual(buildConfirmedEntries(fields, [{ key: units[0].key, value: '12' }], outline).f1, { value: '12' });

  // 预览显示小节标题；导出时只合并同一写法的相邻小节。
  assert.equal(createPageRefDisplay(outline)(`第{{YBPAGE:${A}}}页`), '第〔页码：中小企业声明函〕页');
  const exportDisplay = createPageRefDisplay(outline, { forExport: true });
  assert.equal(exportDisplay(`{{YBPAGE:${A}|text}}、{{YBPAGE:${D}|text}}`), `{{YBPAGE:${A}:${D}|text}}`);
  assert.equal(exportDisplay(`{{YBPAGE:${A}}}、{{YBPAGE:${D}|text}}`), `{{YBPAGE:${A}}}、{{YBPAGE:${D}|text}}`);

  // 真实助手：数字写法和文字写法分别生成 IF 域，回填后为“3-5”“第3页至第5页”，起止相同时为“3”“第3页”。
  const html = `<section data-yb-export-template="false" data-yb-export-page-template="false"><p>YIBIAOANCHOR:S:${A}</p><h1>中小企业声明函</h1><p>声明内容</p><p>YIBIAOANCHOR:E:${A}</p><p>数字：见第{{YBPAGE:${A}}}页。</p><p>文字：见{{YBPAGE:${A}|text}}。</p></section>`;
  const converted = await service.createRestrictedHtmlDocx(html, defaultExportFormat, { copyAssets: true, wholeDocument: true });
  assert.equal(converted.pageRefs?.count, 2);
  const bookmark = (prefix) => `${prefix}${A.replace(/-/g, '')}`;
  // 段落的显示文字：域外文字和最外层域的结果，嵌套 PAGEREF 属于域代码，不计入。
  const visibleText = (paragraph) => {
    const stack = [];
    let text = '';
    for (const match of paragraph.matchAll(/<w:fldChar w:fldCharType="(begin|separate|end)"|<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)) {
      if (match[1] === 'begin') stack.push({ result: false });
      else if (match[1] === 'separate') stack.at(-1).result = true;
      else if (match[1] === 'end') stack.pop();
      else if (!stack.length || (stack.length === 1 && stack[0].result)) text += match[2];
    }
    return text;
  };
  const resultText = async (start, end) => {
    const output = await service.fillTocPageNumbers(Buffer.from(converted.bytes), null, { [bookmark('_YbPS')]: start, [bookmark('_YbPE')]: end });
    assert.equal(output.refMissingCount, 0);
    const xml = new AdmZip(Buffer.from(output.bytes)).readAsText('word/document.xml');
    return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => visibleText(match[0])).filter((text) => /^(数字|文字)/.test(text));
  };
  assert.deepEqual(await resultText('3', '5'), ['数字：见第3-5页。', '文字：见第3页至第5页。']);
  assert.deepEqual(await resultText('3', '3'), ['数字：见第3页。', '文字：见第3页。']);
});

// 资信库企业资料补充字段：填写 Agent 的资信库输入带上有值的新字段，空值不输出。
test('资信库输入：邮编、传真、法定代表人身份证号和上年度规模指标有值时输出，空值不输出', () => {
  const { buildCredentialLibraryInput } = require('../electron/services/businessTemplateFillTask.cjs');
  const input = buildCredentialLibraryInput({
    profile: {
      companyName: '甲公司', phone: '021-1', fax: '021-2', postalCode: '200000', legalRepresentative: '张三',
      legalRepresentativeIdNumber: '110101198001011234', lastYearEmployeeCount: '86', lastYearRevenue: '1200', lastYearTotalAssets: '',
    },
  });
  assert.deepEqual(Object.entries(input.基本信息).filter(([key]) => /传真|邮政编码|身份证号|上年度/.test(key)), [
    ['传真', '021-2'],
    ['邮政编码', '200000'],
    ['法定代表人身份证号', '110101198001011234'],
    ['上年度从业人员（人）', '86'],
    ['上年度营业收入（万元）', '1200'],
  ]);
});
