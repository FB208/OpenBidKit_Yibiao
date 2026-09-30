// node scripts/check-technical-plan-export.cjs：隔离中文工作区，调用真实 OpenXmlHelper，不读写用户项目。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { createTechnicalPlanExport } = require('../electron/services/technicalPlanExport.cjs');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { cloneDefaultExportFormat, normalizeExportFormat } = require('../electron/services/exportFormatDefaults.cjs');
const { SYSTEM_EXPORT_TEMPLATES } = require('../electron/services/systemExportTemplates.cjs');

/** 在独立 Electron 窗口走真实 preload、IPC、保存及进度订阅，保存对话框定向到临时目录。 */
async function checkIpc(exporter, directory, structure) {
  const { BrowserWindow, dialog } = require('electron');
  const { createExportService } = require('../electron/services/exportService.cjs');
  const { registerExportIpc } = require('../electron/ipc/exportIpc.cjs');
  const output = path.join(directory, '整本 IPC 导出.docx');
  let canceled = false;
  let recorded = 0;
  // 每次计数都产生一条提醒，记录实际显示的提醒编号；空提醒与真实服务一样不显示。
  const shown = [];
  const showSaveDialog = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled, filePath: output });
  registerExportIpc({
    exportService: createExportService({ configStore: { load: () => ({}) }, getTechnicalPlanExport: () => exporter }),
    donationService: { recordWordExport() { recorded += 1; return { click: recorded }; }, showPrompt(prompt) { if (prompt) shown.push(prompt.click); } },
  });
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('data:text/html;charset=utf-8,<html><body>整本导出 IPC 检查</body></html>');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const events = [];
      const unsubscribe = window.yibiao.export.onWordExportProgress(event => events.push(event));
      try { return { result: await window.yibiao.export.exportWord({ source: 'technical-plan', requestId: 'whole-check' }), events }; }
      finally { unsubscribe(); }
    })()`);
    assert.equal(result.result.path, output);
    assert.ok(fs.statSync(output).size > 0);
    assert.ok(result.events.every(event => event.requestId === 'whole-check'));
    assert.deepEqual(result.events.filter(event => event.progress === 100).map(event => event.phase), ['success']);
    assert.ok(result.events.some(event => event.progress === 55));
    assert.ok(result.events.some(event => event.progress === 96));
    const original = fs.readFileSync(output);
    canceled = true;
    assert.equal((await window.webContents.executeJavaScript("window.yibiao.export.exportWord({source:'technical-plan'})")).canceled, true);
    assert.deepEqual(fs.readFileSync(output), original);
    assert.equal(recorded, 2);
    assert.deepEqual(shown, [1, 2], '保存对话框取消时照常显示提醒');
    // 正文结构问题：首次调用只返回问题清单，确认后沿用同一请求继续导出，导出次数只记一次。
    structure.apply();
    try {
      const confirm = await window.webContents.executeJavaScript("window.yibiao.export.exportWord({ source: 'technical-plan', requestId: 'structure-check' })");
      assert.equal(confirm.needsConfirmation, true);
      assert.equal(confirm.success, false);
      assert.deepEqual(confirm.issues.map(issue => issue.section), [structure.label]);
      assert.equal(recorded, 3);
      assert.deepEqual(shown, [1, 2], '等待确认时不显示提醒');
      canceled = false;
      const continued = await window.webContents.executeJavaScript("window.yibiao.export.exportWord({ source: 'technical-plan', requestId: 'structure-check', confirmStructureIssues: true })");
      assert.equal(continued.path, output);
      assert.match(continued.message, /1 个小节正文结构不完整，已自动修复/);
      assert.equal(recorded, 3, '确认后继续导出属于同一次点击，不重复计数');
      assert.deepEqual(shown, [1, 2, 3], '继续导出结束后显示本次提醒');
      // 取消确认即结束本次请求：显示本次提醒并清理待处理记录，重复取消不再显示。
      const pending = await window.webContents.executeJavaScript("window.yibiao.export.exportWord({ source: 'technical-plan', requestId: 'structure-cancel' })");
      assert.equal(pending.needsConfirmation, true);
      assert.deepEqual(shown, [1, 2, 3]);
      await window.webContents.executeJavaScript("window.yibiao.export.cancelWordConfirmation('structure-cancel')");
      assert.deepEqual(shown, [1, 2, 3, 4], '取消确认时显示本次提醒');
      await window.webContents.executeJavaScript("window.yibiao.export.cancelWordConfirmation('structure-cancel')");
      assert.deepEqual(shown, [1, 2, 3, 4], '待处理记录已清理');
      assert.equal(recorded, 4);
    } finally { structure.restore(); }
    console.log('真实 Electron preload/IPC：导出、进度、取消、取消时保留文件、结构问题确认后继续或取消、导出记录及提醒通过。');
  } finally {
    window.destroy();
    dialog.showSaveDialog = showSaveDialog;
  }
}

/** 从真实 DOCX 中读取正文和关系，便于按文本检查所属段落。 */
function readWord(buffer) {
  const zip = new AdmZip(buffer);
  const $ = cheerio.load(zip.readAsText('word/document.xml'), { xmlMode: true });
  const rels = cheerio.load(zip.readAsText('word/_rels/document.xml.rels'), { xmlMode: true });
  const paragraph = text => $('w\\:p').filter((_, element) => $(element).text().includes(text)).first();
  return { zip, $, rels, paragraph };
}

/** 按需保留检查产物，供人工在 Word/WPS 中核对真实显示；默认仍只用临时目录。 */
function saveArtifact(name, document) {
  const directory = process.env.YIBIAO_WORD_EXPORT_CHECK_ARTIFACT_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.docx`);
  fs.writeFileSync(file, document.zip.toBuffer());
  console.log(`保留检查 DOCX：${file}`);
}

