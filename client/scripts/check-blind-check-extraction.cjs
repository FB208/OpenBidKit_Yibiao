// 暗标格式要求提取验证：用假的 AI 服务返回固定 JSON，不产生调用费用。
// 覆盖格式条款定位、字段类型转换与范围校验、原文依据核对、未要求项设为不检查，以及提取任务的成功与失败路径。
// 用法（client 目录）：node --test scripts/check-blind-check-extraction.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildExtractedProfile, findOmissions, locateFormatExcerpts, normalizeExtraction } = require('../electron/services/blindCheckPresetExtraction.cjs');
const { runBlindCheckPresetExtractionTask } = require('../electron/services/blindCheckPresetExtractionTask.cjs');

const filler = (count, text) => Array.from({ length: count }, (_, index) => `${text}第${index + 1}条，内容为一般性约定。`).join('\n');

// 合成招标文件：前面是大量无关条款，中间一段格式要求，后面是评分办法。
const TENDER = [
  '第一章 招标公告',
  filler(120, '投标人资格要求'),
  '附表七：施工组织设计（技术暗标部分）编制要求',
  '1、纸张要求：标准A4纸张。',
  '2、排版要求：暗标文件页面行距为固定值28磅，页边距四边均为2厘米。不编制页码、页眉、页脚。',
  '3、一级标题采用三号宋体加粗；正文部分（包含二级及以下标题）字体采用四号宋体，不得做加粗、倾斜等处理，首行缩进2个字符。',
  '4、图表内文字采用黑色五号宋体，图表使用黑白线条。',
  '5、正文中各段落、图表间不允许留有空行。',
  filler(120, '评标办法'),
].join('\n');

function fakeAi(response, calls = []) {
  return {
    async collectJsonResponse(request) {
      calls.push(request);
      return typeof response === 'function' ? response(request) : response;
    },
  };
}

const AI_RESULT = {
  fields: {
    'page.paper': { value: 'A4纸', evidence: '纸张要求：标准A4纸张' },
    'page.margin_top_cm': { value: '2厘米', evidence: '页边距四边均为2厘米' },
    'page.margin_bottom_cm': { value: 2, evidence: '页边距四边均为2厘米' },
    'page.margin_left_cm': { value: '20毫米', evidence: '页边距四边均为2厘米' },
    'page.margin_right_cm': { value: 2, evidence: '页边距四边均为2厘米' },
    'body.font_cn': { value: '宋体', evidence: '正文部分（包含二级及以下标题）字体采用四号宋体' },
    'body.size_pt': { value: '四号', evidence: '正文部分（包含二级及以下标题）字体采用四号宋体' },
    'body.line_pt': { value: '28磅', evidence: '暗标文件页面行距为固定值28磅' },
    'body.first_line_indent_chars': { value: 2, evidence: '首行缩进2个字符' },
    'body.allow_bold': { value: false, evidence: '不得做加粗、倾斜等处理' },
    'body.allow_italic': { value: '否', evidence: '不得做加粗、倾斜等处理' },
    'headings.1.size_pt': { value: '三号', evidence: '一级标题采用三号宋体加粗' },
    'headings.1.bold': { value: true, evidence: '一级标题采用三号宋体加粗' },
    'headings.2.size_pt': { value: '小四', evidence: '这句原文里并不存在' },
    'table.size_pt': { value: '五号', evidence: '图表内文字采用黑色五号宋体' },
    'structure.page_number': { value: 'forbid', evidence: '不编制页码、页眉、页脚' },
    'structure.check_empty_paragraphs': { value: true, evidence: '各段落、图表间不允许留有空行' },
    'image.check_color': { value: true, evidence: '图表使用黑白线条' },
    'body.size_pt_extra': { value: 1, evidence: '' },
    'table.first_line_indent_chars': { value: 99, evidence: '首行缩进' },
  },
  manual: ['图表居中放置，所有边框采用0.5磅黑色单实直线'],
  notes: '',
};

test('定位格式条款：只取格式要求所在片段，没有格式词时返回空', () => {
  const located = locateFormatExcerpts(TENDER);
  assert.ok(located.text.includes('附表七'), located.text.slice(0, 200));
  assert.ok(located.text.includes('一级标题采用三号宋体加粗'));
  assert.ok(located.text.length < TENDER.length / 3, `只发送片段：${located.text.length} / ${TENDER.length}`);
  assert.equal(locateFormatExcerpts(filler(200, '无关条款')).text, '');
});

