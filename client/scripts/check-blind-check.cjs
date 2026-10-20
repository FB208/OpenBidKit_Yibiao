// 暗标合规检查端到端验证：在系统临时目录的中文路径下手工构造 docx 样本，
// 经 openXmlHelperService.runBlindCheck 调用真实的 OpenXmlHelper，断言各规则的命中与不命中。
// 用法（client 目录）：node --test scripts/check-blind-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { normalizeProfile, listBuiltinPresets } = require('../electron/services/blindCheckPresets.cjs');
const samples = require('./blind-check-samples.cjs');

const { cell, emfWithText, imagePara, jpegWithExif, para, pngWithAuthor, run, sectPr, table, wmfWithAnsiText } = samples;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), '暗标检查验证-'));
const workspace = path.join(userData, 'workspace');
const sourceDir = path.join(workspace, 'blind-check', 'source');
const app = { isPackaged: false, getPath: () => userData, getAppPath: () => path.join(__dirname, '..') };
let service;

function buildDocx(fileName, body, extra = {}) {
  return samples.buildDocx(sourceDir, fileName, body, extra);
}

async function inspect(source, { profile = {}, words = [], imageFacts = [] } = {}) {
  return service.runBlindCheck({ source, profile: normalizeProfile(profile), sensitive_words: words, image_facts: imageFacts });
}

function messagesOf(report, ruleId) {
  return groupsOf(report, ruleId).map((group) => `${group.message}×${group.count}`);
}

function groupsOf(report, ruleId) {
  return report.groups.filter((group) => group.rule_id === ruleId);
}

function hasMessage(report, ruleId, pattern) {
  return groupsOf(report, ruleId).some((group) => (pattern instanceof RegExp ? pattern.test(group.message) : group.message === pattern));
}

/** 按校验算法生成合法的统一社会信用代码和身份证号，避免样本自身不合法。 */
function withCreditCodeCheck(base) {
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const total = [...base].reduce((sum, char, index) => sum + chars.indexOf(char) * weights[index], 0);
  const check = 31 - (total % 31);
  return base + chars[check === 31 ? 0 : check];
}

function withIdCheck(base) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const total = [...base].reduce((sum, char, index) => sum + Number(char) * weights[index], 0);
  return base + '10X98765432'[total % 11];
}

before(() => {
  service = createOpenXmlHelperService({ app });
});

after(async () => {
  await service?.close();
  await service?.closeBlindCheck();
  fs.rmSync(userData, { recursive: true, force: true });
});

test('预设规范：未知字段丢弃、数值收紧、null 表示不检查、内置预设可用', () => {
  const profile = normalizeProfile({ body: { size_pt: 999, line_rule: '固定值', font_cn: 'null', first_line_indent_chars: null }, unknown: { a: 1 }, rules: { 'font.bold': { enabled: false, severity: 'x' }, 'no.such': { enabled: false } } });
  assert.equal(profile.body.size_pt, 72);
  assert.equal(profile.body.line_rule, 'exact');
  assert.equal(profile.body.first_line_indent_chars, null);
  assert.equal(profile.unknown, undefined);
  assert.deepEqual(profile.rules, { 'font.bold': { enabled: false } });
  const presets = listBuiltinPresets();
  assert.equal(presets.length, 4);
  assert.equal(presets.find((item) => item.id === 'builtin-hebei').profile.table.size_pt, 14);
});