/** 检查真实产物只有平面表，且每行合并单元格完整覆盖同一张表的列网格。 */
function checkFlatTables(document) {
  const { $ } = document;
  assert.equal($('w\\:tbl w\\:tbl').length, 0, '章节页框不可嵌套业务表格');
  assert.equal($('w\\:tc w\\:sectPr').length, 0, '页面分节不可移入单元格');
  for (const table of $('w\\:tbl').toArray()) {
    const grid = $(table).children('w\\:tblGrid').children('w\\:gridCol');
    const width = Number($(table).children('w\\:tblPr').children('w\\:tblW').attr('w:w'));
    assert.equal(grid.toArray().reduce((sum, column) => sum + Number($(column).attr('w:w')), 0), width);
    for (const row of $(table).children('w\\:tr').toArray()) {
      const spans = $(row).children('w\\:tc').toArray().map(cell => Number($(cell).children('w\\:tcPr').children('w\\:gridSpan').attr('w:val') || 1));
      assert.equal(spans.reduce((sum, span) => sum + span, 0), grid.length, '每行应完整覆盖统一列网格');
    }
  }
}

/** 正文、表题、图题与业务表必须共用标题之间的同一张平面表。 */
function checkFusedBody(document, labels) {
  const { $ } = document;
  const table = document.paragraph(labels[0]).closest('w\\:tbl');
  assert.equal(table.length, 1, '正文应进入章节页框表');
  for (const label of labels) {
    const paragraph = document.paragraph(label);
    assert.equal(paragraph.closest('w\\:tbl')[0], table[0], label);
    assert.equal(paragraph.find('w\\:pBdr').length, 0, '表内正文不再单独画段落边框');
  }
  assert.equal(table.find('w\\:tblHeader').length, 0, '融合后业务表头不应重复到其他业务表的续页');
  const headerRows = ['设备', '四列表头甲'].map(text => table.children('w\\:tr').toArray()
    .find(row => $(row).find('w\\:t').toArray().some(node => $(node).text() === text)));
  for (const row of headerRows) assert.ok(row, '两个原业务表头都必须保留');
  for (const row of table.children('w\\:tr').toArray()) {
    assert.equal($(row).children('w\\:trPr').children('w\\:cantSplit').length, headerRows.includes(row) ? 1 : 0,
      '业务表头行不可拆分，普通正文和业务表体行仍允许跨页');
  }
  const counts = table.children('w\\:tr').toArray().map(row => $(row).children('w\\:tc').length);
  for (const count of [1, 2, 3, 4]) assert.ok(counts.includes(count), `融合表应包含 ${count} 个实际单元格的行`);
  assert.ok(table.find('w\\:vMerge[w\\:val="restart"]').length > 0, '纵向合并起点必须保留');
  assert.ok(table.find('w\\:vMerge').length >= 2, '纵向合并延续单元格必须保留');
  assert.ok(document.paragraph('四列横向合并').closest('w\\:tc').find('w\\:gridSpan').length > 0, '横向合并必须保留');
  return table;
}

/** 标题必须仍是正文顶层段落；false 只移除边框，不能改变其他标题属性。 */
function checkHeadings(document, included, baseline) {
  const { $ } = document;
  for (let level = 1; level <= 6; level += 1) {
    const heading = document.paragraph(`导航样张${level}`);
    assert.equal(heading.parent()[0], $('w\\:body')[0], '六级标题均应保留 Word 导航');
    assert.equal(heading.find('w\\:pStyle').attr('w:val'), `Heading${level}`);
    assert.equal(heading.find('w\\:outlineLvl').attr('w:val'), String(level - 1));
    assert.equal(heading.find('w\\:keepNext').length, 1);
    assert.equal(heading.find('w\\:pBdr').length, included ? 1 : 0);
    assert.equal(heading.find('w\\:shd').length, 1, '标题底纹不随边框开关消失');
    assert.equal(heading.find('w\\:spacing').attr('w:line'), '288');
    assert.equal(heading.find('w\\:spacing').attr('w:before'), '0');
    assert.equal(heading.find('w\\:spacing').attr('w:after'), '0');
    if (included) {
      assert.equal(heading.find('w\\:top').attr('w:space'), '5');
      assert.equal(heading.find('w\\:bottom').attr('w:space'), '4');
    }
    if (baseline) {
      const withoutBorder = paragraph => {
        const copy = paragraph.clone();
        copy.find('w\\:pBdr').remove();
        return copy.toString();
      };
      assert.equal(withoutBorder(heading), withoutBorder(baseline.paragraph(`导航样张${level}`)), '边框开关不可改变标题样式、编号、缩进和分页属性');
    }
  }
}

/** 独立有序列表使用各自的计数器，同一列表连续，显式起始值保留。 */
async function checkOrderedListRestart(helper, directory) {
  // 实际正文先出现无序列表时，转换库默认会复用后续有序列表实例；纯 ol 样例不能覆盖该问题。
  const html = '<ul><li>前置无序条目</li></ul><ol><li>甲组首项</li><li>甲组次项</li></ol><p>两个独立列表之间的正文</p><ul><li>中间无序条目</li></ul>'
    + '<ol><li>乙组首项</li><li>乙组次项</li></ol>'
    + '<ol start="7"><li>指定首项</li><li>指定次项</li></ol>';
  for (const wholeDocument of [false, true]) {
    for (const framed of [false, true]) {
      const config = cloneDefaultExportFormat();
      config.heading_border.enabled = framed;
      const input = wholeDocument ? `<section data-yb-export-template="true" data-yb-export-page-template="true">${html}</section>` : html;
      const output = await helper.createRestrictedHtmlDocx(input, config, { assetRoot: directory, copyAssets: true, wholeDocument });
      const { zip, paragraph } = readWord(Buffer.from(output.bytes));
      const numbering = cheerio.load(zip.readAsText('word/numbering.xml'), { xmlMode: true });
      const id = label => paragraph(label).find('w\\:numId').attr('w:val');
      const starts = ['甲组首项', '乙组首项', '指定首项'];
      assert.ok(starts.every(label => id(label)), '有序列表必须保留 Word 原生编号');
      assert.equal(new Set(starts.map(id)).size, 3, '独立 ol 不能共用同一个计数器');
      for (const group of ['甲组', '乙组', '指定']) assert.equal(id(`${group}首项`), id(`${group}次项`), '同一列表内必须递增');
      const start = label => {
        const instance = numbering(`w\\:num[w\\:numId="${id(label)}"]`);
        const override = instance.find('w\\:lvlOverride[w\\:ilvl="0"] w\\:startOverride').attr('w:val');
        const abstract = instance.find('w\\:abstractNumId').attr('w:val');
        return Number(override ?? numbering(`w\\:abstractNum[w\\:abstractNumId="${abstract}"] w\\:lvl[w\\:ilvl="0"] w\\:start`).attr('w:val'));
      };
      assert.deepEqual(starts.map(start), [1, 1, 7]);
    }
  }
  console.log('有序列表：整本/小节、页框开关、独立重启、组内递增及显式起始值通过。');
}