test('结果校验：号数换算、单位换算、范围与未知字段丢弃、原文依据核对、行距类型推断', () => {
  const extraction = normalizeExtraction(AI_RESULT, TENDER);
  const value = (fieldPath) => extraction.fields[fieldPath]?.value;
  assert.equal(value('page.paper'), 'A4');
  assert.equal(value('page.margin_left_cm'), 2, '20 毫米换算成 2 厘米');
  assert.equal(value('body.size_pt'), 14);
  assert.equal(value('headings.1.size_pt'), 16);
  assert.equal(value('headings.2.size_pt'), 12, '小四先于四号判断');
  assert.equal(value('table.size_pt'), 10.5);
  assert.equal(value('body.line_pt'), 28);
  assert.equal(value('body.line_rule'), 'exact', '只给磅值时按固定值');
  assert.equal(value('body.allow_italic'), false);
  assert.equal(value('table.first_line_indent_chars'), undefined, '超出范围丢弃');
  assert.ok(extraction.dropped.some((item) => item.startsWith('body.size_pt_extra')));
  assert.ok(extraction.dropped.some((item) => item.startsWith('table.first_line_indent_chars')));
  assert.equal(extraction.fields['body.size_pt'].verified, true, '原文换行不影响核对');
  assert.equal(extraction.fields['headings.2.size_pt'].verified, false, '原文中不存在的依据标为未核对通过');
  assert.deepEqual(extraction.manual, ['图表居中放置，所有边框采用0.5磅黑色单实直线']);
});

test('号数换算："小四号""小三号""小五号"按小号换算，不被"四号"等抢先匹配', () => {
  const extraction = normalizeExtraction({
    fields: {
      'body.size_pt': { value: '小四号', evidence: '' },
      'headings.1.size_pt': { value: '小三号', evidence: '' },
      'table.size_pt': { value: '小五号宋体', evidence: '' },
      'headings.2.size_pt': { value: '四号', evidence: '' },
    },
  }, TENDER);
  const value = (fieldPath) => extraction.fields[fieldPath]?.value;
  assert.equal(value('body.size_pt'), 12);
  assert.equal(value('headings.1.size_pt'), 15);
  assert.equal(value('table.size_pt'), 9);
  assert.equal(value('headings.2.size_pt'), 14);
});

test('生成预设档案：提取到的项填入，招标文件未要求的格式项设为不检查，身份类检查保持开启', () => {
  const { profile, unspecified } = buildExtractedProfile(normalizeExtraction(AI_RESULT, TENDER));
  assert.equal(profile.body.size_pt, 14);
  assert.equal(profile.body.line_rule, 'exact');
  assert.equal(profile.body.allow_bold, false);
  assert.equal(profile.headings['1'].bold, true);
  assert.equal(profile.page.margin_top_cm, 2);
  assert.equal(profile.body.alignment, null);
  assert.equal(profile.body.space_before_pt, null, '未要求的段前设为不检查');
  assert.equal(profile.headings['3'].size_pt, null);
  assert.equal(profile.table.font_cn, null);
  assert.equal(profile.structure.page_number, 'forbid');
  assert.equal(profile.structure.check_empty_paragraphs, true);
  assert.equal(profile.image.check_color, true);
  assert.equal(profile.privacy.check_company_suffix, true, '身份信息检查保持默认开启');
  assert.ok(unspecified.includes('body.alignment') && unspecified.includes('headings.3.size_pt'));
  assert.ok(!unspecified.includes('body.size_pt'));
});

test('页码三态："页脚只准出现页码"为 footer_only，允许编页码为不限，招标文件没提时不检查', () => {
  const tender = '不允许出现页眉，页脚只准出现页码，页码采用阿拉伯数字格式。';
  const extract = (value) => normalizeExtraction({ fields: { 'structure.page_number': { value, evidence: '页脚只准出现页码' } } }, tender);
  assert.equal(extract('footer_only').fields['structure.page_number'].value, 'footer_only');
  assert.equal(extract('页脚只准出现页码').fields['structure.page_number'].value, 'footer_only');
  assert.equal(extract('不得出现页码').fields['structure.page_number'].value, 'forbid');
  assert.equal(extract('any').fields['structure.page_number'].value, null, '允许编页码在预设里是不限');

  const footerOnly = buildExtractedProfile(extract('footer_only'));
  assert.equal(footerOnly.profile.structure.page_number, 'footer_only');
  assert.ok(!footerOnly.unspecified.includes('structure.page_number'));
  const missing = buildExtractedProfile(normalizeExtraction({ fields: {} }, tender));
  assert.equal(missing.profile.structure.page_number, null, '没提页码时不沿用内置预设的"不得有页码"');
  assert.ok(missing.unspecified.includes('structure.page_number'));
});

