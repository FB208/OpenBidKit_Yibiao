// 暗标自动修复端到端验证：在中文临时目录手工构造 docx，经 openXmlHelperService.runBlindCheckFix 调用真实助手，
// 断言修复后复查清零、原文件不变、未改动的 part 原样保留、修复写法正确且 Open XML 校验没有新增错误。
// 用法（client 目录）：node --test scripts/check-blind-check-fix.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const AdmZip = require('adm-zip');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { FIX_RULE_IDS, normalizeProfile } = require('../electron/services/blindCheckPresets.cjs');
const samples = require('./blind-check-samples.cjs');

const { cell, emfWithText, imagePara, jpegWithExif, numberingLevel, pageNumberTextbox, para, pngWithAuthor, run, sectPr, table } = samples;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), '暗标修复验证-'));
const workspace = path.join(userData, 'workspace');
const sourceDir = path.join(workspace, 'blind-check', 'source');
const app = { isPackaged: false, getPath: () => userData, getAppPath: () => path.join(__dirname, '..') };
let service;

function buildDocx(fileName, body, extra = {}) {
  return samples.buildDocx(sourceDir, fileName, body, extra);
}

function hash(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

async function fix(source, { profile = {}, words = [], rules = FIX_RULE_IDS } = {}) {
  const output = source.replace('/source/', '/fixed/');
  const sourcePath = path.join(workspace, source);
  const before = hash(sourcePath);
  const report = await service.runBlindCheckFix({
    source,
    output,
    profile: normalizeProfile(profile),
    sensitive_words: words,
    image_facts: [],
    fix_rules: rules,
  });
  assert.equal(hash(sourcePath), before, '原文件不能被改动');
  assert.deepEqual(report.validation.new_errors, [], `修复不能引入新的 Open XML 错误：${JSON.stringify(report.validation)}`);
  return { report, sourcePath, outputPath: path.join(workspace, output) };
}

function entry(filePath, name) {
  return new AdmZip(filePath).getEntry(name)?.getData() || null;
}

function xml(filePath, name = 'word/document.xml') {
  return entry(filePath, name)?.toString('utf8') || '';
}

function paragraphTexts(documentXml) {
  return (documentXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
    .map((paragraph) => (paragraph.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) || []).map((item) => item.replace(/<[^>]+>/g, '')).join(''));
}

function remaining(report, ruleIds) {
  return report.after.groups.filter((group) => ruleIds.includes(group.rule_id)).map((group) => `${group.rule_id}:${group.message}×${group.count}`);
}

before(() => {
  service = createOpenXmlHelperService({ app });
});

after(async () => {
  await service?.close();
  await service?.closeBlindCheck();
  fs.rmSync(userData, { recursive: true, force: true });
});

test('格式修复：样式继承的格式写显式关闭值，复查清零，未改动的 part 原样保留', async () => {
  const body = [
    para([run('样式继承的加粗斜体红字。')], '<w:pStyle w:val="BoldBody"/>'),
    para([run('直接格式错误的文字。', '<w:rFonts w:eastAsia="黑体"/><w:strike/><w:spacing w:val="20"/><w:w w:val="80"/><w:sz w:val="24"/><w:highlight w:val="yellow"/><w:u w:val="single"/>')]),
    para('段落格式错误。', '<w:spacing w:before="240" w:after="240" w:line="360" w:lineRule="auto"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>'),
    para('悬挂缩进的段落。', '<w:ind w:hanging="420" w:hangingChars="150"/>'),
    para([run('第一章 概述', '<w:sz w:val="24"/>')], '<w:pStyle w:val="1"/>'),
    table([[cell(para([run('表格文字', '<w:rFonts w:eastAsia="黑体"/><w:sz w:val="24"/>')], '<w:ind w:firstLineChars="0" w:firstLine="0"/>'), '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>'), cell(para('第二列', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'))]], 'TableGrid'),
    para('结尾段落。'),
    sectPr({ left: 1134, cols: 2 }),
  ].join('');
  const source = buildDocx('格式修复.docx', body);
  const profile = { body: { alignment: 'both', allow_char_spacing: false, allow_font_scaling: false } };
  const { report, sourcePath, outputPath } = await fix(source, { profile });

  const fixedRules = ['font.bold', 'font.italic', 'font.color', 'font.chinese', 'font.size', 'font.effects', 'font.char_spacing', 'font.scaling', 'font.highlight', 'font.underline',
    'para.line_spacing', 'para.first_line_indent', 'para.space_before_after', 'para.alignment', 'table.font', 'table.size', 'table.shading', 'page.margins', 'page.columns'];
  for (const ruleId of fixedRules) assert.ok(report.fixes[ruleId] > 0, `${ruleId} 应有修改：${JSON.stringify(report.fixes)}`);
  assert.deepEqual(remaining(report, fixedRules), []);

  const document = xml(outputPath);
  const first = document.match(/<w:p[ >][\s\S]*?<\/w:p>/)[0];
  assert.match(first, /<w:b w:val="0"\s*\/>/, '样式继承的加粗要写显式关闭值');
  assert.match(first, /<w:i w:val="0"\s*\/>/);
  assert.match(first, /<w:color w:val="000000"\s*\/>/);
  assert.match(document, /<w:pgMar [^>]*w:left="1417"/);
  assert.match(document, /<w:cols [^>]*w:num="1"/);
  assert.match(document, /<w:shd [^>]*w:fill="auto"/);
  for (const name of ['word/styles.xml', 'word/theme/theme1.xml', '[Content_Types].xml']) {
    assert.ok(entry(outputPath, name).equals(entry(sourcePath, name)), `${name} 未改动，应原样保留`);
  }

  const only = await fix(buildDocx('只修属性.docx', body, { core: '<dc:creator>张三</dc:creator>' }), { profile, rules: ['struct.doc_props'] });
  assert.ok(entry(only.outputPath, 'word/document.xml').equals(entry(only.sourcePath, 'word/document.xml')), '未勾选格式修复时正文不改动');
  assert.doesNotMatch(xml(only.outputPath, 'docProps/core.xml'), /张三/);
});

test('文本修复：按整段判断标点，跨文本块的小数不误改，章节编号后的空格保留', async () => {
  const zeroWidth = String.fromCharCode(0x200B);
  const noBreak = String.fromCharCode(0xA0);
  const body = [
    para([run('圆周率3'), run('.14，本项目'), run(','), run('包括土建。')]),
    para('中文 中文之间有空格。'),
    para('1.1 编制依据'),
    para([run(`零宽${zeroWidth}字符`), run(`型号A${noBreak}B`)]),
    sectPr(),
  ].join('');
  const { report, outputPath } = await fix(buildDocx('文本修复.docx', body));
  assert.deepEqual(remaining(report, ['text.english_punct', 'text.spaces', 'text.irregular']), []);
  const texts = paragraphTexts(xml(outputPath));
  assert.ok(texts.includes('圆周率3.14，本项目，包括土建。'), JSON.stringify(texts));
  assert.ok(texts.includes('中文中文之间有空格。'), JSON.stringify(texts));
  assert.ok(texts.includes('1.1 编制依据'), '章节编号后的空格不删');
  assert.ok(texts.includes('零宽字符型号A B'), JSON.stringify(texts));
});

test('结构修复：修订、批注、超链接、身份域、隐藏文字、页眉、文档属性、书签和空段落', async () => {
  const date = 'w:date="2026-01-01T00:00:00Z"';
  const body = [
    `<w:p><w:ins w:id="1" w:author="张三" ${date}><w:r><w:t>插入的内容</w:t></w:r></w:ins><w:del w:id="2" w:author="张三" ${date}><w:r><w:delText>删除的内容</w:delText></w:r></w:del>`
      + `<w:r><w:rPr><w:b w:val="0"/><w:rPrChange w:id="3" w:author="张三" ${date}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>格式修订</w:t></w:r></w:p>`,
    '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>带批注的文字</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>',
    '<w:p><w:hyperlink r:id="rIdLink1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>官网链接</w:t></w:r></w:hyperlink></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">编制人：</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> AUTHOR </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>李四</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    para([run('可见文字'), run('隐藏的华夏建设', '<w:vanish/>')]),
    para('正文一。'),
    para(''),
    para('正文二。'),
    para('', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    '<w:p><w:bookmarkStart w:id="5" w:name="附件位置"/><w:bookmarkEnd w:id="5"/></w:p>',
    '<w:p><w:bookmarkStart w:id="6" w:name="华夏建设资料"/><w:r><w:t>书签所在段落。</w:t></w:r><w:bookmarkEnd w:id="6"/></w:p>',
    sectPr({ headerRid: 'rIdHeader1' }),
  ].join('');
  const header = `${para('华夏建设投标文件')}<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const source = buildDocx('结构修复.docx', body, {
    header,
    comments: '<w:comment w:id="0" w:author="李四"><w:p><w:r><w:t>请修改</w:t></w:r></w:p></w:comment>',
    hyperlinks: { rIdLink1: 'https://www.huaxia.com/' },
    core: '<dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy>',
    app: '<Template>华夏建设模板.dotx</Template><Company>华夏建设</Company>',
  });
  const { report, outputPath } = await fix(source, { profile: { structure: { check_bookmarks: true } }, words: [{ text: '华夏建设', source: 'credential' }] });

  assert.deepEqual(remaining(report, ['struct.revision', 'struct.comment', 'struct.hyperlink', 'struct.field', 'text.hidden', 'struct.header_footer', 'struct.doc_props']), []);
  assert.ok(!report.after.groups.some((group) => group.rule_id === 'struct.bookmark' && group.message === '书签名称含有身份信息'));
  assert.ok(!report.after.groups.some((group) => group.rule_id === 'privacy.keyword'), `页眉和隐藏文字里的敏感词应已清除：${JSON.stringify(report.after.groups.map((group) => group.message))}`);
  assert.deepEqual(report.after.groups.filter((group) => group.message === '存在空段落').map((group) => group.count), [2], '带编号和带书签的空段落保留');

  const document = xml(outputPath);
  const texts = paragraphTexts(document);
  assert.ok(texts.includes('插入的内容格式修订'), JSON.stringify(texts));
  assert.doesNotMatch(document, /删除的内容|w:ins |w:del |rPrChange|commentRange|commentReference|AUTHOR|李四|张三|隐藏的华夏建设|华夏建设资料/);
  assert.ok(texts.includes('官网链接') && !/w:hyperlink|rStyle w:val="Hyperlink"/.test(document), '超链接取消后保留文字、去掉超链接样式');
  assert.ok(texts.includes('编制人：'), '只删身份域，不删前面的文字');
  assert.equal(texts.indexOf('正文二。'), texts.indexOf('正文一。') + 1, '两段正文之间的空段落已删除');
  assert.doesNotMatch(xml(outputPath, 'word/_rels/document.xml.rels'), /huaxia/, '链接地址关系一并删除');
  assert.doesNotMatch(xml(outputPath, 'word/comments.xml'), /<w:comment /);
  const headerXml = xml(outputPath, 'word/header1.xml');
  assert.doesNotMatch(headerXml, /华夏建设|PAGE/);
  assert.match(headerXml, /<w:pBdr>.*w:val="nil"/, '用无边框覆盖页眉横线');
  assert.doesNotMatch(xml(outputPath, 'docProps/core.xml'), /张三|李四/);
  const appXml = xml(outputPath, 'docProps/app.xml');
  assert.doesNotMatch(appXml, /华夏建设/);
  assert.match(appXml, /<Template>Normal\.dotm<\/Template>/);
});

test('删除身份域：开始、结束标记与正文同在一个文本块时，只删域范围内的内容', async () => {
  const body = [
    '<w:p><w:r><w:t xml:space="preserve">编制人：</w:t><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> AUTHOR </w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>李四</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/><w:t>（签字）</w:t></w:r></w:p>',
    sectPr(),
  ].join('');
  const { report, outputPath } = await fix(buildDocx('域边界.docx', body), { rules: ['struct.field'] });
  assert.equal(report.fixes['struct.field'], 1);
  const document = xml(outputPath);
  assert.ok(paragraphTexts(document).includes('编制人：（签字）'), JSON.stringify(paragraphTexts(document)));
  assert.doesNotMatch(document, /李四|AUTHOR|fldChar/);
});

test('图片元数据：去掉 EXIF / PNG 文本块，不改其余字节；矢量图不动', async () => {
  const emf = emfWithText('设计单位：北京华夏建设有限公司');
  const body = [para('图片。'), imagePara('rIdImg1'), imagePara('rIdImg2'), imagePara('rIdImg3'), sectPr()].join('');
  const source = buildDocx('图片修复.docx', body, {
    images: {
      rIdImg1: { name: 'image1.jpeg', contentType: 'image/jpeg', data: jpegWithExif('华夏建设') },
      rIdImg2: { name: 'image2.png', contentType: 'image/png', data: pngWithAuthor('张三') },
      rIdImg3: { name: 'image3.emf', contentType: 'image/x-emf', data: emf },
    },
  });
  const { report, outputPath } = await fix(source, { words: [{ text: '华夏建设', source: 'credential' }] });
  assert.equal(report.fixes['image.meta'], 2);
  assert.deepEqual(remaining(report, ['image.meta']), []);
  const jpeg = entry(outputPath, 'word/media/image1.jpeg');
  assert.equal(jpeg.indexOf(Buffer.from('Exif')), -1);
  assert.ok(jpeg.includes(Buffer.from([0xFF, 0xC0])), 'SOF0 等图像段保留');
  assert.equal(entry(outputPath, 'word/media/image2.png').indexOf(Buffer.from('tEXt')), -1);
  assert.ok(entry(outputPath, 'word/media/image3.emf').equals(emf), '矢量图不自动修复，字节不变');
  assert.ok(remaining(report, ['image.vector']).length > 0, '矢量图里的文字留给人工处理');
});

test('图片元数据：作者和 GPS 只写在 PNG 的 eXIf 块里时同样检出并删除', async () => {
  const body = [para('图片。'), imagePara('rIdImg1'), sectPr()].join('');
  const source = buildDocx('PNG的EXIF.docx', body, {
    images: { rIdImg1: { name: 'image1.png', contentType: 'image/png', data: pngWithAuthor('华夏建设', { exif: true }) } },
  });
  const words = [{ text: '华夏建设', source: 'credential' }];
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: words, image_facts: [] });
  const messages = inspected.groups.filter((group) => group.rule_id === 'image.meta').map((group) => group.message).sort();
  assert.deepEqual(messages, ['图片元数据中含有身份信息', '图片含拍摄位置（GPS）信息'].sort(), JSON.stringify(messages));
  const { report, outputPath } = await fix(source, { words });
  assert.equal(report.fixes['image.meta'], 1);
  assert.deepEqual(remaining(report, ['image.meta']), []);
  assert.equal(entry(outputPath, 'word/media/image1.png').indexOf(Buffer.from('eXIf')), -1);
});

test('页眉清空：两节页眉共用一张单位标志图时，两个页眉都清空后图片从包里移除', async () => {
  const firstSection = `<w:p><w:pPr>${sectPr({ headerRid: 'rIdHeader1' })}</w:pPr><w:r><w:t>第一节正文。</w:t></w:r></w:p>`;
  const body = [firstSection, para('第二节正文。'), sectPr({ headerRid: 'rIdHeader2' })].join('');
  const source = buildDocx('共享页眉图片.docx', body, {
    header: imagePara('rIdLogo'),
    header2: imagePara('rIdLogo'),
    headerImages: { rIdLogo: { name: 'logo.png', contentType: 'image/png', data: pngWithAuthor('标志') } },
  });
  const { report, outputPath } = await fix(source, { rules: ['struct.header_footer'] });
  assert.equal(report.fixes['struct.header_footer'], 2);
  assert.deepEqual(remaining(report, ['struct.header_footer']), []);
  assert.equal(entry(outputPath, 'word/media/logo.png'), null, '两个页眉都不再引用后删除共用图片');
  assert.doesNotMatch(xml(outputPath, 'word/_rels/header2.xml.rels'), /logo\.png/);
});

test('页眉页脚横线：文字删光后「页眉」样式自带的横线算内容，检查报出、修复盖掉；保留的页码段落也去掉横线', async () => {
  const styles = samples.STYLES.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="a"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:jc w:val="center"/></w:pPr></w:style>\n</w:styles>');
  const body = [para('正文。'), sectPr({ headerRid: 'rIdHeader1', footerRid: 'rIdFooter1' })].join('');
  const pageField = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const source = buildDocx('页眉横线.docx', body, {
    styles,
    header: '<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr></w:p>',
    footer: `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="auto"/></w:pBdr><w:jc w:val="center"/></w:pPr>${pageField}</w:p>`,
  });
  const profile = { structure: { page_number: 'footer_only' } };
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile(profile), sensitive_words: [], image_facts: [] });
  const contentGroups = inspected.groups.filter((group) => group.rule_id === 'struct.header_footer' && /存在内容/.test(group.message));
  assert.deepEqual(contentGroups.map((group) => group.message).sort(), ['页眉存在内容', '页脚存在内容'], '只有横线的页眉、页码上方带横线的页脚都报出');
  assert.ok(contentGroups.every((group) => JSON.stringify(group).includes('[横线]')));
  const { report, outputPath } = await fix(source, { profile, rules: ['struct.header_footer'] });
  assert.equal(report.fixes['struct.header_footer'], 2);
  assert.deepEqual(remaining(report, ['struct.header_footer']), []);
  const headerXml = xml(outputPath, 'word/header1.xml');
  const footerXml = xml(outputPath, 'word/footer1.xml');
  assert.match(headerXml, /<w:pStyle w:val="Header"\s*\/>/, '清空后的空段落沿用页眉样式');
  assert.match(headerXml, /<w:bottom w:val="nil"\s*\/>/, '无边框盖掉样式里的下边框');
  assert.match(footerXml, /PAGE/, '页脚只准出现页码时页码保留');
  assert.doesNotMatch(footerXml, /w:val="single"/, '保留的页码段落去掉横线');
});

test('页码三态：页脚只准出现页码时 WPS 页码文本框不报、修复保留，页脚其他内容和页眉页码照常处理；不限时不报', async () => {
  const body = [para('正文。'), sectPr({ headerRid: 'rIdHeader1', footerRid: 'rIdFooter1' })].join('');
  const header = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const source = buildDocx('页脚只准出现页码.docx', body, { header, footer: `${pageNumberTextbox()}${para('华夏建设投标文件')}` });
  const profile = { structure: { page_number: 'footer_only', forbid_footer_content: false } };
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile(profile), sensitive_words: [], image_facts: [] });
  const findings = inspected.groups.filter((group) => group.rule_id === 'struct.header_footer');
  assert.deepEqual(findings.map((group) => group.message).sort(), ['页眉中存在页码', '页脚存在内容'].sort());
  assert.doesNotMatch(JSON.stringify(findings), /\[图片\]/, '页码文本框不当作图片');

  const { report, outputPath } = await fix(source, { profile, rules: ['struct.header_footer'] });
  assert.deepEqual(remaining(report, ['struct.header_footer']), []);
  const footerXml = xml(outputPath, 'word/footer1.xml');
  assert.equal((footerXml.match(/PAGE/g) || []).length, 2, '页码文本框连同 VML 回退副本一起保留');
  assert.doesNotMatch(footerXml, /华夏建设/);
  assert.doesNotMatch(xml(outputPath, 'word/header1.xml'), /PAGE/, '页码只准在页脚，页眉的页码删除');

  const pageOnly = buildDocx('只有页码.docx', body, { footer: pageNumberTextbox() });
  for (const pageNumber of ['footer_only', null]) {
    const quiet = await service.runBlindCheck({ source: pageOnly, profile: normalizeProfile({ structure: { page_number: pageNumber } }), sensitive_words: [], image_facts: [] });
    assert.deepEqual(quiet.groups.filter((group) => group.rule_id === 'struct.header_footer').map((group) => group.message), [], `页码设为 ${pageNumber} 时只有页码的页脚不报`);
  }
});

test('文字底纹、表格加粗、页面背景色：修复后复查清零，底纹写显式的清除值', async () => {
  const body = [
    para([run('带底纹的文字', '<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>')]),
    table([[cell(para([run('表头加粗', '<w:b/>')], '<w:ind w:firstLineChars="0" w:firstLine="0"/>')), cell(para('第二列', '<w:ind w:firstLineChars="0" w:firstLine="0"/>'))]], 'TableGrid'),
    para('结尾段落。'),
    sectPr(),
  ].join('');
  const source = buildDocx('底纹与背景.docx', body);
  const sourcePath = path.join(workspace, source);
  const zip = new AdmZip(sourcePath);
  zip.updateFile('word/document.xml', Buffer.from(zip.readAsText('word/document.xml').replace('<w:body>', '<w:background w:color="FFFF00"/><w:body>'), 'utf8'));
  zip.writeZip(sourcePath);

  const rules = ['font.highlight', 'font.bold', 'page.background'];
  const { report, outputPath } = await fix(source, { rules });
  for (const ruleId of rules) assert.ok(report.fixes[ruleId] > 0, `${ruleId} 应有修改：${JSON.stringify(report.fixes)}`);
  assert.deepEqual(remaining(report, rules), []);
  const document = xml(outputPath);
  assert.doesNotMatch(document, /w:background/);
  assert.match(document, /<w:shd w:val="clear" w:color="auto" w:fill="auto"\s*\/>/);
  assert.match(document, /<w:b w:val="0"\s*\/>/, '表格里的加粗写显式关闭值');
});

test('自动段前段后与主题淡色：要求 0 磅时自动间距要报并关掉，主题黑色淡化成灰色要报并改回黑色', async () => {
  const body = [
    para('从网页粘贴的段落。', '<w:spacing w:before="100" w:beforeAutospacing="1" w:after="100" w:afterAutospacing="1"/>'),
    para([run('灰色文字', '<w:color w:val="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'), run('主题黑色文字', '<w:color w:val="000000" w:themeColor="text1"/>')]),
    sectPr(),
  ].join('');
  const source = buildDocx('自动间距与主题色.docx', body);
  const profile = { body: { space_before_pt: 0, space_after_pt: 0 } };
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile(profile), sensitive_words: [], image_facts: [] });
  const messages = (ruleId) => inspected.groups.filter((group) => group.rule_id === ruleId).map((group) => `${group.message}×${group.count}`).sort();
  assert.deepEqual(messages('para.space_before_after'), ['段前间距为自动×1', '段后间距为自动×1']);
  assert.deepEqual(messages('font.color'), ['文字不是黑色×1'], '只报淡化后的灰色，主题黑色本身不报');

  const { report, outputPath } = await fix(source, { profile, rules: ['para.space_before_after', 'font.color'] });
  assert.deepEqual(remaining(report, ['para.space_before_after', 'font.color']), []);
  const document = xml(outputPath);
  assert.match(document, /w:beforeAutospacing="0"/);
  assert.match(document, /w:afterAutospacing="0"/);
  assert.doesNotMatch(document, /7F7F7F|themeTint/);
});

test('隐藏文字：页眉、脚注、文本框和目录里的隐藏文字同样检查并删除，可见内容保留', async () => {
  const hidden = (text) => run(text, '<w:vanish/>');
  const body = [
    para([run('目录')]),
    para([run('第一章 总体概述'), hidden('华夏建设目录')], '<w:pStyle w:val="10"/>'),
    para([run('第一章 总体概述')], '<w:pStyle w:val="1"/>'),
    para([run('正文内容。'), '<w:r><w:footnoteReference w:id="1"/></w:r>']),
    para([run('见示意框：'), `<w:r><w:pict><v:shape style="width:200pt;height:40pt"><v:textbox><w:txbxContent>${para([run('框内说明'), hidden('华夏建设文本框')])}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`]),
    sectPr({ headerRid: 'rIdHeader1' }),
  ].join('');
  const source = buildDocx('非正文隐藏文字.docx', body, {
    header: para([run('技术标'), hidden('华夏建设页眉')]),
    footnotes: `<w:footnote w:id="1">${para([run('注释说明'), hidden('华夏建设脚注')])}</w:footnote>`,
  });
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: [], image_facts: [] });
  const { report, outputPath } = await fix(source, { rules: ['text.hidden'] });
  const wheres = inspected.groups.filter((group) => group.rule_id === 'text.hidden').flatMap((group) => group.samples.map((sample) => sample.where));
  for (const where of ['页眉', '脚注', '文本框', '目录']) {
    assert.ok(wheres.some((item) => item.startsWith(where)), `${where}里的隐藏文字应报出：${JSON.stringify(wheres)}`);
  }
  assert.equal(report.fixes['text.hidden'], 4);
  assert.deepEqual(remaining(report, ['text.hidden']), []);
  const document = xml(outputPath) + xml(outputPath, 'word/header1.xml') + xml(outputPath, 'word/footnotes.xml');
  assert.doesNotMatch(document, /华夏建设/);
  for (const text of ['技术标', '注释说明', '框内说明', '第一章 总体概述']) assert.match(document, new RegExp(text));
});

test('隐藏文字来自多层样式叠加时不删：开关可能互相抵消、文字实际可见，留给人工；直接设置和单层样式的照常删除', async () => {
  const styles = samples.STYLES.replace('</w:styles>', [
    '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:name w:val="隐藏段落"/><w:basedOn w:val="a"/><w:rPr><w:vanish/></w:rPr></w:style>',
    '<w:style w:type="character" w:styleId="HiddenChar"><w:name w:val="隐藏字符"/><w:rPr><w:vanish/></w:rPr></w:style>',
    '<w:style w:type="character" w:styleId="HiddenChar2"><w:name w:val="隐藏字符 2"/><w:basedOn w:val="HiddenChar"/><w:rPr><w:vanish/></w:rPr></w:style>',
    '</w:styles>',
  ].join('\n'));
  const body = [
    para([run('正文开头。'), run('华夏建设直接隐藏', '<w:vanish/>')]),
    para([run('正文第二段。'), run('华夏建设单层样式', '<w:rStyle w:val="HiddenChar"/>')]),
    para([run('段落和字符样式都隐藏', '<w:rStyle w:val="HiddenChar"/>')], '<w:pStyle w:val="HiddenPara"/>'),
    para([run('正文第四段。'), run('同一样式链两层都隐藏', '<w:rStyle w:val="HiddenChar2"/>')]),
    sectPr(),
  ].join('');
  const source = buildDocx('样式叠加隐藏.docx', body, { styles });
  const { report, outputPath } = await fix(source, { rules: ['text.hidden'] });
  assert.equal(report.fixes['text.hidden'], 2, '只删直接设置和单层样式的隐藏，多层叠加的不计入');
  assert.deepEqual(remaining(report, ['text.hidden']), ['text.hidden:存在隐藏文字×2'], '多层叠加的照常报出，留给人工');
  const document = xml(outputPath);
  assert.doesNotMatch(document, /华夏建设/);
  for (const text of ['正文开头。', '正文第二段。', '段落和字符样式都隐藏', '同一样式链两层都隐藏']) assert.match(document, new RegExp(text));
});

test('手动换行：在换行处拆成段落，段前分页留在第一段、分节符留在最后一段，标题和编号段落不拆', async () => {
  const body = [
    para(['<w:r><w:t>标题上半</w:t><w:br/><w:t>标题下半</w:t></w:r>'], '<w:pStyle w:val="1"/>'),
    '<w:p><w:r><w:t>程序生成的第一段。\n第二段内容。</w:t></w:r></w:p>',
    para(['<w:r><w:t>第一行</w:t><w:br/><w:t xml:space="preserve">  第二行</w:t></w:r>'], '<w:pageBreakBefore/>'),
    para(['<w:r><w:t>段尾换行。</w:t><w:br/></w:r>']),
    para(['<w:r><w:t>编号第一行</w:t><w:br/><w:t>编号第二行</w:t></w:r>'], '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    `<w:p><w:pPr>${sectPr()}</w:pPr><w:r><w:t>节末一行</w:t><w:br/><w:t>节末二行</w:t></w:r></w:p>`,
    para('第二节正文。'),
    sectPr(),
  ].join('');
  const source = buildDocx('手动换行.docx', body);
  const inspected = await service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: [], image_facts: [] });
  const details = inspected.groups.filter((group) => group.rule_id === 'text.linebreak').flatMap((group) => group.samples.map((sample) => sample.detail));
  assert.ok(details.some((detail) => /换行字符/.test(detail)), `文字里夹带的换行字符单独说明：${JSON.stringify(details)}`);

  const { report, outputPath } = await fix(source, { rules: ['text.linebreak'] });
  assert.equal(report.fixes['text.linebreak'], 4);
  assert.deepEqual(remaining(report, ['text.linebreak']), ['text.linebreak:存在手动换行符×2'], '标题和编号段落里的换行留给人工');
  assert.ok(report.notes.some((note) => /2 段的手动换行/.test(note)), JSON.stringify(report.notes));
  const document = xml(outputPath);
  const texts = paragraphTexts(document);
  for (const text of ['程序生成的第一段。', '第二段内容。', '第一行', '第二行', '段尾换行。', '节末一行', '节末二行']) assert.ok(texts.includes(text), `${text}：${JSON.stringify(texts)}`);
  assert.equal(texts.indexOf('段尾换行。') + 1, texts.indexOf('编号第一行编号第二行'), '段尾换行不留空行');
  assert.equal(texts.indexOf('第一行') + 1, texts.indexOf('第二行'), '新段开头的空格去掉');
  assert.equal((document.match(/<w:pageBreakBefore\s*\/>/g) || []).length, 1, '段前分页只留在拆出的第一段');
  const paragraphs = document.match(/<w:p[ >][\s\S]*?<\/w:p>/g);
  assert.match(paragraphs.find((item) => item.includes('节末二行')), /<w:sectPr>/, '分节符留在最后一段');
  assert.doesNotMatch(paragraphs.find((item) => item.includes('节末一行')), /<w:sectPr>/);
});

test('标题序号：总标题前的序号删除并同步目录，中文序号层级清楚时重排，自动编号改为阿拉伯数字，写法混用的留给人工', async () => {
  const profile = { structure: { heading_numbering: 'arabic' } };
  const heading = (text, style, pPr = '') => para(text, `<w:pStyle w:val="${style}"/>${pPr}`);
  const tocEntry = (text, page) => para([run(text), '<w:r><w:tab/></w:r>', run(page)], '<w:pStyle w:val="10"/>');

  const titled = buildDocx('总标题序号.docx', [
    tocEntry('（八）施工组织设计', '1'), tocEntry('1、施工方案', '1'), tocEntry('2、质量管理', '2'),
    heading('（八）施工组织设计', '1'), heading('1、施工方案', '1'), heading('1.1、施工总体部署', '2'), para('正文段落。'),
    heading('2、质量管理', '1'), heading('一、安全管理', '1'), sectPr(),
  ].join(''));
  const first = await fix(titled, { profile, rules: ['struct.heading_number'] });
  assert.equal(first.report.fixes['struct.heading_number'], 1);
  assert.deepEqual(remaining(first.report, ['struct.heading_number']), ['struct.heading_number:标题序号不是阿拉伯数字×1']);
  assert.ok(first.report.notes.some((note) => /1 个标题的序号写法混用/.test(note)), JSON.stringify(first.report.notes));
  const titledTexts = paragraphTexts(xml(first.outputPath));
  assert.equal(titledTexts.filter((text) => text === '施工组织设计').length, 1, `标题删去序号：${JSON.stringify(titledTexts)}`);
  assert.ok(titledTexts.includes('施工组织设计1'), '目录条目同步删去序号');
  assert.ok(titledTexts.includes('一、安全管理'), '混用的中文序号不自动改');

  const chinese = buildDocx('中文序号.docx', [
    heading('施工组织设计', '1'), heading('第一章 工程概况', '1'), heading('一、编制依据', '2'), heading('二、工程特点', '2'), heading('（一）主要规范', '3'),
    para('正文段落。'), heading('第二章 施工部署', '1'), heading('一、总体安排', '2'), sectPr(),
  ].join(''));
  const second = await fix(chinese, { profile, rules: ['struct.heading_number'] });
  assert.equal(second.report.fixes['struct.heading_number'], 6);
  assert.deepEqual(remaining(second.report, ['struct.heading_number']), [], '总标题没有序号不报');
  const chineseTexts = paragraphTexts(xml(second.outputPath));
  for (const text of ['施工组织设计', '1 工程概况', '1.1、编制依据', '1.2、工程特点', '1.2.1 主要规范', '2 施工部署', '2.1、总体安排']) {
    assert.ok(chineseTexts.includes(text), `${text}：${JSON.stringify(chineseTexts)}`);
  }

  const numPr = (numId, ilvl) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
  const auto = buildDocx('自动编号.docx', [
    heading('工程概况', '1', numPr(1, 0)), heading('编制依据', '2', numPr(1, 1)), para('正文列表项。', numPr(2, 0)), heading('施工部署', '1', numPr(1, 0)), sectPr(),
  ].join(''), {
    numbering: `<w:abstractNum w:abstractNumId="0">${numberingLevel(0, 'chineseCounting', '%1、')}${numberingLevel(1, 'chineseCounting', '（%2）')}</w:abstractNum>`
      + `<w:abstractNum w:abstractNumId="1">${numberingLevel(0, 'lowerLetter', '%1)')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
  });
  const third = await fix(auto, { profile, rules: ['struct.heading_number'] });
  assert.equal(third.report.fixes['struct.heading_number'], 3);
  assert.deepEqual(remaining(third.report, ['struct.heading_number']), []);
  const numbering = xml(third.outputPath, 'word/numbering.xml');
  assert.match(numbering, /<w:lvl w:ilvl="0"><w:start w:val="1"\s*\/><w:numFmt w:val="decimal"\s*\/><w:isLgl\s*\/><w:lvlText w:val="%1、"\s*\/>/);
  assert.match(numbering, /<w:lvl w:ilvl="1"><w:start w:val="1"\s*\/><w:numFmt w:val="decimal"\s*\/><w:isLgl\s*\/><w:lvlText w:val="%1\.%2"\s*\/>/);
  assert.match(numbering, /<w:numFmt w:val="lowerLetter"\s*\/><w:lvlText w:val="%1\)"\s*\/>/, '正文列表的编号不动');
});

test('封面与目录：封面格式不改，封面上的隐藏文字照样删除', async () => {
  const coverRun = '<w:rFonts w:eastAsia="黑体"/><w:sz w:val="44"/>';
  const body = [
    para([run('技术投标文件', coverRun), run('华夏建设', '<w:vanish/>')], '<w:jc w:val="center"/>'),
    para(['<w:r><w:br w:type="page"/></w:r>']),
    para([run('正文字号错误。', '<w:sz w:val="24"/>')]),
    sectPr(),
  ].join('');
  const { report, outputPath } = await fix(buildDocx('封面修复.docx', body));
  assert.equal(report.after.stats.cover_paragraphs, 2);
  assert.deepEqual(remaining(report, ['font.size', 'text.hidden']), []);
  const document = xml(outputPath);
  assert.match(document, /<w:rFonts w:eastAsia="黑体"\s*\/><w:sz w:val="44"\s*\/>/, '封面格式保持原样');
  assert.doesNotMatch(document, /华夏建设/);
});

const CHAPTERS = ['第一章 工程概况', '第二章 施工方案', '第三章 质量保证'];
const TOC_FORBIDDEN = { structure: { check_toc_present: 'forbid' } };
const PAGE_BREAK = para(['<w:r><w:br w:type="page"/></w:r>']);

/** Word 目录域：每条一段（toc 1 样式），域开始在第一条里，条目带指向标题书签的页码域；endParagraph 为 null 时域结束放在别处。 */
function tocParagraphs(titles, { endParagraph = para(['<w:r><w:fldChar w:fldCharType="end"/></w:r>']) } = {}) {
  const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const entries = titles.map((title, index) => para([
    index === 0 ? begin : '',
    `<w:hyperlink w:anchor="_Toc${index}" w:history="1">${run(title)}<w:r><w:tab/></w:r>`
      + `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc${index} \\h </w:instrText></w:r>`
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(String(index + 2))}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>`,
  ], '<w:pStyle w:val="10"/>'));
  return endParagraph === null ? entries : [...entries, endParagraph];
}

function chapters() {
  return CHAPTERS.flatMap((title, index) => [
    para([`<w:bookmarkStart w:id="${index}" w:name="_Toc${index}"/>`, run(title), `<w:bookmarkEnd w:id="${index}"/>`], '<w:pStyle w:val="1"/>'),
    para(`${title}的正文内容。`),
  ]);
}

test('删除目录：Word 自动目录连同内容控件和标题删掉，空出来的节并入正文节并补上沿用的页脚，复查沿用原来的标题认法', async () => {
  const gallery = '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>'
    + [para('目录', '<w:jc w:val="center"/>'), ...tocParagraphs(CHAPTERS, { endParagraph: para(['<w:r><w:fldChar w:fldCharType="end"/></w:r>'], sectPr({ footerRid: 'rIdFooter1' })) })].join('')
    + '</w:sdtContent></w:sdt>';
  const footer = para(['<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>', run('1'), '<w:r><w:fldChar w:fldCharType="end"/></w:r>'], '<w:jc w:val="center"/>');
  const body = [para('某工程施工（1标段）', '<w:jc w:val="center"/>'), para('技术标（暗标）', `<w:jc w:val="center"/>${sectPr()}`), gallery, ...chapters(), sectPr()].join('');
  const { report, outputPath } = await fix(buildDocx('自动目录.docx', body, { footer }), { profile: TOC_FORBIDDEN, rules: ['struct.toc'] });
  assert.equal(report.fixes['struct.toc'], 1);
  assert.deepEqual(remaining(report, ['struct.toc']), []);
  assert.equal(report.heading_fallback, false, '原文按目录认标题，修复副本复查不按编号兜底');
  assert.equal(report.after.stats.headings, 3);
  const document = xml(outputPath);
  assert.doesNotMatch(document, /TOC \\o|docPartGallery|PAGEREF/);
  assert.deepEqual(paragraphTexts(document).filter(Boolean), ['某工程施工（1标段）', '技术标（暗标）', ...CHAPTERS.flatMap((title) => [title, `${title}的正文内容。`])]);
  const sections = document.match(/<w:sectPr[ >][\s\S]*?<\/w:sectPr>/g);
  assert.equal(sections.length, 2, '目录节并入，只剩封面节和正文节');
  assert.match(sections[1], /footerReference w:type="default" r:id="rIdFooter1"/, '正文节原来沿用目录节的页码页脚');
});

test('删除目录：带目录标题、每行与后文标题相同的手工目录删除，前后只留一处换页；没有页码的正文误用目录样式不算目录', async () => {
  const misuse = [para('这一段误用了目录样式，但它是正文。', '<w:pStyle w:val="10"/>'), para('这也是正文，只是样式选错了。', '<w:pStyle w:val="10"/>')];
  const body = [
    para('技术标（暗标）', '<w:jc w:val="center"/>'), PAGE_BREAK,
    para('施工组织设计目录', '<w:jc w:val="center"/>'), ...CHAPTERS.map((title, index) => para(`${title}…………………${index + 2}`)), PAGE_BREAK,
    ...chapters(), ...misuse, sectPr(),
  ].join('');
  const { report, outputPath } = await fix(buildDocx('手工目录.docx', body), { profile: TOC_FORBIDDEN, rules: ['struct.toc'] });
  assert.equal(report.fixes['struct.toc'], 1);
  assert.deepEqual(remaining(report, ['struct.toc']), []);
  assert.equal(report.heading_fallback, true, '原文没有按目录认标题');
  const document = xml(outputPath);
  assert.deepEqual(paragraphTexts(document).filter(Boolean), ['技术标（暗标）', ...CHAPTERS.flatMap((title) => [title, `${title}的正文内容。`]), '这一段误用了目录样式，但它是正文。', '这也是正文，只是样式选错了。']);
  assert.equal((document.match(/w:type="page"/g) || []).length, 1, '封面和正文之间只留一处换页');

  const quiet = buildDocx('误用目录样式.docx', [...chapters(), ...misuse, sectPr()].join(''));
  const inspected = await service.runBlindCheck({ source: quiet, profile: normalizeProfile(TOC_FORBIDDEN), sensitive_words: [], image_facts: [] });
  assert.deepEqual(inspected.groups.filter((group) => group.rule_id === 'struct.toc').map((group) => group.message), [], '只有误用目录样式的段落时不报目录');
});

test('删除目录：域结束在正文标题里时标题保留，只靠目录认定的标题写入大纲级别，删除目录不引入新问题', async () => {
  // 标题没有用标题样式，靠目录认定；目录域结束、分页符和第一个标题在同一段（删掉目录后的空段落时常见）。
  const headings = CHAPTERS.map((title, index) => para([
    index === 0 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:br w:type="page"/></w:r>' : '',
    `<w:bookmarkStart w:id="${index}" w:name="_Toc${index}"/>`, run(title), `<w:bookmarkEnd w:id="${index}"/>`,
  ], '<w:jc w:val="center"/>'));
  const body = [
    para('技术标（暗标）', '<w:jc w:val="center"/>'), PAGE_BREAK, para('目录', '<w:jc w:val="center"/>'), ...tocParagraphs(CHAPTERS, { endParagraph: null }),
    ...headings.flatMap((heading, index) => [heading, para(`${CHAPTERS[index]}的正文内容。`)]), sectPr(),
  ].join('');
  const source = buildDocx('域结束在标题里.docx', body);
  const before = await service.runBlindCheck({ source, profile: normalizeProfile(TOC_FORBIDDEN), sensitive_words: [], image_facts: [] });
  const { report, outputPath } = await fix(source, { profile: TOC_FORBIDDEN, rules: ['struct.toc'] });
  const key = (group) => `${group.rule_id}|${group.message}|${group.count}`;
  const previous = before.groups.map(key);
  assert.deepEqual(report.after.groups.filter((group) => group.rule_id !== 'struct.toc').map(key).filter((item) => !previous.includes(item)), [], '删除目录不引入新问题');
  assert.equal(report.after.stats.headings, 3);
  const document = xml(outputPath);
  assert.equal((document.match(/<w:outlineLvl w:val="0"\s*\/>/g) || []).length, 3, '只靠目录认定的标题写入大纲级别');
  assert.equal((document.match(/w:type="page"/g) || []).length, 1, '目录前的分页段和标题段首的分页符只留一处，不出空白页');
  assert.deepEqual(paragraphTexts(document).filter(Boolean), ['技术标（暗标）', ...CHAPTERS.flatMap((title) => [title, `${title}的正文内容。`])]);
});

test('含分页符的空段落：分页符挪到上一段末尾后删段，分页符数量不变；表格后的和空白页留给人工，封面不动', async () => {
  const body = [
    para('某工程施工（1标段）', '<w:jc w:val="center"/>'), para('技术标（暗标）', '<w:jc w:val="center"/>'), PAGE_BREAK,
    para([run(CHAPTERS[0])], '<w:pStyle w:val="1"/>'), para(`${CHAPTERS[0]}的正文内容。`), para(''), PAGE_BREAK, PAGE_BREAK,
    para([run(CHAPTERS[1])], '<w:pStyle w:val="1"/>'), para(`${CHAPTERS[1]}的正文内容。`), table([[cell(para('甲')), cell(para('乙'))]]), PAGE_BREAK,
    para('附表一：设备表'), para('附表的说明。'), PAGE_BREAK,
    para([run(CHAPTERS[2])], '<w:pStyle w:val="1"/><w:pageBreakBefore/>'), para(`${CHAPTERS[2]}的正文内容。`), sectPr(),
  ].join('');
  const source = buildDocx('分页空段落.docx', body);
  const profile = normalizeProfile({});
  const before = await service.runBlindCheck({ source, profile, sensitive_words: [], image_facts: [] });
  const { report, outputPath } = await fix(source, { rules: ['struct.empty_paragraph'] });
  assert.equal(report.fixes['struct.empty_paragraph'], 3, '普通空段落 1 处、挪走分页符 2 处');
  assert.deepEqual(remaining(report, ['struct.empty_paragraph']), ['struct.empty_paragraph:存在含分页符的空段落×2'], '表格后的分页段落和空白页的第二个分页段落留给人工');
  assert.equal(report.after.stats.cover_paragraphs, 3, '封面上的分页段落不检查也不改');
  const key = (group) => `${group.rule_id}|${group.message}|${group.count}`;
  const previous = before.groups.map(key);
  assert.deepEqual(report.after.groups.filter((group) => group.rule_id !== 'struct.empty_paragraph').map(key).filter((item) => !previous.includes(item)), [], '不引入新问题');
  const document = xml(outputPath);
  const paragraphs = document.match(/<w:p[ >][\s\S]*?<\/w:p>/g);
  const breaksIn = (text) => paragraphs.some((item) => item.includes(text) && /<w:br w:type="page"\s*\/><\/w:r><\/w:p>$/.test(item));
  assert.ok(breaksIn(`${CHAPTERS[0]}的正文内容。`) && breaksIn('附表的说明。'), '分页符挪到上一段末尾');
  assert.equal((document.match(/w:type="page"/g) || []).length, 5, '分页符一个不少');
  assert.equal((document.match(/<w:pageBreakBefore\s*\/>/g) || []).length, 1);
  assert.deepEqual(paragraphTexts(document).filter(Boolean), ['某工程施工（1标段）', '技术标（暗标）', CHAPTERS[0], `${CHAPTERS[0]}的正文内容。`, CHAPTERS[1], `${CHAPTERS[1]}的正文内容。`, '甲', '乙', '附表一：设备表', '附表的说明。', CHAPTERS[2], `${CHAPTERS[2]}的正文内容。`]);
});

test('设了段前分页的空段落：修复空段落时不删，后文不回到上一页；检查时单独提示', async () => {
  // 段前分页可以直接设在段落上，也可以来自段落样式。
  const styles = samples.STYLES.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="PageStart"><w:name w:val="章节分页"/><w:basedOn w:val="a"/><w:pPr><w:pageBreakBefore/></w:pPr></w:style>\n</w:styles>');
  const body = [
    para([run(CHAPTERS[0])], '<w:pStyle w:val="1"/>'), para(`${CHAPTERS[0]}的正文内容。`), para(''), para('', '<w:pageBreakBefore/>'),
    para([run(CHAPTERS[1])], '<w:pStyle w:val="1"/>'), para(`${CHAPTERS[1]}的正文内容。`), para('', '<w:pStyle w:val="PageStart"/>'),
    para([run(CHAPTERS[2])], '<w:pStyle w:val="1"/>'), para(`${CHAPTERS[2]}的正文内容。`), sectPr(),
  ].join('');
  const source = buildDocx('段前分页空段落.docx', body, { styles });
  const before = await service.runBlindCheck({ source, profile: normalizeProfile({}), sensitive_words: [], image_facts: [] });
  const emptyGroups = (groups) => groups.filter((group) => group.rule_id === 'struct.empty_paragraph').map((group) => `${group.message}|${group.severity}×${group.count}`).sort();
  assert.deepEqual(emptyGroups(before.groups), ['存在空段落|medium×1', '存在设置段前分页的空段落|low×2']);
  const { report, outputPath } = await fix(source, { rules: ['struct.empty_paragraph'] });
  assert.equal(report.fixes['struct.empty_paragraph'], 1, '只删普通空段落');
  assert.deepEqual(remaining(report, ['struct.empty_paragraph']), ['struct.empty_paragraph:存在设置段前分页的空段落×2'], '设了段前分页的留给人工');
  const document = xml(outputPath);
  assert.equal((document.match(/<w:pageBreakBefore\s*\/>/g) || []).length, 1, '直接设置的段前分页还在');
  assert.match(document, /<w:pStyle w:val="PageStart"\s*\/>/, '样式带段前分页的空段落还在');
  assert.equal(paragraphTexts(document).length, 8, '9 段里只删掉 1 段普通空段落');
});

test('AI 复核：标书结构按段落编号导出，编辑按编号替换、删段、清除替代文字，越权和含糊的修改被拒绝', async () => {
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3600000" cy="1800000"/><wp:docPr id="1" name="图片 1" descr="华夏建设某项目工作计划"/>'
    + '<a:graphic><a:graphicData><a:blip r:embed="rIdImg1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const firstSection = `<w:p><w:pPr>${sectPr()}</w:pPr><w:r><w:t>封面后的分节段落</w:t></w:r></w:p>`;
  const body = [
    firstSection,
    para([run('第一章 工程概况')], '<w:pStyle w:val="1"/>'),
    para('本工程为某某泵站改造工程，泵站共18处。'),
    para('这一段整段删除。'),
    drawing,
    table([[cell(para('单元格文字')), cell(para('第二列'))]], 'TableGrid'),
    PAGE_BREAK,
    para('文末段落。'),
    sectPr(),
  ].join('');
  const source = buildDocx('AI编辑.docx', body, {
    images: { rIdImg1: { name: 'image1.png', contentType: 'image/png', data: pngWithAuthor('甘特图') } },
  });
  const profile = normalizeProfile({});
  const dump = await service.runBlindCheckDump({ source, profile, sensitive_words: [], image_facts: [] });
  assert.match(dump.text, /^## 分节与页码$/m);
  assert.match(dump.text, /^\[p1\] 〔封面〕封面后的分节段落 〔分节符〕$/m);
  assert.match(dump.text, /^\[p2\] 〔标题1〕第一章 工程概况$/m);
  assert.match(dump.text, /^\[p5\] ◇ 〔img1〕$/m);
  assert.match(dump.text, /^\[t1\.r1\.c1\] 单元格文字$/m);
  assert.match(dump.text, /^\[img1\] 位于 p5；嵌入图片 word\/media\/image1\.png；显示尺寸 10×5 厘米；名称「图片 1」；替代文字「华夏建设某项目工作计划」$/m);
  assert.deepEqual(dump.images.map((image) => [image.id, image.locator, image.part]), [['img1', 'p5', 'word/media/image1.png']]);

  const output = source.replace('/source/', '/fixed/');
  fs.mkdirSync(path.dirname(path.join(workspace, output)), { recursive: true });
  fs.copyFileSync(path.join(workspace, source), path.join(workspace, output));
  const before = hash(path.join(workspace, source));
  const result = await service.runBlindCheckEdit({
    source: output,
    original: source,
    profile,
    sensitive_words: [],
    image_facts: [],
    edits: [
      { op: 'replace', target: 'p3', find: '某某泵站改造工程', replace: '本工程' },
      { op: 'replace', target: 'p3', find: '泵站', replace: '站点' },
      { op: 'delete_paragraph', target: 'p4', find: '这一段 整段删除。' },
      { op: 'delete_paragraph', target: 'p1', find: '封面后的分节段落' },
      { op: 'delete_paragraph', target: 'p2', find: '第一章 工程概况' },
      { op: 'delete_paragraph', target: 't1.r1.c1', find: '单元格文字' },
      { op: 'clear_image_alt', target: 'img1' },
      { op: 'rewrite', target: 'p3' },
      { op: 'delete_paragraph', target: 'p6', find: '' },
    ],
  });
  assert.equal(hash(path.join(workspace, source)), before, '原始文档不改动');
  const outcomes = result.results.map((item) => [item.ok, item.message]);
  assert.deepEqual(outcomes.map(([ok]) => ok), [true, true, true, false, false, false, true, false, false], JSON.stringify(outcomes));
  assert.match(outcomes[3][1], /分节符/);
  assert.match(outcomes[4][1], /标题段落不能删除/);
  assert.match(outcomes[5][1], /单元格里唯一的段落/);
  assert.match(outcomes[7][1], /不支持的修改方式/);
  assert.match(outcomes[8][1], /含分页符/);
  assert.equal(result.applied, 4);
  assert.deepEqual(result.validation.new_errors, []);
  const texts = paragraphTexts(xml(path.join(workspace, output)));
  assert.ok(texts.includes('本工程为本工程，站点共18处。'), JSON.stringify(texts));
  assert.ok(!texts.includes('这一段整段删除。'));
  assert.doesNotMatch(xml(path.join(workspace, output)), /descr=/);
  assert.match(result.dump.text, /^\[p4\] ◇ 〔img1〕$/m, '删段后返回的新结构重新编号');

  const ambiguous = await service.runBlindCheckEdit({
    source: output, original: source, profile, sensitive_words: [], image_facts: [],
    edits: [{ op: 'replace', target: 'p3', find: '本工程', replace: '投标项目' }],
  });
  assert.match(ambiguous.results[0].message, /出现 2 次/);
  assert.equal(ambiguous.applied, 0);
});