/** 构造只含尺寸信息的 TIFF、EMF 和 WMF 文件头，覆盖 Word 原生图片格式的识别与尺寸读取。 */
function metafileSamples() {
  const tiff = Buffer.alloc(38);
  tiff.write('II*\0', 0, 'latin1');
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  // 宽度用 SHORT、高度用 LONG，覆盖两种取值方式。
  tiff.writeUInt16LE(256, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(3, 18);
  tiff.writeUInt16LE(257, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(2, 30);
  const emf = Buffer.alloc(88);
  emf.writeUInt32LE(1, 0);
  emf.writeUInt32LE(88, 4);
  [0, 0, 99, 49].forEach((value, index) => emf.writeInt32LE(value, 8 + index * 4));
  [0, 0, 4000, 2000].forEach((value, index) => emf.writeInt32LE(value, 24 + index * 4));
  emf.write(' EMF', 40, 'latin1');
  const standardWmfHeader = () => {
    const header = Buffer.alloc(18);
    header.writeUInt16LE(1, 0); header.writeUInt16LE(9, 2); header.writeUInt16LE(0x0300, 4);
    return header;
  };
  const eof = Buffer.from([3, 0, 0, 0, 0, 0]);
  const placeable = Buffer.alloc(22);
  placeable.writeUInt32LE(0x9AC6CDD7, 0);
  [0, 0, 300, 100].forEach((value, index) => placeable.writeInt16LE(value, 6 + index * 2));
  placeable.writeUInt16LE(1440, 14);
  const windowExt = Buffer.alloc(10);
  windowExt.writeUInt32LE(5, 0); windowExt.writeUInt16LE(0x020C, 4); windowExt.writeInt16LE(100, 6); windowExt.writeInt16LE(250, 8);
  return [
    ['tiff', 'tif', tiff, 'image/tiff', 3, 2],
    ['emf', 'emf', emf, 'image/x-emf', 4000, 2000],
    ['wmf', 'wmf', Buffer.concat([placeable, standardWmfHeader(), eof]), 'image/x-wmf', 300, 100],
    ['wmf-standard', 'wmf', Buffer.concat([standardWmfHeader(), windowExt, eof]), 'image/x-wmf', 250, 100],
  ];
}

/** 用真实图片检查后缀错配、Word 内类型及比例，确认源字节不变，以及单张图片无法导出时原位提示且不中断转换。 */
async function checkImageFormats(helper, directory, png) {
  const { imageSize } = require('image-size');
  const assetRoot = path.join(directory, '图片格式检查');
  fs.mkdirSync(assetRoot, { recursive: true });
  const samples = [
    ['png', 'png', png],
    ['jpeg', 'jpg', Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/IvxD/yH9S/6+Zv/AEM1j1seIf8AkP6l/wBfM3/oZrHr+qD+1D//2Q==', 'base64')],
    ['gif', 'gif', Buffer.from('R0lGODdhAgABAJEAAAAAAAAA//8AAP///yH5BAQAAAAALAAAAAACAAEAAAICVAoAOw==', 'base64')],
    ['bmp', 'bmp', Buffer.from('Qk0+AAAAAAAAADYAAAAoAAAAAgAAAP////8BABgAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wAAAAA=', 'base64')],
    ['webp', 'webp', fs.readFileSync(path.join(__dirname, '../assets/content-template-preview/standard-quality-control.webp'))],
  ];
  const images = [
    ...samples.map(([type, extension, bytes]) => ({ type, extension, bytes, contentType: `image/${type}`, ...imageSize(bytes) })),
    ...metafileSamples().map(([type, extension, bytes, contentType, width, height]) => ({ type, extension, bytes, contentType, width, height })),
  ].flatMap(image => [image.extension, image.extension === 'png' ? 'jpg' : 'png']
    .map((suffix, index) => ({ ...image, reference: `${image.type}-${index} 中文图.${suffix}` })));
  const figure = reference => '<figure data-yb-size="wide" data-yb-fit="contain"><img data-yb-asset-ref="' + reference + '"></figure>';
  for (const image of images) fs.writeFileSync(path.join(assetRoot, image.reference), image.bytes);
  const html = images.map(image => figure(image.reference)).join('');
  const config = cloneDefaultExportFormat();
  // 读取图片在 Word 包内的部件、声明类型和画框比例。
  const embedded = ({ zip, $, rels }, drawing) => {
    const id = $(drawing).find('a\\:blip').attr('r:embed');
    const target = rels('Relationship').filter((_, element) => rels(element).attr('Id') === id).attr('Target');
    assert.ok(target, id);
    const entry = target.startsWith('/') ? target.slice(1) : path.posix.join('word', target);
    const types = cheerio.load(zip.readAsText('[Content_Types].xml'), { xmlMode: true });
    const contentType = types('Override').filter((_, element) => types(element).attr('PartName') === '/' + entry).attr('ContentType')
      || types('Default').filter((_, element) => types(element).attr('Extension') === path.posix.extname(entry).slice(1)).attr('ContentType');
    const extent = $(drawing).find('wp\\:extent');
    return { bytes: zip.readFile(entry), contentType, ratio: Number(extent.attr('cx')) / Number(extent.attr('cy')) };
  };
  for (const wholeDocument of [false, true]) {
    const render = body => helper.createRestrictedHtmlDocx(wholeDocument
      ? '<section data-yb-export-template="true" data-yb-export-page-template="true">' + body + '</section>' : body,
    config, { assetRoot, copyAssets: true, wholeDocument });
    const output = await render(html);
    assert.deepEqual(output.imageWarnings, []);
    const document = readWord(Buffer.from(output.bytes));
    const drawings = document.$('w\\:drawing').toArray();
    assert.equal(drawings.length, images.length);
    images.forEach((image, index) => {
      const result = embedded(document, drawings[index]);
      assert.equal(result.contentType, image.contentType, image.reference);
      assert.deepEqual(result.bytes, image.bytes, 'Word 应保留原始图片字节');
      assert.ok(Math.abs(result.ratio - image.width / image.height) < 0.00001, '图片应按真实宽高比例排版：' + image.reference);
      assert.deepEqual(fs.readFileSync(path.join(assetRoot, image.reference)), image.bytes, '源图片不可改写');
    });

    // 能按文件头识别但读不到尺寸：原字节按 wide 画框（3:2）放置，不报错。
    const invalidSize = Buffer.from(png);
    invalidSize.writeInt32BE(0, 16);
    for (const [name, bytes] of [['截断图片.png', png.subarray(0, 12)], ['零宽图片.png', invalidSize]]) {
      fs.writeFileSync(path.join(assetRoot, name), bytes);
      const fallback = await render(figure(name));
      assert.deepEqual(fallback.imageWarnings, [], name);
      const fallbackWord = readWord(Buffer.from(fallback.bytes));
      const result = embedded(fallbackWord, fallbackWord.$('w\\:drawing')[0]);
      assert.equal(result.contentType, 'image/png', name);
      assert.ok(Math.abs(result.ratio - 1.5) < 0.001, '尺寸未知时按画框放置：' + name);
    }

    // 文件头无法识别、扩展名声明了无法核对的图片类型：按声明类型原样嵌入，交给 Word 显示。
    const jxr = Buffer.concat([Buffer.from([0x49, 0x49, 0xBC, 0x01]), Buffer.alloc(28, 7)]);
    fs.writeFileSync(path.join(assetRoot, '原样嵌入.wdp'), jxr);
    const passthrough = await render(figure('原样嵌入.wdp'));
    assert.deepEqual(passthrough.imageWarnings, []);
    const passthroughWord = readWord(Buffer.from(passthrough.bytes));
    const declared = embedded(passthroughWord, passthroughWord.$('w\\:drawing')[0]);
    assert.equal(declared.contentType, 'image/vnd.ms-photo');
    assert.deepEqual(declared.bytes, jxr, '未知格式应保留原始字节');
    assert.ok(Math.abs(declared.ratio - 1.5) < 0.001, '未知格式按画框放置');

    // 无法识别且扩展名与内容不符：原位改为文字提示并保留图注，其余图文照常导出。
    fs.writeFileSync(path.join(assetRoot, '非图片.png'), Buffer.from('这是一段文字，不是图片', 'utf8'));
    const mixed = await render(`<p>图前正文</p><figure data-yb-size="wide"><img alt="坏图说明" data-yb-asset-ref="非图片.png"><figcaption>坏图图注</figcaption></figure>${figure(images[0].reference)}<p>图后正文</p>`);
    assert.deepEqual(mixed.imageWarnings, [{ assetRef: '非图片.png', reason: '无法识别图片格式' }]);
    const mixedWord = readWord(Buffer.from(mixed.bytes));
    const text = mixedWord.$('w\\:body').text();
    for (const expected of ['图前正文', '[图片无法导出：坏图说明]', '坏图图注', '图后正文']) assert.ok(text.includes(expected), expected);
    assert.ok(!text.includes('YIBIAO'), '图注标记应被移除');
    assert.equal(mixedWord.$('w\\:drawing').length, 1, '其他图片照常导出');
  }
  console.log('图片格式：整本/小节的八种真实格式、后缀错配、Word 类型、尺寸比例、原字节保留、尺寸兜底、未知格式原样嵌入及坏图原位提示通过。');
}

/** 检查混合范围、排序编号、图片表格、错误定位，以及源文件不受导出影响。 */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '整本Word导出检查-'));
  const workspaceDir = path.join(directory, '正文 Agent 会话');
  const app = new EventEmitter();
  app.isPackaged = Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR);
  app.getPath = () => path.join(directory, '独立用户数据');
  app.getAppPath = () => path.resolve(__dirname, '..');
  const helper = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
  const firstId = 'ffffffff-0000-4000-8000-000000000001';
  const secondId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const figure = '<figure data-yb-size="wide" data-yb-fit="contain"><img data-yb-asset-ref="原图/现场 图片.png"><figcaption>现场图注</figcaption></figure>';
  const mixedTables = '<table><tbody><tr><td>三列甲</td><td>三列乙</td><td>三列丙</td></tr></tbody></table>'
    + '<table><thead><tr><th>四列表头甲</th><th>四列表头乙</th><th>四列表头丙</th><th>四列表头丁</th></tr></thead><tbody><tr><td rowspan="2">四列纵向合并</td><td colspan="2">四列横向合并</td><td>四列首行末格</td></tr><tr><td>四列次行乙</td><td>四列次行丙</td><td>四列次行丁</td></tr></tbody></table>';
  const fusedLabels = ['现场施工正文', '施工检查清单', '设备表题', '吊车', '三列甲', '三列丙', '四列横向合并', '四列次行丁', '现场图注'];
  const body = `<!-- yibiao:block --><p>现场施工正文</p><ul><li>施工检查清单</li></ul><table><caption>设备表题</caption><thead><tr><th>设备</th><th>数量</th></tr></thead><tbody><tr><td>吊车</td><td>一台</td></tr></tbody></table>${mixedTables}${figure}`;
  const state = {
    exportTemplateId: 'current', exportTemplateScope: 'ai-only',
    outlineData: { project_name: '中文 & 项目', outline: [
      { id: 'parent', title: '混合父标题', children: [
        { id: firstId, title: '施工 & 安全', content_mode: 'ai-generate', content: '数据库陈旧正文' },
        { id: 'manual', title: '人工资料', content_mode: 'manual-fill', content: `人工正文\n\n- 人工清单\n\n![人工图](data:image/png;base64,${png.toString('base64')})` },
        { id: secondId, title: '交付节点', content_mode: 'ai-generate' },
      ] },
      { id: 'pending', title: '模板节点', content_mode: 'template-fill' },
    ] },
  };
  const config = cloneDefaultExportFormat();
  assert.equal(config.heading_border.include_headings, true);
  assert.equal(normalizeExportFormat({ heading_border: { enabled: true } }).heading_border.include_headings, true);
  assert.equal(normalizeExportFormat({ heading_border: { enabled: true, include_headings: false } }).heading_border.include_headings, false);
  assert.equal(config.heading_border.heading_bottom_border_space_pt, 1);
  assert.equal(config.heading_border.heading_bottom_border_enabled, false);
  const visualTemplates = ['tpl-system-a4-visual', 'tpl-system-a3-landscape-visual'].map(id => SYSTEM_EXPORT_TEMPLATES.find(template => template.template_id === id));
  for (const template of visualTemplates) {
    assert.ok(template);
    assert.equal(template.config.heading_border.heading_top_border_space_pt, 5);
    assert.equal(template.config.heading_border.heading_bottom_border_space_pt, 4);
    assert.equal(template.config.heading_border.heading_bottom_border_enabled, true);
    assert.ok(template.config.headings.every(heading => heading.line_spacing === 1.2 && heading.spacing_before_pt === 0 && heading.spacing_after_pt === 0));
    assert.equal(normalizeExportFormat(template.config).heading_border.heading_top_border_space_pt, 5);
    assert.equal(normalizeExportFormat(template.config).heading_border.heading_bottom_border_space_pt, 4);
    assert.equal(normalizeExportFormat(template.config).heading_border.heading_bottom_border_enabled, true);
  }
  Object.assign(config.heading_border, visualTemplates[0].config.heading_border);
  config.headings = visualTemplates[0].config.headings.map(heading => ({ ...heading }));
  Object.assign(config.page, { paper_size: 'a3', orientation: 'landscape', two_column: true,
    header_enabled: true, header_text: '当前模板页眉', footer_enabled: true, footer_text: '当前模板页脚',
    page_number_enabled: true, page_number_start: 7, first_page_different: true });
  Object.assign(config.body_text, { font: '楷体', size: '三号', list_style: 'square', list_indent_chars: 3 });
  config.headings.forEach(heading => { heading.numbering_format = 'custom'; heading.numbering_template = '{full}'; });
  config.heading_border.enabled = true;
  const exporter = createTechnicalPlanExport({
    technicalPlanStore: { loadTechnicalPlan: () => state },
    templateStore: { getTemplate: () => ({ config }) },
    agentService: { loadPersistentTask: () => ({ paths: { workspaceDir } }) },
    openXmlHelperService: helper,
  });
  const progress = [];
  const build = () => exporter.build(exporter.prepare(), { onProgress: event => progress.push(event.progress), stats: {} });
  try {
    await checkImageFormats(helper, directory, png);
    await checkOrderedListRestart(helper, directory);
    fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '原图'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '原图/现场 图片.png'), png);
    fs.writeFileSync(path.join(workspaceDir, `正文/${firstId}.html`), body, 'utf8');
    fs.writeFileSync(path.join(workspaceDir, `正文/${secondId}.html`), '<p>交付验收正文</p><ul><li>交付检查清单</li></ul>', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文/已删除小节.html'), '<p>不能导出的孤儿正文</p><img data-yb-asset-ref="不存在.png">', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文/parent.html'), '<p>父章节不应带出的旧正文</p>', 'utf8');
    // 清单只有最后一次任务的一节；整本导出必须仍包含全部当前目录。
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: [{ section_id: secondId }] }), 'utf8');
    for (const scope of ['ai-only', 'document']) {
      state.exportTemplateScope = scope;
      const { buffer } = await build();
      const document = readWord(buffer);
      saveArtifact(`whole-${scope}`, document);
      const { zip, $, rels, paragraph } = document;
      const text = $('w\\:body').text();
      for (const expected of ['1 混合父标题', '1.1 施工 & 安全', '1.2 人工资料', '1.3 交付节点', '2 模板节点', '待模板填写', '现场图注', '设备表题', '人工正文']) assert.ok(text.includes(expected), expected);
      assert.ok(text.indexOf('施工 & 安全') < text.indexOf('交付节点'));
      assert.ok(!text.includes('数据库陈旧正文'));
      assert.ok(!text.includes('不能导出的孤儿正文'));
      assert.ok(!text.includes('父章节不应带出的旧正文'));
      assert.ok(!text.includes('YIBIAO'));
      assert.equal($('w\\:drawing').length, 2);
      const drawingIds = $('wp\\:docPr').toArray().map(element => $(element).attr('id'));
      assert.equal(new Set(drawingIds).size, drawingIds.length, '各样式范围的绘图编号不可重复');
      checkFlatTables(document);
      const firstFrame = checkFusedBody(document, fusedLabels);
      assert.notEqual(paragraph('交付验收正文').closest('w\\:tbl')[0], firstFrame[0], '不同标题之间不能合并页框表');
      assert.ok(zip.getEntries().some(entry => /(^|\/)media\//.test(entry.entryName)));
      assert.equal(paragraph('混合父标题').find('w\\:pBdr').length, scope === 'document' ? 1 : 0);
      for (const label of ['人工正文', '待模板填写']) {
        assert.equal(paragraph(label).closest('w\\:tbl').length, scope === 'document' ? 1 : 0, label);
        assert.equal(paragraph(label).find('w\\:pBdr').length, 0, label);
      }
      assert.equal(paragraph('交付验收正文').closest('w\\:tbl').length, 1);
      assert.equal(paragraph('设备表题').find('w\\:spacing').attr('w:after'), '0');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:top').attr('w:space'), '5');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:bottom').attr('w:color'), config.heading_border.border_color.slice(1).toUpperCase());
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:bottom').attr('w:space'), '4');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:spacing').attr('w:line'), '288');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:spacing').attr('w:after'), '0');
      assert.equal(paragraph('现场施工正文').find('w\\:bottom').length, 0);
      assert.equal(paragraph('现场施工正文').find('w\\:rFonts').first().attr('w:eastAsia'), '楷体');
      assert.equal(paragraph('人工正文').find('w\\:rFonts').first().attr('w:eastAsia'), scope === 'document' ? '楷体' : '宋体');
      assert.equal($('w\\:pgNumType[w\\:start="7"]').length, 1);
      assert.equal($('w\\:titlePg').length, 0);
      assert.equal($('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 0);
      const headerTexts = $('w\\:sectPr').toArray().map(section => {
        const id = $(section).find('w\\:headerReference[w\\:type="default"]').attr('r:id');
        const target = rels('Relationship').filter((_, element) => rels(element).attr('Id') === id).attr('Target');
        assert.ok(target, `页眉关系 ${id} 不存在：${$.xml(section)}`);
        return zip.readAsText(target.startsWith('/') ? target.slice(1) : path.posix.join('word', target));
      });
      assert.ok(headerTexts.some(header => header.includes('当前模板页眉')));
      assert.equal(headerTexts.some(header => !header.includes('当前模板页眉')), scope === 'ai-only');
      // 列表样式单独引用：人工清单不继承模板方块项目符号。
      const numbering = cheerio.load(zip.readAsText('word/numbering.xml'), { xmlMode: true });
      const bullet = label => {
        const id = paragraph(label).find('w\\:numId').attr('w:val');
        const abstract = numbering(`w\\:num[w\\:numId="${id}"]`).find('w\\:abstractNumId').attr('w:val');
        return numbering(`w\\:abstractNum[w\\:abstractNumId="${abstract}"]`).find('w\\:lvlText').first().attr('w:val');
      };
      assert.equal(bullet('施工检查清单'), bullet('交付检查清单'));
      if (scope === 'ai-only') assert.notEqual(bullet('施工检查清单'), bullet('人工清单'));
      else assert.equal(bullet('施工检查清单'), bullet('人工清单'));
    }
    // 整本导出忽略首页不同：两种范围、商务在前/AI 在前的开关结果均相同。
    const originalOutline = state.outlineData.outline;
    for (const outline of [originalOutline, [...originalOutline].reverse()]) {
      state.outlineData.outline = outline;
      for (const scope of ['ai-only', 'document']) {
        state.exportTemplateScope = scope;
        const outputs = [];
        for (const enabled of [false, true]) {
          config.page.first_page_different = enabled;
          const result = readWord((await build()).buffer);
          assert.equal(config.page.first_page_different, enabled, '导出不得改写用户配置');
          assert.equal(result.$('w\\:titlePg').length, 0);
          assert.equal(result.$('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 0);
          outputs.push(result.zip.getEntries()
            .filter(entry => /^word\/(document|header\d+|footer\d+)\.xml$/.test(entry.entryName))
            .sort((a, b) => a.entryName.localeCompare(b.entryName))
            // 关系 ID 每次随机生成，不参与版式比较。
            .map(entry => [entry.entryName, result.zip.readAsText(entry.entryName).replace(/\br:(id|embed|link)="[^"]*"/g, 'r:$1="relationship"')]));
        }
        assert.deepEqual(outputs[0], outputs[1], `${scope} 勾选首页不同不应改变正文和页眉页脚`);
      }
    }
    state.outlineData.outline = originalOutline;
    // 同一份样张覆盖六级导航、混合网格、标题开关以及预览/小节的统一转换入口。
    const previewAssetRoot = '检查预览配图';
    const previewImages = path.join(app.getPath(), 'workspace', previewAssetRoot, '原图');
    fs.mkdirSync(previewImages, { recursive: true });
    fs.writeFileSync(path.join(previewImages, '现场 图片.png'), png);
    const sampleHtml = Array.from({ length: 6 }, (_, index) => `<h${index + 1}>导航样张${index + 1}</h${index + 1}>${index === 0 ? body : `<p>级别正文${index + 1}</p>`}`).join('');
    const renderSample = async (preview, format = config, html = sampleHtml) => readWord(Buffer.from((await (preview
      ? helper.renderRestrictedHtmlDocx(html, format, { assetRoot: previewAssetRoot })
      : helper.createRestrictedHtmlDocx(html, format, { assetRoot: workspaceDir, copyAssets: true }))).bytes));
    const sample = await renderSample(false);
    saveArtifact('sample-heading-frame', sample);
    const preview = await renderSample(true);
    for (const document of [sample, preview]) {
      checkFlatTables(document);
      checkFusedBody(document, fusedLabels);
      checkHeadings(document, true);
      assert.equal(document.$('w\\:drawing').length, 1);
      assert.equal(document.$('w\\:tbl').length, 6, '每级标题之间独立成表，不能吞掉中间标题');
    }
    const missingOption = structuredClone(config);
    delete missingOption.heading_border.include_headings;
    checkHeadings(await renderSample(false, missingOption), true, sample);
    config.heading_border.include_headings = false;
    for (const isPreview of [false, true]) {
      const document = await renderSample(isPreview);
      if (!isPreview) saveArtifact('sample-no-heading-frame', document);
      checkHeadings(document, false, sample);
      checkFlatTables(document);
      checkFusedBody(document, fusedLabels);
      assert.equal(document.$('w\\:body').text(), sample.$('w\\:body').text(), '标题边框开关不能丢失或重复正文');
      assert.equal(document.$('w\\:drawing').length, 1);
    }
    const noHeading = await renderSample(false, config, body);
    checkFlatTables(noHeading);
    checkFusedBody(noHeading, fusedLabels);
    assert.equal(noHeading.$('w\\:tbl').length, 1, '无标题的小节正文也需要页框');
    assert.equal(noHeading.$('w\\:body').text(), cheerio.load(body, null, false).text(), '正文、列表、表格和图注文字必须逐字保留');
    assert.equal(noHeading.$('w\\:drawing').length, 1);
    const noHeadingFrame = readWord((await build()).buffer);
    assert.equal(noHeadingFrame.paragraph('施工 & 安全').find('w\\:pBdr').length, 0, '整本导出也应遵循标题边框开关');
    assert.equal(noHeadingFrame.paragraph('施工 & 安全').parent()[0], noHeadingFrame.$('w\\:body')[0]);
    checkFusedBody(noHeadingFrame, fusedLabels);
    config.heading_border.include_headings = true;
    assert.equal(sample.$('w\\:titlePg').length, 1);
    assert.equal(sample.$('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 2);
    console.log('整本/小节/样张预览：六级顶层导航、标题开关、平面融合表、合并单元格及模板范围检查通过。');
    // 切换导出时模板、重排目录，不依赖生成时的快照与编号。
    const children = state.outlineData.outline[0].children;
    [children[0], children[2]] = [children[2], children[0]];
    config.body_text.font = '仿宋';
    config.heading_border.enabled = false;
    let word = readWord((await build()).buffer);
    assert.ok(word.$('w\\:body').text().includes('1.1 交付节点'));
    assert.equal(word.paragraph('现场施工正文').closest('w\\:tbl').length, 0, '关闭章节页框后正文恢复顶层');
    assert.equal(word.$('w\\:tbl').length, 3, '关闭章节页框后只保留原业务表');
    const plainRows = word.$('w\\:tr').toArray();
    const plainHeaders = plainRows.filter(row => word.$(row).find('w\\:t').toArray()
      .some(text => ['设备', '四列表头甲'].includes(word.$(text).text())));
    assert.equal(plainHeaders.length, 2, '关闭章节页框后两个业务表头都应保留');
    for (const row of plainRows) {
      const properties = word.$(row).children('w\\:trPr');
      const isHeader = plainHeaders.includes(row);
      assert.equal(properties.children('w\\:cantSplit').length, isHeader ? 1 : 0, '普通业务表仍只禁止拆分表头行');
      assert.equal(properties.children('w\\:tblHeader').length, isHeader ? 1 : 0, '未融合业务表应继续保留跨页重复表头');
    }
    assert.equal(word.$('w\\:pBdr').length, 0);
    assert.equal(word.$('w\\:drawing').length, 2);
    assert.equal(word.paragraph('现场施工正文').find('w\\:rFonts').first().attr('w:eastAsia'), '仿宋');
    assert.ok(word.$('w\\:cols[w\\:num="1"]').length > 0);
    assert.ok(word.$('w\\:cols[w\\:num="2"]').length > 0);
    assert.equal(word.$('w\\:pgNumType[w\\:start="7"]').length, 1);
    assert.equal(fs.readFileSync(path.join(workspaceDir, `正文/${firstId}.html`), 'utf8'), body);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, '原图/现场 图片.png')), png);
    const original = path.join(workspaceDir, `正文/${secondId}.html`);
    const originalBody = fs.readFileSync(original, 'utf8');
    // 用户导出跳过未完成小节：保留标题和占位并逐节提示，其他小节照常导出；格式自检仍严格报错。
    const expectSkipped = async ({ title, reason, skippedText, keptText }) => {
      const output = await build();
      assert.equal(output.warnings.length, 1);
      assert.match(output.warnings[0], new RegExp(`${title}.*${reason}`));
      assert.match(output.message, /1 个 AI 小节未完成/);
      const text = readWord(output.buffer).$('w\\:body').text();
      assert.ok(text.includes(title) && text.includes('[本小节未完成，未导出正文]'), '未完成小节应保留标题和占位');
      assert.ok(!text.includes(skippedText), '未完成小节不应导出正文');
      assert.ok(text.includes(keptText), '其他小节应照常导出');
    };
    const layoutBuild = () => exporter.build(exporter.prepare(), { stats: {}, layoutCheck: true });
    fs.renameSync(original, `${original}.missing`);
    await expectSkipped({ title: '交付节点', reason: '正文未生成', skippedText: '交付验收正文', keptText: '现场施工正文' });
    await assert.rejects(layoutBuild(), /交付节点.*正文文件不存在/s);
    fs.renameSync(`${original}.missing`, original);
    fs.writeFileSync(original, '', 'utf8');
    await expectSkipped({ title: '交付节点', reason: '正文未生成', skippedText: '交付验收正文', keptText: '现场施工正文' });
    fs.writeFileSync(original, `${originalBody}<figure data-yb-size="wide"><img alt="未回填图片"><figcaption>未回填图注</figcaption></figure>`, 'utf8');
    await expectSkipped({ title: '交付节点', reason: '有图片未生成完成', skippedText: '交付验收正文', keptText: '现场施工正文' });
    await assert.rejects(layoutBuild(), /交付节点.*data-yb-asset-ref/s);
    fs.writeFileSync(original, originalBody, 'utf8');
    fs.renameSync(path.join(workspaceDir, '原图/现场 图片.png'), path.join(workspaceDir, '原图/暂存.png'));
    await expectSkipped({ title: '施工 & 安全', reason: '有图片未生成完成', skippedText: '现场施工正文', keptText: '交付验收正文' });
    await assert.rejects(layoutBuild(), /施工 & 安全.*现场 图片/s);
    fs.renameSync(path.join(workspaceDir, '原图/暂存.png'), path.join(workspaceDir, '原图/现场 图片.png'));
    // 单张图片无法导出：原位改为文字提示并按小节提示，其余图文照常导出；格式自检同样不中断。
    fs.writeFileSync(path.join(workspaceDir, '原图/坏图.png'), Buffer.from('不是图片', 'utf8'));
    fs.writeFileSync(original, `${originalBody}<figure data-yb-size="wide"><img data-yb-asset-ref="原图/坏图.png"><figcaption>坏图图注</figcaption></figure>`, 'utf8');
    const manual = children.find(child => child.id === 'manual');
    const manualContent = manual.content;
    manual.content = `${manualContent}\n\n![坏人工图](不存在的人工图.png)`;
    const imageOutput = await build();
    assert.ok(imageOutput.warnings.some(warning => /交付节点 有 1 张图片无法导出.*无法识别图片格式/.test(warning)), imageOutput.warnings.join('\n'));
    assert.ok(imageOutput.warnings.some(warning => /人工资料 有 1 张图片无法导出/.test(warning)), imageOutput.warnings.join('\n'));
    assert.match(imageOutput.message, /2 张图片无法导出，已在原位置用文字标出/);
    const imageWord = readWord(imageOutput.buffer);
    const imageText = imageWord.$('w\\:body').text();
    for (const expected of ['交付验收正文', '[图片无法导出]', '坏图图注', '[图片无法导出：坏人工图]', '现场施工正文']) assert.ok(imageText.includes(expected), expected);
    assert.equal(imageWord.$('w\\:drawing').length, 2, '其他图片照常导出');
    assert.ok((await layoutBuild()).buffer.length > 0, '格式自检遇到坏图不中断');
    manual.content = manualContent;
    fs.writeFileSync(original, originalBody, 'utf8');
    const withoutWorkspace = createTechnicalPlanExport({
      technicalPlanStore: { loadTechnicalPlan: () => state },
      templateStore: { getTemplate: () => ({ config }) },
      agentService: { loadPersistentTask: () => null },
      openXmlHelperService: helper,
    });
    const empty = await withoutWorkspace.build(withoutWorkspace.prepare(), { stats: {} });
    assert.equal(empty.warnings.length, 2);
    assert.match(empty.message, /2 个 AI 小节未完成/);
    assert.ok(readWord(empty.buffer).$('w\\:body').text().includes('人工正文'), '工作区不存在时非 AI 小节照常导出');
    console.log('未完成小节：缺失、空正文、缺引用、缺图片及无工作区均跳过正文并提示，格式自检保持严格报错；坏图原位提示且不中断导出。');
    // 前一节 figure 未闭合、后面还有图：导出前列出问题；继续导出时按节修复，后续小节和图片不再被吞并；格式自检保持严格。
    const unclosed = `${originalBody}${figure.replace('</figure>', '')}`;
    fs.writeFileSync(original, unclosed, 'utf8');
    const structureIssues = exporter.inspect(exporter.prepare());
    assert.deepEqual(structureIssues.map(issue => issue.section), ['1.1 交付节点']);
    assert.ok(structureIssues[0].problems.some(problem => problem.includes('缺少结束标签 </figure>')));
    const repairedOutput = await build();
    assert.ok(repairedOutput.warnings.some(warning => /交付节点.*正文结构不完整.*已自动修复/.test(warning)));
    assert.match(repairedOutput.message, /1 个小节正文结构不完整，已自动修复/);
    const repairedWord = readWord(repairedOutput.buffer);
    for (const text of ['交付验收正文', '人工正文', '现场施工正文']) assert.ok(repairedWord.$('w\\:body').text().includes(text), text);
    assert.equal(repairedWord.$('w\\:drawing').length, 3, '修复后三张图均导出');
    await assert.rejects(layoutBuild(), /交付节点.*正文结构不完整/s);
    fs.writeFileSync(original, originalBody, 'utf8');
    assert.deepEqual(exporter.inspect(exporter.prepare()), []);
    // 提示词结束标签写成工具调用标记：图片、图注及本节后续正文并入模板；继续导出时补齐标签，图片和正文均保留。
    fs.writeFileSync(original, `<figure data-yb-size="wide" data-yb-fit="contain"><template data-yb-role="prompt">现场提示词</｜｜DSML｜｜ parameter>\n<img data-yb-asset-ref="原图/现场 图片.png"><figcaption>标记图注</figcaption></figure>\n${originalBody}`, 'utf8');
    const markedIssues = exporter.inspect(exporter.prepare());
    assert.match(markedIssues[0].problems[0], /第 1 行出现异常结束标记/);
    const markedOutput = await build();
    assert.ok(markedOutput.warnings.some(warning => /交付节点.*补齐 1 处提示词结束标签/.test(warning)));
    const markedWord = readWord(markedOutput.buffer);
    for (const text of ['标记图注', '交付验收正文', '人工正文', '现场施工正文']) assert.ok(markedWord.$('w\\:body').text().includes(text), text);
    assert.equal(markedWord.$('w\\:drawing').length, 3, '补齐后图片不随 figure 删除');
    fs.writeFileSync(original, originalBody, 'utf8');
    console.log('正文结构：未闭合 figure 及提示词异常标记导出前提示、继续导出按节修复且不丢图文、格式自检严格报错。');
    assert.equal(fs.readdirSync(path.join(app.getPath(), 'workspace')).some(name => name.startsWith('restricted-html-assets-')), false);
    assert.ok(progress.includes(55));
    assert.ok(progress.every(value => value < 100));
    if (process.versions.electron) await checkIpc(exporter, directory, { label: '1.1 交付节点',
      apply: () => fs.writeFileSync(original, unclosed, 'utf8'), restore: () => fs.writeFileSync(original, originalBody, 'utf8') });
    // 一份较长正文覆盖整本转换，不额外构造多套测试框架。
    fs.writeFileSync(original, '<p>这是长篇技术方案正文，用于检查整本转换时是否完整保留段落。</p>'.repeat(3000), 'utf8');
    const started = performance.now();
    word = readWord((await build()).buffer);
    assert.equal(word.$('w\\:p').filter((_, element) => word.$(element).text().includes('这是长篇技术方案正文')).length, 3000);
    console.log(`整本导出检查通过；3000 段正文转换 ${(performance.now() - started).toFixed(0)} ms。`);
  } finally {
    await helper.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('整本Word导出检查-')) fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--ipc') && !process.versions.electron) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), '整本导出IPC-'));
  const env = { ...process.env, YIBIAO_WORD_EXPORT_CHECK_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, '--ipc'], { env, stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1;
  } finally {
    if (path.dirname(userData) === path.resolve(os.tmpdir()) && path.basename(userData).startsWith('整本导出IPC-')) fs.rmSync(userData, { recursive: true, force: true });
  }
} else if (process.versions.electron) {
  const { app } = require('electron');
  app.setPath('userData', process.env.YIBIAO_WORD_EXPORT_CHECK_DIR);
  app.on('window-all-closed', () => {});
  app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