test('开关项：招标文件没写的文字效果、页眉页脚、空行、纸张设为不检查，写了的按双向取值', () => {
  const tender = '正文不得加粗，标题可以加粗。页眉须注明项目名称。';
  const extraction = normalizeExtraction({
    fields: {
      'body.allow_bold': { value: false, evidence: '正文不得加粗' },
      'headings.1.bold': { value: true, evidence: '标题可以加粗' },
      'structure.forbid_header_content': { value: false, evidence: '页眉须注明项目名称' },
    },
  }, tender);
  const { profile, unspecified } = buildExtractedProfile(extraction);
  assert.equal(profile.body.allow_bold, false);
  assert.equal(profile.structure.forbid_header_content, false);
  for (const fieldPath of ['body.allow_italic', 'body.allow_underline', 'body.allow_color', 'body.allow_highlight', 'structure.forbid_footer_content', 'structure.check_empty_paragraphs', 'page.paper']) {
    const [section, key] = fieldPath.split('.');
    assert.equal(profile[section][key], null, `${fieldPath} 没写时不检查`);
    assert.ok(unspecified.includes(fieldPath), `${fieldPath} 列入招标文件未要求`);
  }
  assert.equal(profile.table.allow_bold, null, '表格加粗默认同正文');
  assert.ok(Object.values(extraction.fields).every((item) => item.verified), JSON.stringify(extraction.fields));
});

test('依据自检：依据在原文里但取值方向不一致时标为未核对通过并写明原因；人工核对条款关联相关检查项', () => {
  const tender = '页脚只准出现页码，页码采用阿拉伯数字格式。正文为小四号宋体，首行缩进两个字符。';
  const extraction = normalizeExtraction({
    fields: {
      'structure.page_number': { value: 'forbid', evidence: '页脚只准出现页码' },
      'body.allow_bold': { value: false, evidence: '正文为小四号宋体' },
      'body.size_pt': { value: '四号', evidence: '正文为小四号宋体' },
      'body.first_line_indent_chars': { value: 2, evidence: '首行缩进两个字符' },
      'body.font_cn': { value: '宋体', evidence: '正文为小四号宋体' },
    },
    manual: ['页脚只准出现页码，页码采用阿拉伯数字格式，设在页脚对中位置', '图表居中放置'],
  }, tender);
  const fields = extraction.fields;
  assert.equal(fields['structure.page_number'].verified, false);
  assert.match(fields['structure.page_number'].issue, /不得有页码/);
  assert.equal(fields['body.allow_bold'].verified, false);
  assert.match(fields['body.allow_bold'].issue, /不允许/);
  assert.equal(fields['body.size_pt'].verified, true, '"小四号"里含"四号"，宽松判断不报');
  assert.equal(fields['body.first_line_indent_chars'].verified, true, '中文数字"两"也算提到');
  assert.equal(fields['body.font_cn'].verified, true);
  assert.deepEqual(extraction.manualFields, [['structure.page_number', 'structure.forbid_footer_content'], []]);
});