test('格式继承：主题字体、样式缩进、表格样式字号求值后不误报', async () => {
  const body = [
    para([run('这是一段正文内容，字体来自主题，字号来自文档默认值。', '<w:rFonts w:hint="eastAsia"/>')]),
    para('第二段正文，首行缩进来自正文样式，行距来自文档默认段落格式。'),
    table([[cell(para([run('表格内容')], '<w:ind w:firstLineChars="0" w:firstLine="0"/>')), cell(para('第二列', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'))]], 'TableGrid'),
    para('表格后的正文段落。'),
    sectPr(),
  ].join('');
  const report = await inspect(buildDocx('继承无误报.docx', body));
  assert.deepEqual(report.groups.map((group) => `${group.rule_id}:${group.message}`), []);
  assert.equal(report.summary.total, 0);
  assert.equal(report.stats.tables, 1);
});

test('格式违规：字体、字号、行距、缩进、加粗颜色高亮、标点空格换行、表格与页面', async () => {
  const body = [
    para([run('字号是小四的正文。', '<w:sz w:val="24"/>')]),
    para([run('这一段用了黑体。', '<w:rFonts w:eastAsia="黑体"/>')]),
    para('这一段是多倍行距。', '<w:spacing w:line="360" w:lineRule="auto"/>'),
    para('这一段没有首行缩进。', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'),
    para([run('这一段'), run('加粗了', '<w:b/>'), run('。')]),
    para([run('红色文字', '<w:color w:val="FF0000"/>')]),
    para([run('高亮文字', '<w:highlight w:val="yellow"/>')]),
    para('本项目,包括以下内容。'),
    para('版本v1.2，圆周率3.14，金额1,000元，时间12:30，网址见附件。'),
    para('中文 中文之间有空格。'),
    para('第一章 施工组织设计'),
    para('1.1 编制依据'),
    para('（一） 工程概况'),
    para(['<w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r>']),
    para(''),
    para('第 3 页'),
    para([run('可见文字'), run('隐藏内容', '<w:vanish/>')]),
    table([
      [cell(para([run('表格字号错误', '<w:sz w:val="24"/>')]), '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>'), cell(table([[cell(para('嵌套')), cell(para('表格'))]], 'TableGrid'))],
    ], 'LightShading'),
    para('结尾段落。'),
    sectPr({ left: 1134, cols: 2 }),
  ].join('');
  const report = await inspect(buildDocx('格式违规.docx', body));
  const expected = [
    ['font.size', '字号不是四号（14磅）'],
    ['font.chinese', '中文字体不是宋体'],
    ['para.line_spacing', '行距未设为固定值'],
    ['para.first_line_indent', '首行缩进不符合要求'],
    ['font.bold', '正文使用了加粗'],
    ['font.color', '文字不是黑色'],
    ['font.highlight', '文字带突出显示（高亮）'],
    ['text.english_punct', '中文内容中使用了英文标点（,）'],
    ['text.spaces', /中文字符间空格/],
    ['text.linebreak', '存在手动换行符'],
    ['struct.empty_paragraph', '存在空段落'],
    ['struct.page_number_text', '正文中出现页码文字'],
    ['text.hidden', '存在隐藏文字'],
    ['table.size', '表格内字号不是五号（10.5磅）'],
    ['table.shading', '单元格存在彩色底纹'],
    ['table.style', '表格套用了带格式的表格样式'],
    ['table.nested', '存在嵌套表格'],
    ['page.margins', '左边距不符合要求'],
    ['page.columns', '存在分栏排版'],
  ];
  for (const [ruleId, message] of expected) {
    assert.ok(hasMessage(report, ruleId, message), `缺少 ${ruleId} ${message}；实际：${JSON.stringify(report.groups.map((group) => `${group.rule_id}:${group.message}`))}`);
  }
  assert.equal(groupsOf(report, 'text.english_punct').reduce((sum, group) => sum + group.count, 0), 1, '数字、版本号、千分位、时间里的标点不应报');
  const spaceTexts = groupsOf(report, 'text.spaces').flatMap((group) => group.samples.map((sample) => sample.text));
  assert.ok(!spaceTexts.some((text) => /^(第一章|1\.1|（一）)/.test(text)), `章节和列表编号后的空格不应报：${JSON.stringify(spaceTexts)}`);
  const sizeGroup = groupsOf(report, 'font.size')[0];
  assert.match(sizeGroup.samples[0].where, /正文第 1 段/);
  assert.match(sizeGroup.samples[0].origin, /直接格式/);
});

test('匿名性：敏感词、自称、企业名、联系方式、证件号、网址、占位符、页眉、批注、修订、域、文档属性', async () => {
  const creditCode = withCreditCodeCheck('91110108MA01B2C3D');
  const idNumber = withIdCheck('11010519491231002');
  const body = [
    para('我公司承诺按期完工，配合供电公司验收，设备出厂前完成检验。'),
    para('本项目由北京华夏建设有限公司实施，分包单位为上海联创科技有限公司。'),
    para(`联系电话 13812345678，统一社会信用代码 ${creditCode}，身份证 ${idNumber}。`),
    para('邮箱 abc@huaxia.com，官网 www.huaxia.com，政府采购网 www.ccgp.gov.cn。'),
    para('投标人：【填写】'),
    `<w:p><w:hyperlink r:id="rIdLink1"><w:r><w:t>点击访问</w:t></w:r></w:hyperlink></w:p>`,
    `<w:p><w:ins w:id="1" w:author="张三" w:date="2026-01-01T00:00:00Z"><w:r><w:t>插入的修订内容</w:t></w:r></w:ins></w:p>`,
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> AUTHOR </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>张三</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    `<w:p><w:r><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>文本框里写着我司的名字</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`,
    sectPr({ headerRid: 'rIdHeader1' }),
  ].join('');
  const header = `${para('华夏建设投标文件')}<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const source = buildDocx('匿名性.docx', body, {
    header,
    comments: `<w:comment w:id="0" w:author="李四"><w:p><w:r><w:t>请修改</w:t></w:r></w:p></w:comment>`,
    hyperlinks: { rIdLink1: 'https://www.huaxia.com/' },
    core: '<dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy>',
    app: '<Template>Normal.dotm</Template><Company>华夏建设</Company>',
  });
  const report = await inspect(source, { words: [{ text: '华夏建设', source: 'credential' }] });
  const privacy = groupsOf(report, 'privacy.keyword').map((group) => group.message);
  for (const message of [
    '出现敏感词「华夏建设」', '出现自称「我公司」', '出现自称「我司」', '出现企业名称「上海联创科技有限公司」', '出现手机号「13812345678」',
    `出现统一社会信用代码「${creditCode}」`, `出现身份证号「${idNumber}」`, '出现邮箱地址「abc@huaxia.com」', '残留未填写的占位符「【填写】」',
  ]) {
    assert.ok(privacy.includes(message), `缺少 ${message}；实际：${JSON.stringify(privacy)}`);
  }
  assert.ok(privacy.some((message) => message.startsWith('出现网址「www.huaxia.com')), JSON.stringify(privacy));
  assert.ok(!privacy.some((message) => /供电公司|出厂|ccgp/.test(message)), `第三方机构、普通用语和政府网站不应报：${JSON.stringify(privacy)}`);
  assert.ok(!privacy.includes('出现企业名称「北京华夏建设有限公司」'), '已被敏感词覆盖的企业名不重复报');
  const textbox = groupsOf(report, 'privacy.keyword').find((group) => group.message === '出现自称「我司」');
  assert.ok(textbox.samples.some((sample) => sample.where.startsWith('文本框')), '文本框内容也要检查');
  for (const [ruleId, message] of [
    ['struct.header_footer', '页眉存在内容'],
    ['struct.header_footer', '页眉中存在页码'],
    ['struct.comment', '文档残留批注'],
    ['struct.revision', '存在未接受的修订'],
    ['struct.field', '存在可能泄露身份的域代码'],
    ['struct.hyperlink', '存在外部超链接'],
    ['struct.doc_props', '文档属性中残留「作者」'],
    ['struct.doc_props', '文档属性中残留「最后修改者」'],
    ['struct.doc_props', '文档属性中残留「单位」'],
    ['struct.textbox', '文档中存在文本框'],
  ]) {
    assert.ok(hasMessage(report, ruleId, message), `缺少 ${ruleId} ${message}`);
  }
  assert.ok(!hasMessage(report, 'struct.doc_props', '文档属性中残留模板名称'), '默认模板 Normal.dotm 不应报');
  assert.ok(report.summary.high > 0);
});

test('目录与标题：按目录认标题，编号样式的正文列表项不当标题；标题按标题目标检查', async () => {
  const titles = ['第一章 施工组织设计', '第二章 质量保证措施', '第三章 安全文明施工'];
  const tocEntry = (title, page) => para([run(title), '<w:r><w:tab/></w:r>', run(String(page))], '<w:pStyle w:val="10"/>');
  const body = [
    '<w:p><w:pPr><w:pStyle w:val="10"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + `${run(titles[0])}<w:r><w:tab/></w:r>${run('1')}</w:p>`,
    tocEntry(titles[1], 5),
    `<w:p><w:pPr><w:pStyle w:val="10"/></w:pPr>${run(titles[2])}<w:r><w:tab/></w:r>${run('9')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    para([run(titles[0], '<w:sz w:val="28"/>')], '<w:pStyle w:val="1"/>'),
    para('（1）施工准备工作按计划推进，本条是正文列表项。'),
    para(titles[1], '<w:pStyle w:val="1"/>'),
    para('正文内容。'),
    para(titles[2], '<w:pStyle w:val="1"/>'),
    para('正文内容。'),
    sectPr(),
  ].join('');
  const report = await inspect(buildDocx('目录标题.docx', body));
  assert.equal(report.stats.toc_entries, 3);
  assert.equal(report.stats.headings, 3);
  assert.equal(report.stats.heading_sources.toc, 3);
  const size = groupsOf(report, 'font.size');
  assert.equal(size.length, 1, JSON.stringify(report.groups.map((group) => `${group.rule_id}:${group.message}`)));
  assert.equal(size[0].message, '字号不是三号（16磅）');
  assert.equal(size[0].count, 1, '只有第一章标题字号不对');
});

test('二期预设字段：旧预设缺字段时按默认值补齐，新开关默认关闭', () => {
  const profile = normalizeProfile({ body: { font_cn: '仿宋' } });
  assert.equal(profile.body.font_cn, '仿宋');
  assert.equal(profile.image.check_color, false);
  assert.equal(profile.image.check_vector, true);
  assert.equal(profile.consistency.heading_max_chars, 60);
  assert.equal(profile.table.alignment, null);
  for (const value of [profile.page.check_sections, profile.body.check_snap_to_grid, profile.body.check_vert_align, profile.table.check_merge,
    profile.structure.check_bookmarks, profile.text.check_halfwidth_brackets, profile.text.check_fullwidth_digits, profile.text.check_fullwidth_letters]) {
    assert.equal(value, false);
  }
  assert.equal(normalizeProfile({ table: { alignment: 'both' } }).table.alignment, null, '表格对齐只认左、中、右');
  assert.equal(normalizeProfile({ consistency: { heading_max_chars: null } }).consistency.heading_max_chars, 60);
});

/** 一致性样本：标题来自标题样式（无目录），正文字体字号对齐方式未设固定值时由一致性规则兜底。 */
function consistencyDocx() {
  const heading = (level, text, rPr = '') => para([run(text, rPr)], `<w:pStyle w:val="${level}"/>`);
  const normal = Array.from({ length: 22 }, (_, index) => para(`第${index + 1}段正文内容，描述施工组织的具体安排。`));
  const body = [
    heading(1, '第一章 总则'),
    heading(2, '1.1 编制依据'),
    heading(2, '1.2 编制原则'),
    ...normal.slice(0, 11),
    para('本段居中显示，用于验证对齐少数派。', '<w:jc w:val="center"/>'),
    para([run('本段整体使用黑体书写。', '<w:rFonts w:eastAsia="黑体"/>')]),
    heading(1, '第二章 施工方案', '<w:sz w:val="24"/>'),
    heading(3, '2.1.1 准备工作'),
    heading(2, '2.1 施工部署'),
    para([run('本段字号设为小四。', '<w:sz w:val="24"/>')]),
    para([run('本段大部分是宋体内容，'), run('少量楷体', '<w:rFonts w:eastAsia="楷体"/>')]),
    para([run('本项目采用'), run('BIM', '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>'), run('技术进行管理。')]),
    heading(2, '2.3 进度计划'),
    ...normal.slice(11),
    heading(1, '第四章 质量保证'),
    heading(1, '第四章 安全措施'),
    heading(1, '第五章'),
    heading(2, `5.1 ${'施工现场环境保护与文明施工管理措施'.repeat(4)}`),
    sectPr(),
  ].join('');
  return buildDocx('一致性.docx', body);
}

test('一致性：未设固定值时按多数找少数派，标题编号只报跳号和重号，西文字体不算正文字体不统一', async () => {
  const source = consistencyDocx();
  const report = await inspect(source, { profile: { body: { font_cn: null, size_pt: null }, headings: { 1: { size_pt: null }, 2: { size_pt: null } } } });
  const expected = {
    'consistency.body_format': ['正文中文字体与多数段落不一致×1', '正文字号与多数段落不一致×1', '正文对齐方式与多数段落不一致×1'],
    'consistency.mixed_fonts': ['段内混用多种中文字体×1'],
    'consistency.heading_format': ['1 级标题格式与同级多数不一致×1'],
    'consistency.heading_numbering': ['标题编号不连续×2', '标题编号重复×1'],
    'consistency.heading_level_jump': ['标题层级跳跃×1'],
    'consistency.heading_content': ['标题只有编号没有文字×1', '标题文字过长×1'],
  };
  for (const [ruleId, messages] of Object.entries(expected)) {
    assert.deepEqual(messagesOf(report, ruleId).sort(), [...messages].sort(), `${ruleId} 实际：${JSON.stringify(messagesOf(report, ruleId))}`);
  }
  const headingSample = groupsOf(report, 'consistency.heading_format')[0].samples[0];
  assert.match(headingSample.text, /第二章/);
  assert.match(headingSample.detail, /字号为「小四（12磅）」，同级多数为「三号（16磅）」/);
  assert.match(groupsOf(report, 'consistency.body_format').find((group) => group.message.startsWith('正文中文字体')).samples[0].detail, /本段为「黑体」，正文多数为「宋体」/);
  const numbering = groupsOf(report, 'consistency.heading_numbering').flatMap((group) => group.samples.map((sample) => sample.text));
  assert.ok(numbering.some((text) => text.startsWith('2.3')) && numbering.some((text) => text.startsWith('第四章 质量')), JSON.stringify(numbering));
  assert.equal(groupsOf(report, 'consistency.body_format').find((group) => group.message.startsWith('正文对齐')).severity, 'low');

  const fixed = await inspect(source);
  assert.deepEqual(messagesOf(fixed, 'consistency.body_format'), ['正文对齐方式与多数段落不一致×1'], '预设已有固定字体字号时不重复报');
  assert.deepEqual(messagesOf(fixed, 'consistency.mixed_fonts'), []);
  assert.deepEqual(messagesOf(fixed, 'consistency.heading_format'), []);
  assert.equal(fixed.stats.rules_checked, 64);
});

test('招标未要求：文字效果、页眉页脚内容、空段落、纸张设为 null 时不检查，身份信息照常检查', async () => {
  const body = [
    para([run('这一段'), run('加粗了', '<w:b/>'), run('，还有'), run('红字', '<w:color w:val="FF0000"/>'), run('。')]),
    para(''),
    para('结尾段落。'),
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:pgSz w:w="16838" w:h="23811"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:num="1" w:space="425"/></w:sectPr>',
  ].join('');
  const source = buildDocx('招标未要求.docx', body, { header: para('技术标 华夏建设') });
  const strict = await inspect(source, { words: [{ text: '华夏建设', source: 'credential' }] });
  for (const ruleId of ['font.bold', 'font.color', 'struct.header_footer', 'struct.empty_paragraph', 'page.paper_size']) {
    assert.ok(groupsOf(strict, ruleId).length > 0, `内置默认值下 ${ruleId} 应报出`);
  }

  const profile = {
    page: { paper: null },
    body: { allow_bold: null, allow_italic: null, allow_underline: null, allow_color: null, allow_highlight: null },
    structure: { forbid_header_content: null, forbid_footer_content: null, check_empty_paragraphs: null },
  };
  const report = await inspect(source, { profile, words: [{ text: '华夏建设', source: 'credential' }] });
  for (const ruleId of ['font.bold', 'font.color', 'struct.header_footer', 'struct.empty_paragraph', 'page.paper_size']) {
    assert.deepEqual(messagesOf(report, ruleId), [], `${ruleId} 招标未要求时不应报`);
  }
  assert.ok(groupsOf(report, 'privacy.keyword').some((group) => group.samples.some((sample) => /页眉/.test(sample.where))), '页眉里的敏感词仍要报');
});

test('适用范围：图名和"目录"二字不按正文对齐缩进检查，标题查行距，表格查加粗，文字底纹和纯数字字号', async () => {
  const toc = '<w:p><w:pPr><w:pStyle w:val="10"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:t xml:space="preserve">第一章 概述	1</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="10"/></w:pPr><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const body = [
    para('目 录', '<w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>'),
    toc,
    para([run('第一章 概述', '<w:b/><w:sz w:val="32"/>')], '<w:pStyle w:val="1"/><w:spacing w:line="360" w:lineRule="auto"/>'),
    para('正文段落。'),
    imagePara('rIdImg1'),
    para('图1 施工流程图', '<w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>'),
    para('这一段居中了。', '<w:jc w:val="center"/>'),
    para([run('带底纹的文字', '<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>'), run('，年份'), run('2026', '<w:sz w:val="20"/>'), run('。')]),
    table([[cell(para([run('表头加粗', '<w:b/>')], '<w:ind w:firstLineChars="0" w:firstLine="0"/>')), cell(para('第二列', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'))]], 'TableGrid'),
    para('结尾段落。'),
    sectPr(),
  ].join('');
  const source = buildDocx('适用范围.docx', body, { images: { rIdImg1: { name: 'image1.png', contentType: 'image/png', data: pngWithAuthor('') } } });
  const profile = { body: { alignment: 'both' } };
  const report = await inspect(source, { profile });
  const alignments = groupsOf(report, 'para.alignment').flatMap((group) => group.samples.map((sample) => sample.text));
  assert.deepEqual(alignments, ['这一段居中了。'], `图名和"目录"二字不报对齐：${JSON.stringify(alignments)}`);
  const indents = groupsOf(report, 'para.first_line_indent').flatMap((group) => group.samples.map((sample) => sample.text));
  assert.ok(!indents.some((text) => /图1|目/.test(text)), `图名和"目录"二字不报首行缩进：${JSON.stringify(indents)}`);
  assert.ok(groupsOf(report, 'para.line_spacing').some((group) => group.samples.some((sample) => /第一章/.test(sample.text))), '标题也查行距');
  assert.ok(hasMessage(report, 'font.bold', '表格文字使用了加粗'), JSON.stringify(report.groups.map((group) => `${group.rule_id}:${group.message}`)));
  assert.ok(hasMessage(report, 'font.highlight', '文字带底纹'));
  assert.ok(groupsOf(report, 'font.size').some((group) => group.samples.some((sample) => /2026/.test(sample.text))), '纯数字默认也查字号');

  const relaxed = await inspect(source, { profile: { body: { alignment: 'both', check_latin_size: false }, table: { allow_bold: true } } });
  assert.ok(!hasMessage(relaxed, 'font.bold', '表格文字使用了加粗'), '表格单独允许加粗时不报');
  assert.ok(!groupsOf(relaxed, 'font.size').some((group) => group.samples.some((sample) => /2026/.test(sample.text))), '数字、西文不做要求时不查纯数字字号');
});

test('彩色：形状、图表、页面背景按彩色要求检查，招标文件没禁止彩色时不报；页脚只准出现页码时提示缺少页码', async () => {
  const shape = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="7" name="形状 1"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>'
    + '</wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect fillcolor="#4472c4"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>';
  const chart = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="8" name="图表 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const body = [para('彩色样本。'), shape, chart, sectPr()].join('');
  const source = buildDocx('彩色图形.docx', body);
  const sourcePath = path.join(workspace, source);
  const zip = new (require('adm-zip'))(sourcePath);
  const chartXml = '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:order val="0"/></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>';
  zip.addFile('word/charts/chart1.xml', Buffer.from(chartXml, 'utf8'));
  const rels = zip.readAsText('word/_rels/document.xml.rels').replace('</Relationships>', '<Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>');
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from(rels, 'utf8'));
  const document = zip.readAsText('word/document.xml').replace('<w:body>', '<w:background w:color="FFFF00"/><w:body>');
  zip.updateFile('word/document.xml', Buffer.from(document, 'utf8'));
  zip.writeZip(sourcePath);

  const report = await inspect(source, { profile: { image: { check_color: true }, structure: { page_number: 'footer_only' } } });
  assert.deepEqual(messagesOf(report, 'image.graphic_color').sort(), ['图表使用了彩色×1', '形状或文本框使用了彩色×1'].sort(), '形状只算 DrawingML 主副本一次');
  assert.deepEqual(messagesOf(report, 'page.background'), ['页面设置了背景颜色×1']);
  assert.deepEqual(messagesOf(report, 'struct.page_number_text'), ['页脚中没有页码×1']);
  assert.equal(groupsOf(report, 'struct.page_number_text')[0].severity, 'low');

  const allowed = await inspect(source, { profile: { body: { allow_color: null }, structure: { page_number: null } } });
  for (const ruleId of ['image.graphic_color', 'page.background', 'struct.page_number_text']) assert.deepEqual(messagesOf(allowed, ruleId), [], `${ruleId} 不应报`);
});

test('标题序号格式：招标要求阿拉伯数字分级时，中文序号、级数不符、自动编号的中文数字报出，阿拉伯分级编号不报', async () => {
  const heading = (text, style, numPr = '') => para(text, `<w:pStyle w:val="${style}"/>${numPr}`);
  const body = [
    heading('（八）施工组织设计', '1'),
    heading('1、施工方案与技术措施', '1'),
    heading('1.1、施工总体部署', '2'),
    para('正文段落。'),
    heading('2、质量管理', '2'),
    heading('一、安全管理', '1'),
    heading('自动编号的中文标题', '1', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    heading('自动编号的二级标题', '2', '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>'),
    heading('附件', '1'),
    sectPr(),
  ].join('');
  const level = samples.numberingLevel;
  const source = buildDocx('标题序号.docx', body, {
    numbering: `<w:abstractNum w:abstractNumId="0">${level(0, 'chineseCounting', '%1、')}</w:abstractNum>`
      + `<w:abstractNum w:abstractNumId="1">${level(0, 'decimal', '%1')}${level(1, 'decimal', '%1.%2')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
  });

  assert.deepEqual(messagesOf(await inspect(source), 'struct.heading_number'), [], '招标文件未要求时不检查');
  const report = await inspect(source, { profile: { structure: { heading_numbering: 'arabic' } } });
  const findings = groupsOf(report, 'struct.heading_number').flatMap((group) => group.samples.map((sample) => `${group.message}:${sample.text}`));
  assert.deepEqual(findings.sort(), [
    '标题序号不是阿拉伯数字:（八）施工组织设计',
    '标题序号不是阿拉伯数字:一、安全管理',
    '标题序号不是阿拉伯数字:自动编号的中文标题',
    '标题序号级数与标题级别不符:2、质量管理',
    '标题没有序号:附件',
  ].sort(), JSON.stringify(findings));
  assert.equal(groupsOf(report, 'struct.heading_number').find((group) => group.message === '标题没有序号').severity, 'low');

  const titled = buildDocx('总标题.docx', [heading('施工组织设计', '1'), heading('1、施工方案', '1'), para('正文段落。'), heading('附件', '1'), sectPr()].join(''));
  const titledReport = await inspect(titled, { profile: { structure: { heading_numbering: 'arabic' } } });
  assert.deepEqual(groupsOf(titledReport, 'struct.heading_number').flatMap((group) => group.samples.map((sample) => `${group.message}:${sample.text}`)), ['标题没有序号:附件'],
    '第一个带序号的标题之前没有序号的标题是文档总标题，不报');
});

test('建议级：英文标点、多余空格、手动换行、分栏和一致性检查都是低风险', async () => {
  const body = [para('本项目,包括以下内容。'), para('中文 中文之间有空格。'), para(['<w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r>']), sectPr({ cols: 2 })].join('');
  const report = await inspect(buildDocx('建议级.docx', body));
  for (const ruleId of ['text.english_punct', 'text.spaces', 'text.linebreak', 'page.columns']) {
    const groups = groupsOf(report, ruleId);
    assert.ok(groups.length > 0 && groups.every((group) => group.severity === 'low'), `${ruleId} 应为低风险：${JSON.stringify(groups.map((group) => group.severity))}`);
  }
});

function imagesDocx() {
  const body = [
    para('图片检查样本。'),
    imagePara('rIdImg1'),
    imagePara('rIdImg2'),
    imagePara('rIdImg3'),
    imagePara('rIdImg4'),
    para('同一张照片再次引用。'),
    imagePara('rIdImg4'),
    sectPr({ headerRid: 'rIdHeader1' }),
  ].join('');
  return buildDocx('图片.docx', body, {
    header: imagePara('rIdHeaderImg1'),
    images: {
      rIdImg1: { name: 'image1.emf', contentType: 'image/x-emf', data: emfWithText('设计单位：北京华夏建设有限公司') },
      // "上海联创科技有限公司"的 GBK 编码，验证 WMF 的 ANSI 文字按 GBK 解码。
      rIdImg2: { name: 'image2.wmf', contentType: 'image/x-wmf', data: wmfWithAnsiText(Buffer.from('c9cfbaa3c1aab4b4bfc6bcbcd3d0cfdeb9abcbbe', 'hex')) },
      rIdImg3: { name: 'image3.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="0" y="10">图例说明</text></svg>', 'utf8') },
      rIdImg4: { name: 'image4.jpeg', contentType: 'image/jpeg', data: jpegWithExif('华夏建设') },
    },
    headerImages: {
      rIdHeaderImg1: { name: 'image5.png', contentType: 'image/png', data: pngWithAuthor('张三') },
    },
  });
}

test('图片：矢量图文字、元数据和 GPS、彩色结论定位到首次出现的段落，统计图片格式', async () => {
  const report = await inspect(imagesDocx(), {
    profile: { image: { check_color: true } },
    words: [{ text: '华夏建设', source: 'credential' }],
    imageFacts: [
      { part: 'word/media/image5.png', color: true, color_ratio: 0.3 },
      { part: 'word/media/image4.jpeg', color: false, color_ratio: 0 },
    ],
  });
  assert.deepEqual(messagesOf(report, 'image.vector').sort(), ['矢量图中含有文字，请人工确认×1', '矢量图中含有身份信息×2'].sort(), JSON.stringify(messagesOf(report, 'image.vector')));
  assert.deepEqual(messagesOf(report, 'image.meta').sort(), ['图片元数据中含有身份信息×1', '图片元数据含作者、版权等信息，请人工确认×1', '图片含拍摄位置（GPS）信息×1'].sort(), JSON.stringify(messagesOf(report, 'image.meta')));
  assert.deepEqual(messagesOf(report, 'image.color'), ['存在彩色图片×1']);

  const vectorTexts = groupsOf(report, 'image.vector').find((group) => group.severity === 'high').samples.map((sample) => `${sample.detail}|${sample.text}`);
  assert.ok(vectorTexts.some((text) => /image1\.emf（EMF）.*华夏建设/.test(text)), JSON.stringify(vectorTexts));
  assert.ok(vectorTexts.some((text) => /image2\.wmf（WMF）.*上海联创科技有限公司/.test(text)), JSON.stringify(vectorTexts));
  const gps = groupsOf(report, 'image.meta').find((group) => group.message.includes('GPS')).samples[0];
  assert.match(gps.detail, /image4\.jpeg（JPEG，64×32）.*文中引用 2 次|image4\.jpeg（JPEG，64×32）/);
  assert.match(gps.where, /正文第 5 段/);
  const color = groupsOf(report, 'image.color')[0].samples[0];
  assert.match(color.where, /^页眉/);
  assert.match(color.detail, /image5\.png（PNG，2×2），彩色像素约占 30%/);

  assert.equal(report.stats.images, 5);
  assert.equal(report.stats.vector_images, 3);
  assert.deepEqual(report.stats.image_formats, { EMF: 1, WMF: 1, SVG: 1, JPEG: 1, PNG: 1 });

  const quiet = await inspect(imagesDocx(), { imageFacts: [{ part: 'word/media/image5.png', color: true, color_ratio: 0.3 }] });
  assert.deepEqual(messagesOf(quiet, 'image.color'), [], '彩色图片检查默认关闭');
});

function minorRulesDocx() {
  const body = [
    para('第一节正文内容。'),
    para('网格对齐的多倍行距段落。', '<w:spacing w:line="360" w:lineRule="auto"/>'),
    para([run('体积单位为立方米，记作m'), run('3', '<w:vertAlign w:val="superscript"/>')]),
    '<w:p><w:bookmarkStart w:id="1" w:name="华夏建设资料"/><w:r><w:t>书签所在段落。</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
    '<w:p><w:bookmarkStart w:id="2" w:name="_Toc123456"/><w:bookmarkStart w:id="3" w:name="附件一"/><w:r><w:t>另一个书签段落。</w:t></w:r><w:bookmarkEnd w:id="2"/><w:bookmarkEnd w:id="3"/></w:p>',
    para('设备(含安装)由厂家负责。'),
    para('数量１２台。'),
    para('型号ＡＢ型。'),
    table([[cell(para('合并单元格', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'), '<w:gridSpan w:val="2"/>')]], 'TableGrid'),
    `<w:p><w:pPr>${sectPr({ docGrid: 'lines' })}</w:pPr><w:r><w:t>第一节末段。</w:t></w:r></w:p>`,
    para('第二节正文。'),
    sectPr({ left: 1134 }),
  ].join('');
  return buildDocx('细项规则.docx', body);
}

test('细项规则：默认关闭，在预设中打开后命中', async () => {
  const minorRules = ['page.sections', 'para.snap_to_grid', 'font.script', 'table.alignment', 'table.merge', 'struct.bookmark', 'text.halfwidth_punct', 'text.fullwidth_digit', 'text.fullwidth_latin'];
  const source = minorRulesDocx();
  const words = [{ text: '华夏建设', source: 'custom' }];
  const defaults = await inspect(source, { words });
  assert.deepEqual(minorRules.filter((ruleId) => groupsOf(defaults, ruleId).length), [], '细项规则默认不报');

  const report = await inspect(source, {
    words,
    profile: {
      page: { check_sections: true },
      body: { check_snap_to_grid: true, check_vert_align: true },
      table: { alignment: 'center', check_merge: true },
      structure: { check_bookmarks: true },
      text: { check_halfwidth_brackets: true, check_fullwidth_digits: true, check_fullwidth_letters: true },
    },
  });
  const expected = {
    'page.sections': ['页面设置与第 1 节不同×1'],
    'para.snap_to_grid': ['段落对齐到文档网格，实际行距可能被放大×1'],
    'font.script': ['存在上标或下标文字×1'],
    'table.alignment': ['表格对齐方式不符合要求×1'],
    'table.merge': ['表格含合并单元格×1'],
    'struct.bookmark': ['书签名称含有身份信息×1', '文档含命名书签×1'],
    'text.halfwidth_punct': ['中文内容中使用了半角括号×1'],
    'text.fullwidth_digit': ['使用了全角数字×1'],
    'text.fullwidth_latin': ['使用了全角字母×1'],
  };
  for (const [ruleId, messages] of Object.entries(expected)) {
    assert.deepEqual(messagesOf(report, ruleId).sort(), [...messages].sort(), `${ruleId} 实际：${JSON.stringify(messagesOf(report, ruleId))}`);
  }
  assert.match(groupsOf(report, 'page.sections')[0].samples[0].detail, /左边距 2 cm（第 1 节为 2\.5 cm）/);
  assert.equal(groupsOf(report, 'struct.bookmark').find((group) => group.message === '书签名称含有身份信息').severity, 'high');
  const listed = groupsOf(report, 'struct.bookmark').find((group) => group.message === '文档含命名书签').samples[0].detail;
  assert.match(listed, /共 2 个：华夏建设资料、附件一/);
  assert.doesNotMatch(listed, /_Toc/);
});

/** 按两份真实暗标技术标的写法构造：封面、手写目录、编号兜底的二级标题、泛指的事务所、表单字段名、Table Normal 样式。 */
function realWorldDocx() {
  const pageBreak = '<w:r><w:br w:type="page"/></w:r>';
  const coverRun = '<w:rFonts w:eastAsia="黑体"/><w:sz w:val="44"/><w:spacing w:val="-12"/>';
  const heading = (text) => para([run(text)], '<w:pStyle w:val="1"/>');
  const body = [
    para(''),
    para(''),
    para([run('技术投标文件', coverRun)], '<w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>'),
    para([run('（正本）', coverRun), run('北京华夏建设有限公司', '<w:vanish/>')], '<w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>'),
    para(''),
    para([pageBreak]),
    para('施工组织设计目录', '<w:jc w:val="center"/>'),
    para('一、工程概况'),
    para('二、施工方案'),
    para('三、质量保证'),
    para([pageBreak]),
    heading('一、工程概况'),
    para('1、项目信息'),
    para('定期邀请内部审计部门或第三方会计师事务所对费用使用情况进行审计。'),
    para('建立处置单位台账，记录处置单位名称、资质证书编号、联系方式等信息。'),
    para('联系电话：'),
    table([[cell(para('联系电话', '<w:ind w:firstLineChars="0" w:firstLine="0"/>')), cell(para('项目负责人联系电话按规定公示', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'))]], 'a3'),
    heading('二、施工方案'),
    para('1、总体部署'),
    para('施工部署采取分段推进的策略。'),
    heading('三、质量保证'),
    para('质量目标为合格。'),
    sectPr(),
  ].join('');
  return buildDocx('真实写法.docx', body);
}

test('真实写法回归：封面不按正文格式检查、手写目录不当标题、编号兜底不判层级跳跃、泛指机构和叙述中的字段名不报', async () => {
  const source = realWorldDocx();
  const report = await inspect(source);
  const all = report.groups.map((group) => `${group.rule_id}:${group.message}×${group.count}`);
  for (const ruleId of ['font.size', 'font.bold', 'font.chinese', 'font.char_spacing', 'para.alignment', 'para.first_line_indent', 'table.style', 'consistency.heading_level_jump']) {
    assert.deepEqual(messagesOf(report, ruleId), [], `${ruleId} 不应报；全部：${JSON.stringify(all)}`);
  }
  assert.ok(!hasMessage(report, 'struct.empty_paragraph', '存在空段落'), `封面空行不报：${JSON.stringify(all)}`);
  assert.equal(report.stats.cover_paragraphs, 6);
  assert.equal(report.stats.toc_entries, 3);
  assert.equal(report.stats.heading_sources.style, 3);
  assert.ok(hasMessage(report, 'struct.toc', '目录疑似手工录入'), JSON.stringify(all));
  const forbid = await inspect(source, { profile: { structure: { check_toc_present: 'forbid' } } });
  assert.ok(hasMessage(forbid, 'struct.toc', '文档包含目录'), `不允许目录时手写目录也要报：${JSON.stringify(messagesOf(forbid, 'struct.toc'))}`);
  const required = await inspect(source, { profile: { structure: { check_toc_present: 'require' } } });
  assert.ok(!hasMessage(required, 'struct.toc', '未检测到目录'), '要求有目录时手写目录算作已有目录');

  const privacy = groupsOf(report, 'privacy.keyword');
  assert.ok(!privacy.some((group) => /事务所/.test(group.message)), `泛指的事务所不是企业名：${JSON.stringify(all)}`);
  assert.deepEqual(messagesOf(report, 'privacy.keyword').filter((item) => item.includes('敏感字段')), ['出现敏感字段「联系电话」×2'], '只报带冒号的字段和单独成格的字段名');
  const cover = privacy.find((group) => group.message === '出现企业名称「北京华夏建设有限公司」');
  assert.equal(cover?.samples[0].where, '封面', '封面仍检查身份信息');
  assert.equal(groupsOf(report, 'text.hidden')[0]?.samples[0].where, '封面', '封面仍检查隐藏文字');

  const strict = await inspect(source, { profile: { structure: { skip_cover: false } } });
  assert.ok(hasMessage(strict, 'font.size', '字号不是四号（14磅）'), '关闭封面识别后封面按正文检查');
  assert.equal(strict.stats.cover_paragraphs, 0);
});

test('空的目录域：禁止目录时按空目录域提示', async () => {
  const body = [
    para('封面标题'),
    `<w:p><w:pPr>${sectPr()}</w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">TOC \\o "1-3" \\h \\z \\u</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    para('正文内容。'),
    sectPr(),
  ].join('');
  const report = await inspect(buildDocx('空目录域.docx', body), { profile: { structure: { check_toc_present: 'forbid' } } });
  assert.deepEqual(messagesOf(report, 'struct.toc'), ['文档包含空的目录域×1']);
  assert.match(groupsOf(report, 'struct.toc')[0].samples[0].detail, /尚未更新的空目录域/);
  assert.equal(report.stats.cover_paragraphs, 1);
});

/** 评审回归用的样式表：默认段落样式不叫 Normal；子样式只改西文字体和段后，中文字体和行距继承自父样式。 */
const REVIEW_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${samples.NS}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="500" w:lineRule="exact"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="MyBody"><w:name w:val="投标正文"/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="560"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Parent"><w:name w:val="父样式"/><w:basedOn w:val="MyBody"/><w:pPr><w:spacing w:line="600" w:lineRule="exact"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Child"><w:name w:val="子样式"/><w:basedOn w:val="Parent"/><w:pPr><w:spacing w:after="100"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hint="eastAsia"/></w:rPr></w:style>
</w:styles>`;

test('评审回归：默认样式按属性识别、样式链逐层继承、中西文混排分别检查字体、纯数字西文也查字号', async () => {
  const body = [
    para('未指定样式的段落沿用默认样式的小四字号。'),
    para('子样式只改了西文字体和段后间距。', '<w:pStyle w:val="Child"/>'),
    para([run('BIM技术', '<w:rFonts w:eastAsia="楷体"/>')]),
    para([run('中文ABC中文', '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>')]),
    para([run('依据规范', '<w:sz w:val="28"/>'), run('GB 50300-2013', '<w:sz w:val="21"/>')], '<w:pStyle w:val="Parent"/>'),
    sectPr(),
  ].join('');
  const report = await inspect(buildDocx('评审回归.docx', body, { styles: REVIEW_STYLES }), { profile: { body: { font_en: 'Times New Roman' } } });
  const samplesOf = (ruleId) => groupsOf(report, ruleId).flatMap((group) => group.samples.map((sample) => `${sample.where}|${sample.detail}`));

  assert.ok(samplesOf('font.size').some((item) => item.startsWith('正文第 1 段') && item.includes('当前小四（12磅）')), `默认样式 w:default 是属性：${JSON.stringify(samplesOf('font.size'))}`);
  assert.ok(samplesOf('font.chinese').some((item) => item.startsWith('正文第 2 段') && item.includes('当前「黑体」')), `子样式只写西文字体时，中文字体继承父样式：${JSON.stringify(samplesOf('font.chinese'))}`);
  assert.ok(samplesOf('para.line_spacing').some((item) => item.startsWith('正文第 2 段') && item.includes('当前 30 磅')), `子样式只写段后时，行距继承父样式：${JSON.stringify(samplesOf('para.line_spacing'))}`);
  assert.ok(samplesOf('font.chinese').some((item) => item.startsWith('正文第 3 段') && item.includes('当前「楷体」')), '西文占多数的混排文本块也检查中文字体');
  assert.ok(samplesOf('font.western').some((item) => item.startsWith('正文第 4 段') && item.includes('当前「Arial」')), '中文占多数的混排文本块也检查西文字体');
  assert.ok(samplesOf('font.size').some((item) => item.startsWith('正文第 5 段') && item.includes('当前五号')), `单独成块的规范编号也检查字号：${JSON.stringify(samplesOf('font.size'))}`);
});

test('取消：中止信号结束助手进程，任务目录被清理', async () => {
  const paragraphs = Array.from({ length: 40000 }, (_, index) => para(`第 ${index + 1} 段测试正文，用于验证取消能立即结束检查进程。`)).join('');
  const source = buildDocx('取消.docx', `${paragraphs}${sectPr()}`);
  const controller = new AbortController();
  const progress = [];
  const pending = service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: [] }, {
    signal: controller.signal,
    onProgress: (item) => {
      progress.push(item);
      controller.abort();
    },
  });
  await assert.rejects(pending);
  const jobsDir = path.join(workspace, 'openxml-jobs');
  const leftovers = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [];
  assert.deepEqual(leftovers, []);
});

test('性能：4 万段正文在合理时间内完成并持续上报进度', async () => {
  const paragraphs = Array.from({ length: 40000 }, (_, index) => para(`第 ${index + 1} 段测试正文，内容用于验证大文档的检查耗时。`)).join('');
  const source = buildDocx('性能.docx', `${paragraphs}${sectPr()}`);
  const progress = [];
  const started = Date.now();
  const report = await service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: [] }, { onProgress: (item) => progress.push(item) });
  const elapsed = Date.now() - started;
  console.log(`[性能] 40000 段，耗时 ${elapsed} ms，引擎计时 ${report.stats.duration_ms} ms，进度回调 ${progress.length} 次`);
  assert.equal(report.stats.body_paragraphs, 40000);
  assert.ok(progress.length > 3);
  assert.ok(elapsed < 120000);
});
