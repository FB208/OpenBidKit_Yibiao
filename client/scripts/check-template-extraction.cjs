// node scripts/check-template-extraction.cjs [--source <招标文件.docx>]
// 隔离中文工作区，编译并调用真实 OpenXmlHelper，检查投标模版候选识别、字段写入和错误路径，不读写用户项目。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { createOpenXmlHelperService, OPENXML_ENVIRONMENT_ERROR_CODE } = require('../electron/services/openXmlHelperService.cjs');

const SOURCE_RELATIVE = 'technical-plan/tender-originals/招标原件.docx';
const TEMPLATE_SOURCE_RELATIVE = 'technical-plan/bid-template-source.docx';
const TEMPLATE_RELATIVE = 'technical-plan/bid-template.docx';
const FIELDS_RELATIVE = 'technical-plan/bid-template-fields.json';
const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(' ');

const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text, { underline = false, bold = false } = {}) => {
  const properties = bold || underline ? `<w:rPr>${bold ? '<w:b/>' : ''}${underline ? '<w:u w:val="single"/>' : ''}</w:rPr>` : '';
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
};
const underlined = (text) => run(text, { underline: true });
const paragraph = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const heading = (text) => `<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr>${run(text)}</w:p>`;
const cell = (content = '', { span = 1 } = {}) => `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>${content || '<w:p/>'}</w:tc>`;
const textCell = (text, options = {}) => cell(paragraph(run(text, options)), options);
const table = (columns, rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="1600"/>'.repeat(columns)}</w:tblGrid>${rows.map((row) => `<w:tr>${row.join('')}</w:tr>`).join('')}</w:tbl>`;
let drawingId = 0;
// 新格式文本框放在 mc:Choice，兼容格式放在 mc:Fallback，与 WPS/Word 保存结果一致。
const textBox = (text) => {
  drawingId += 1;
  return `<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1800000" cy="900000"/><wp:docPr id="${drawingId}" name="文本框 ${drawingId}"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>${paragraph(run(text))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect style="width:141.75pt;height:70.85pt"><v:textbox><w:txbxContent>${paragraph(run(text))}</w:txbxContent></v:textbox></v:rect></w:pict></mc:Fallback></mc:AlternateContent>`;
};

/** 构造覆盖各类候选的招标原件，返回原件块号对应的章节范围。 */
function buildTenderDocx(target) {
  const blocks = [
    heading('一、投标书'),
    paragraph(run('致：'), '<w:sdt><w:sdtPr><w:id w:val="1124038313"/><w:dropDownList><w:listItem w:displayText="某某招标人有限公司" w:value="某某招标人有限公司"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>某某招标人有限公司</w:t></w:r></w:sdtContent></w:sdt>'),
    paragraph(run('投标人名称：'), underlined('          '), run('（公章）')),
    paragraph(run('授权委托人：'), underlined('        '), run('（签字）')),
    paragraph(run('日期：20'), underlined('   '), run('年'), underlined('   '), run('月'), underlined('   '), run('日')),
    paragraph(run('我方对招标文件所有条款予以确认。并进一步承诺如下：')),
    paragraph(run('本授权书声明：位于'), underlined('（公司地址） '), run('的'), underlined(' （公司名称） '), run('的法定代表人代表本公司参加（招标编号'), underlined('       '), run('）的投标。')),
    paragraph(run('投标人： （盖单位公章）')),
    paragraph(run('            年  月  日')),
    `<w:p><w:r>${textBox('法定代表人身份证正面扫描或复印')}</w:r><w:r>${textBox('法定代表人身份证背面扫描或复印')}</w:r><w:r>${textBox('附：营业执照复印件（加盖公章）')}</w:r></w:p>`,
    paragraph(run('附：授权委托代理人身份证复印件（公章）')),
    paragraph(run('企业性质：□国有 □民营')),
    paragraph(run('项目负责人：'), '<w:sdt><w:sdtPr><w:alias w:val="项目负责人"/><w:id w:val="22"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:t>单击此处输入文字。</w:t></w:r></w:sdtContent></w:sdt>'),
    heading('六、企业基本情况表'),
    table(5, [
      [textCell('企业名称(盖章)'), cell('', { span: 2 }), textCell('社会组织统一社会信用代码'), cell()],
      [textCell('企业类型'), cell(paragraph(run('□ 有限责任公司')) + paragraph(run('□ 股份有限公司')) + paragraph(run('□ 独资企业')), { span: 2 }), textCell('上年度销售额'), cell()],
      [textCell('被授权人情况'), textCell('姓名'), cell(), textCell('身份证号'), cell()],
    ]),
    paragraph(run('注：后附企业营业执照、税务登记证（复印件加盖公章）。')),
    heading('七、企业其他相关资料'),
    table(3, [
      [textCell('资料目录', { span: 3 })],
      [textCell('序号', { bold: true }), textCell('资料名称', { bold: true }), textCell('页码', { bold: true })],
      [cell(), cell(), cell()],
      [cell(), cell(), cell()],
      [cell(), cell(), cell()],
    ]),
    heading('八、技术响应文件'),
    paragraph(run('不属于模板填写的章节：____')),
  ];
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES}><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`, 'utf8'));
  zip.writeZip(target);
  return [
    { id: 'c1', title: '投标书', startBlock: 0, endBlock: 13 },
    { id: 'c2', title: '企业基本情况表', startBlock: 13, endBlock: 16 },
    { id: 'c3', title: '企业其他相关资料', startBlock: 16, endBlock: 18 },
  ];
}

/** 按候选建议自动分类：附件一律人工，其余沿用建议名称和填写方式。 */
function classifyAll(candidateFile, overrides = {}) {
  return {
    fields: candidateFile.candidates.map((item, index) => ({
      candidate_id: item.candidate_id,
      name: item.suggested_name || `${item.kind}-${index + 1}`,
      fill_by: item.kind.startsWith('attachment-') ? 'manual' : item.suggested_fill_by || candidateFile.default_suggested_fill_by,
      ...(overrides[item.candidate_id] || {}),
    })),
    ignored_candidate_ids: [],
  };
}

function readDocumentXml(filePath) {
  return new AdmZip(filePath).readAsText('word/document.xml');
}

async function runJob(helper, action, request) {
  return helper.runJob({ action, request, timeoutMs: 120000 });
}

async function scanTemplate(helper, workspace, chapters) {
  await runJob(helper, 'extract-chapters', { sources: [SOURCE_RELATIVE], chapters, output: TEMPLATE_SOURCE_RELATIVE });
  const scan = await runJob(helper, 'scan-template-fields', { input: TEMPLATE_SOURCE_RELATIVE });
  return JSON.parse(fs.readFileSync(path.join(scan.jobDir, 'template-field-candidates.json'), 'utf8'));
}

async function applyTemplate(helper, classification) {
  return runJob(helper, 'apply-template-fields', {
    input: TEMPLATE_SOURCE_RELATIVE,
    output: TEMPLATE_RELATIVE,
    fields_output: FIELDS_RELATIVE,
    ...classification,
  });
}

/** 构造原件覆盖全部候选类型，断言识别、命名、写入与错误路径。 */
async function checkSyntheticTender(helper, workspace) {
  const sourcePath = path.join(workspace, SOURCE_RELATIVE);
  const chapters = buildTenderDocx(sourcePath);
  fs.chmodSync(sourcePath, 0o444);
  const sourceBytes = fs.readFileSync(sourcePath);

  const blocks = await runJob(helper, 'list-blocks', { sources: [SOURCE_RELATIVE] });
  assert.equal(blocks.blockCount, 21);
  const candidateFile = await scanTemplate(helper, workspace, chapters);
  const candidates = candidateFile.candidates;
  const byName = (name) => candidates.filter((item) => item.suggested_name === name);
  const one = (name) => {
    const found = byName(name);
    assert.equal(found.length, 1, `候选“${name}”应恰好一个，实际 ${found.length}`);
    return found[0];
  };
  const kinds = candidates.reduce((result, item) => ({ ...result, [item.kind]: (result[item.kind] || 0) + 1 }), {});
  assert.deepEqual(kinds, {
    'underlined-space': 6,
    'hint-placeholder': 2,
    'blank-gap': 4,
    'attachment-slot': 2,
    'attachment-note': 3,
    'checkbox-group': 2,
    'existing-content-control': 1,
    'empty-table-cell': 14,
  });

  assert.equal(one('投标人名称').suggested_fill_by, undefined, '名称旁的（公章）不改变文字由程序填写');
  assert.equal(one('授权委托人').suggested_fill_by, 'manual');
  const bidDates = candidates.filter((item) => item.kind === 'underlined-space' && /^日期（[年月日]）$/.test(item.suggested_name || ''));
  assert.deepEqual(bidDates.map((item) => item.suggested_name), ['日期（年）', '日期（月）', '日期（日）']);
  assert.match(bidDates[0].context, /日期：20【▢】年/);
  assert.match(bidDates[1].context, /年【▢】月/);
  assert.match(one('公司地址').context, /位于【▢（公司地址）】的/);
  assert.equal(one('公司名称').kind, 'hint-placeholder');
  assert.equal(one('招标编号').kind, 'underlined-space');
  assert.equal(one('投标人').kind, 'blank-gap');
  assert.equal(one('投标人').suggested_fill_by, undefined);
  const signDates = candidates.filter((item) => item.kind === 'blank-gap' && /^日期（[年月日]）$/.test(item.suggested_name || ''));
  assert.deepEqual(signDates.map((item) => item.suggested_name), ['日期（年）', '日期（月）', '日期（日）']);
  assert.equal(candidates.some((item) => (item.context || '').includes('如下【▢')), false, '句末“如下：”不是待填位置');
  assert.equal(one('法定代表人身份证正面').kind, 'attachment-slot');
  assert.equal(one('法定代表人身份证背面').suggested_fill_by, 'manual');
  assert.equal(one('授权委托代理人身份证复印件').kind, 'attachment-note');
  assert.equal(one('企业营业执照、税务登记证').kind, 'attachment-note');
  assert.equal(one('营业执照复印件').kind, 'attachment-note', '文本框里的附件说明同样识别');
  assert.deepEqual(one('企业性质').options, ['国有', '民营']);
  const companyType = one('企业类型');
  assert.equal(companyType.kind, 'checkbox-group');
  assert.deepEqual(companyType.options, ['有限责任公司', '股份有限公司', '独资企业']);
  assert.equal(one('项目负责人').kind, 'existing-content-control');
  assert.equal(candidates.some((item) => (item.text || item.context || '').includes('某某招标人')), false, '已填写固定内容的控件不作为候选');
  assert.equal(candidates.some((item) => (item.context || '').includes('不属于模板填写')), false, '未选章节不扫描');

  const companyName = one('企业名称');
  assert.equal(companyName.suggested_fill_by, undefined, '“(盖章)”只是提示，企业名称由程序填写');
  assert.deepEqual([companyName.row_number, companyName.column_number], [1, 2]);
  assert.match(companyName.context, /第1列：企业名称\(盖章\)；【▢第2列】；第4列：社会组织统一社会信用代码/);
  assert.deepEqual([one('社会组织统一社会信用代码').column_number, one('上年度销售额').row_number], [5, 2]);
  assert.deepEqual([one('姓名').column_number, one('身份证号').column_number], [3, 5]);
  const listCells = candidates.filter((item) => item.kind === 'empty-table-cell' && ['序号', '资料名称', '页码'].includes(item.suggested_name));
  assert.equal(listCells.length, 9);
  assert.equal(new Set(listCells.map((item) => item.table_id)).size, 1);
  assert.deepEqual([...new Set(listCells.map((item) => item.row_number))], [3, 4, 5]);
  assert.notEqual(listCells[0].table_id, companyName.table_id);
  console.log(`候选识别：${candidates.length} 个，类型分布 ${JSON.stringify(kinds)}。`);

  const attachment = one('法定代表人身份证正面');
  await assert.rejects(
    applyTemplate(helper, classifyAll(candidateFile, { [attachment.candidate_id]: { fill_by: 'ai' } })),
    /附件材料位置必须使用 manual/,
  );
  await assert.rejects(
    applyTemplate(helper, classifyAll(candidateFile, { [one('企业性质').candidate_id]: { name: '投标人名称', fill_by: 'ai' } })),
    /同名字段的类型必须一致/,
  );
  const templatePath = path.join(workspace, TEMPLATE_RELATIVE);
  fs.mkdirSync(templatePath, { recursive: true });
  await assert.rejects(applyTemplate(helper, classifyAll(candidateFile)), (error) => {
    assert.equal(error.code, OPENXML_ENVIRONMENT_ERROR_CODE);
    assert.match(error.message, /无法读写文件“technical-plan\/bid-template\.docx”/);
    return true;
  });
  fs.rmSync(templatePath, { recursive: true, force: true });
  console.log('错误路径：附件填 ai、同名不同类型、输出文件被占用均按预期报错。');

  const applied = await applyTemplate(helper, classifyAll(candidateFile));
  assert.equal(applied.blockCount, candidates.length);
  const definitions = JSON.parse(fs.readFileSync(path.join(workspace, FIELDS_RELATIVE), 'utf8'));
  assert.equal(definitions.version, 2);
  assert.equal(definitions.fields.length, candidates.length);
  const fieldKinds = definitions.fields.reduce((result, item) => ({ ...result, [item.kind]: (result[item.kind] || 0) + 1 }), {});
  assert.deepEqual(fieldKinds, { text: 27, attachment: 5, choice: 2 });
  assert.ok(definitions.fields.filter((item) => item.kind === 'attachment').every((item) => item.fill_by === 'manual'));
  assert.deepEqual(definitions.fields.find((item) => item.name === '企业类型').options, ['有限责任公司', '股份有限公司', '独资企业']);
  const listFields = definitions.fields.filter((item) => item.name === '资料名称');
  assert.deepEqual(listFields.map((item) => item.row), [3, 4, 5]);
  assert.equal(new Set(listFields.map((item) => item.table_id)).size, 1);
  assert.equal(definitions.fields.find((item) => item.name === '投标人名称').table_id, undefined);

  const xml = readDocumentXml(templatePath);
  const fallbackXml = (xml.match(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g) || []).join('');
  const choiceXml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const tags = choiceXml.match(/w:tag w:val="yibiao:field:[^"]+"/g) || [];
  assert.equal(tags.length, definitions.fields.length);
  assert.equal(new Set(tags).size, tags.length);
  assert.doesNotMatch(fallbackXml, /yibiao:field:/, '兼容格式只同步文字');
  assert.match(fallbackXml, /【人工处理：法定代表人身份证正面】/);
  assert.match(fallbackXml, /【人工处理：法定代表人身份证背面】/);
  const textBoxNote = /附：营业执照复印件（加盖公章）<\/w:t>[\s\S]*?<\/w:p><w:p>[\s\S]*?【人工处理：营业执照复印件】/;
  assert.match(choiceXml, textBoxNote, '文本框附件说明后插入附件位置');
  assert.match(fallbackXml, textBoxNote, '兼容格式同步插入纯文字附件占位');
  assert.match(xml, /□ 有限责任公司/, '勾选项保留原文');
  assert.match(xml, /□国有 □民营|□国有<\/w:t>/, '同段勾选项保留原文');
  assert.match(xml, /附：授权委托代理人身份证复印件（公章）<\/w:t>[\s\S]*?<\/w:p><w:p>[\s\S]*?【人工处理：授权委托代理人身份证复印件】/, '附件说明后插入附件位置');
  assert.match(xml, /【待填写：公司地址】/);
  assert.match(xml, /投标人：[\s\S]*?【待填写：投标人】/);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes, '招标原件保持不变');
  console.log(`字段写入：${definitions.fields.length} 个内容控件，类型 ${JSON.stringify(fieldKinds)}，文本框兼容格式已同步，原件未改动。`);
}

/** 对真实招标文件全文扫描并自动分类写入，只输出统计。 */
async function checkRealTender(helper, workspace, sourceFile) {
  const sourcePath = path.join(workspace, SOURCE_RELATIVE);
  fs.copyFileSync(sourceFile, sourcePath);
  const blocks = await runJob(helper, 'list-blocks', { sources: [SOURCE_RELATIVE] });
  const candidateFile = await scanTemplate(helper, workspace, [{ title: '全文', startBlock: 0, endBlock: blocks.blockCount }]);
  const kinds = candidateFile.candidates.reduce((result, item) => ({ ...result, [item.kind]: (result[item.kind] || 0) + 1 }), {});
  const classification = classifyAll(candidateFile);
  // 真实文件的建议名称可能同名不同类型，冒烟检查按类型区分名称，只验证写入链路。
  for (const field of classification.fields) {
    const candidate = candidateFile.candidates.find((item) => item.candidate_id === field.candidate_id);
    field.name = `${field.name}（${candidate.kind}）`;
    field.fill_by = candidate.kind.startsWith('attachment-') ? 'manual' : 'ai';
  }
  const applied = await applyTemplate(helper, classification);
  const xml = readDocumentXml(path.join(workspace, TEMPLATE_RELATIVE)).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const tags = xml.match(/w:tag w:val="yibiao:field:[^"]+"/g) || [];
  assert.equal(tags.length, applied.blockCount);
  console.log(`真实招标文件：${blocks.blockCount} 个原文块，${candidateFile.candidates.length} 个候选 ${JSON.stringify(kinds)}，写入 ${applied.blockCount} 个内容控件。`);
}

async function main() {
  const sourceIndex = process.argv.indexOf('--source');
  const sourceFile = sourceIndex >= 0 ? path.resolve(process.argv[sourceIndex + 1] || '') : '';
  if (sourceIndex >= 0) assert.ok(fs.existsSync(sourceFile), `找不到招标文件：${sourceFile}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '投标模版提取检查-'));
  const binaryDir = path.join(directory, '助手');
  const built = spawnSync('dotnet', ['build', path.resolve(__dirname, '../../openxmlhelper/src/OpenXmlHelper/OpenXmlHelper.csproj'), '-o', binaryDir, '-v', 'quiet', '-nologo'], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  process.env.YIBIAO_OPENXML_HELPER_DIR = binaryDir;
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getPath = () => path.join(directory, '独立用户数据');
  app.getAppPath = () => path.resolve(__dirname, '..');
  const workspace = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(path.join(workspace, 'technical-plan', 'tender-originals'), { recursive: true });
  const helper = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
  try {
    if (sourceFile) {
      await checkRealTender(helper, workspace, sourceFile);
    } else {
      await checkSyntheticTender(helper, workspace);
    }
  } finally {
    await helper.close();
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('投标模版提取检查通过。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