test('漏提检测：格式片段里提到、但字段和人工核对条款都没覆盖的要求列出原句；"不作要求"和已覆盖的不算', () => {
  const excerpt = [
    '①字体、字号：所有标题及正文均为宋体小四号字，数字、英文字符（包括单位）不做要求，均不得加黑、加粗、倾斜及添加字符底纹；',
    '标题序号以阿拉伯数字编排，一级为1、2、3…；二级为1.1、1.2…',
    '下划线不作要求。',
    '目录一律使用中文宋体、小四号。',
  ].join('\n');
  const extraction = normalizeExtraction({
    fields: {
      'body.allow_bold': { value: false, evidence: '均不得加黑、加粗、倾斜及添加字符底纹' },
      'body.allow_italic': { value: false, evidence: '均不得加黑、加粗、倾斜及添加字符底纹' },
    },
    manual: ['目录一律使用中文宋体、小四号'],
  }, excerpt);
  const omissions = findOmissions(excerpt, extraction);
  assert.deepEqual(omissions.map((item) => item.topic), ['字符底纹', '标题序号'], JSON.stringify(omissions));
  assert.match(omissions[0].sentence, /添加字符底纹/);
  assert.deepEqual(omissions[0].fields, ['body.allow_highlight']);

  const numbered = normalizeExtraction({ fields: { 'structure.heading_numbering': { value: 'arabic', evidence: '标题序号以阿拉伯数字编排' } } }, excerpt);
  assert.equal(numbered.fields['structure.heading_numbering'].value, 'arabic');
  assert.equal(numbered.fields['structure.heading_numbering'].verified, true);
  assert.equal(buildExtractedProfile(numbered).profile.structure.heading_numbering, 'arabic');
  assert.ok(!findOmissions(excerpt, numbered).some((item) => item.topic === '标题序号'), '提取到字段后不再列出');
  assert.equal(buildExtractedProfile(extraction).profile.structure.heading_numbering, null, '没提到时不检查');
});

function fakeStore(overrides = {}) {
  const created = [];
  return {
    created,
    readTechnicalPlanTender: () => ({ fileName: '某项目招标文件.pdf', content: TENDER }),
    parseTenderFile: async () => ({ fileName: '选择的招标文件.pdf', content: TENDER }),
    createExtractedPreset: (input) => {
      created.push(input);
      return { id: 'preset-ai', name: '某项目招标文件（AI 提取）' };
    },
    ...overrides,
  };
}

async function runTask({ aiService, workspaceStore, payload = { source: 'technical-plan' } }) {
  const checkpoints = [];
  const updates = [];
  await runBlindCheckPresetExtractionTask({
    aiService,
    workspaceStore,
    payload,
    updateTask: (task) => updates.push(task),
    checkpointTask: (task) => checkpoints.push(task),
    taskControl: { signal: new AbortController().signal },
  });
  return { checkpoints, updates };
}

test('提取任务：只把片段发给 AI，生成新预设并记录出处', async () => {
  const calls = [];
  const workspaceStore = fakeStore();
  const { checkpoints, updates } = await runTask({ aiService: fakeAi(AI_RESULT, calls), workspaceStore, payload: { source: 'file', filePath: 'D:/招标文件.pdf' } });
  assert.equal(calls.length, 1, '只调用一次 AI');
  const userMessage = calls[0].messages.at(-1).content;
  assert.ok(userMessage.includes('附表七') && !userMessage.includes('评标办法第100条'), '只发送格式条款片段');
  assert.deepEqual(checkpoints.map((item) => item.status), ['running', 'success']);
  assert.equal(checkpoints.at(-1).stats.presetId, 'preset-ai');
  assert.equal(checkpoints.at(-1).stats.unverified, 1);
  assert.ok(updates.some((item) => item.logs.at(-1).startsWith('AI 正在提取格式要求')));
  const [input] = workspaceStore.created;
  assert.equal(input.tenderName, '选择的招标文件.pdf');
  assert.equal(input.profile.body.size_pt, 14);
  assert.equal(input.source.fields['headings.2.size_pt'].verified, false);
  assert.ok(input.source.unspecified.includes('body.alignment'));
  assert.deepEqual(input.source.manual, AI_RESULT.manual);
});

test('提取任务：招标文件没有格式条款时不调用 AI；AI 没提取到任何字段时报错', async () => {
  const calls = [];
  const noFormat = fakeStore({ readTechnicalPlanTender: () => ({ fileName: '无格式.pdf', content: filler(300, '无关条款') }) });
  await assert.rejects(runTask({ aiService: fakeAi(AI_RESULT, calls), workspaceStore: noFormat }), /未在招标文件中找到技术标排版要求/);
  assert.equal(calls.length, 0, '没有格式条款时不产生 AI 费用');
  const store = fakeStore();
  await assert.rejects(runTask({ aiService: fakeAi({ fields: { 'body.size_pt': { value: '不作要求' } } }), workspaceStore: store }), /未从招标文件片段中提取到可检查的格式要求/);
  assert.equal(store.created.length, 0, '提取失败时不生成预设');
});
