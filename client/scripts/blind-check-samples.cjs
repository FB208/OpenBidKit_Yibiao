// 暗标检查与修复验证共用的 docx 样本构造：手工拼 OOXML，只放检查用到的 part，
// 以及带元数据的 JPEG / PNG、含文字的 EMF / WMF 等图片样本。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(' ');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function run(text, rPr = '') {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function para(content, pPr = '') {
  const runs = typeof content === 'string' ? run(content) : content.join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

function cell(content, tcPr = '') {
  return `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/>${tcPr}</w:tcPr>${content}</w:tc>`;
}

function table(rows, tblStyle = '') {
  return `<w:tbl><w:tblPr>${tblStyle ? `<w:tblStyle w:val="${tblStyle}"/>` : ''}<w:tblW w:w="0" w:type="auto"/></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${rows.map((cells) => `<w:tr>${cells.join('')}</w:tr>`).join('')}</w:tbl>`;
}

function sectPr({ left = 1417, cols = 1, headerRid = '', footerRid = '', docGrid = '' } = {}) {
  return `<w:sectPr>${headerRid ? `<w:headerReference w:type="default" r:id="${headerRid}"/>` : ''}`
    + `${footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : ''}`
    + '<w:pgSz w:w="11906" w:h="16838"/>'
    + `<w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="${left}" w:header="851" w:footer="992" w:gutter="0"/>`
    + `<w:cols w:num="${cols}" w:space="425"/>${docGrid ? `<w:docGrid w:type="${docGrid}" w:linePitch="312"/>` : ''}</w:sectPr>`;
}

/** WPS 插入的页码：段落里一个水平居中的文本框，框内只有 PAGE 域；DrawingML 主副本和 VML 回退副本各一份。 */
function pageNumberTextbox(number = '1') {
  const field = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> PAGE  \\* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + `<w:r><w:t>${number}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  return '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
    + '<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
    + '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>'
    + '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="1828800"/>'
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="1" name="文本框 1"/><wp:cNvGraphicFramePr/>'
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/>'
    + `<wps:txbx><w:txbxContent>${field}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor>`
    + `</w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="mso-position-horizontal:center"><v:textbox><w:txbxContent>${field}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>`
    + '</mc:AlternateContent></w:r></w:p>';
}

/** 编号级别定义（w:lvl），供 buildDocx 的 numbering 选项拼 abstractNum。 */
function numberingLevel(ilvl, format, text) {
  return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`;
}

/** 正文中引用图片的段落；ImageCatalog 只看 r:embed，省略 pic 包装。 */
function imagePara(rid) {
  return `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="宋体"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="宋体"/></a:minorFont>
</a:fontScheme></a:themeElements></a:theme>`;

// 默认字体只写主题引用、真正字体名在主题的 Hans 脚本表里（WPS 常见写法）；正文首行缩进 2 字符来自样式。
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="500" w:lineRule="exact"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="560"/><w:jc w:val="both"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="a"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="3"><w:name w:val="heading 3"/><w:basedOn w:val="a"/><w:qFormat/><w:pPr><w:outlineLvl w:val="2"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="10"><w:name w:val="toc 1"/><w:basedOn w:val="a"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8296"/></w:tabs><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="BoldBody"><w:name w:val="加粗正文"/><w:basedOn w:val="a"/><w:rPr><w:b/><w:i/><w:color w:val="FF0000"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:rPr><w:sz w:val="21"/></w:rPr><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="a3"><w:name w:val="Table Normal"/></w:style>
<w:style w:type="table" w:styleId="LightShading"><w:name w:val="Light Shading Accent 1"/><w:basedOn w:val="TableNormal"/></w:style>
</w:styles>`;

/** 手工组装 docx：只放检查用到的 part，关系与内容类型完整，Word 也能打开。返回工作区相对路径。 */
function buildDocx(sourceDir, fileName, body, extra = {}) {
  const zip = new AdmZip();
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  ];
  const documentRels = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdTheme" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
  ];
  const rootRels = [`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`];
  const mediaTypes = new Set();
  const addImages = (images, rels) => {
    for (const [id, image] of Object.entries(images || {})) {
      zip.addFile(`word/media/${image.name}`, image.data);
      rels.push(`<Relationship Id="${id}" Type="${REL}/image" Target="media/${image.name}"/>`);
      mediaTypes.add(`<Default Extension="${path.extname(image.name).slice(1)}" ContentType="${image.contentType}"/>`);
    }
  };
  addImages(extra.images, documentRels);
  if (extra.header) {
    zip.addFile('word/header1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS}>${extra.header}</w:hdr>`, 'utf8'));
    documentRels.push(`<Relationship Id="rIdHeader1" Type="${REL}/header" Target="header1.xml"/>`);
    overrides.push('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
    const headerRels = [];
    addImages(extra.headerImages, headerRels);
    if (headerRels.length) {
      zip.addFile('word/_rels/header1.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerRels.join('')}</Relationships>`, 'utf8'));
    }
    // 第二个页眉（第二节用）：关系与第一个页眉相同，共用同一批图片文件。
    if (extra.header2) {
      zip.addFile('word/header2.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS}>${extra.header2}</w:hdr>`, 'utf8'));
      documentRels.push(`<Relationship Id="rIdHeader2" Type="${REL}/header" Target="header2.xml"/>`);
      overrides.push('<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
      if (headerRels.length) {
        zip.addFile('word/_rels/header2.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerRels.join('')}</Relationships>`, 'utf8'));
      }
    }
  }
  if (extra.footer) {
    zip.addFile('word/footer1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:ftr ${NS}>${extra.footer}</w:ftr>`, 'utf8'));
    documentRels.push(`<Relationship Id="rIdFooter1" Type="${REL}/footer" Target="footer1.xml"/>`);
    overrides.push('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>');
  }
  if (extra.comments) {
    zip.addFile('word/comments.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:comments ${NS}>${extra.comments}</w:comments>`, 'utf8'));
    documentRels.push(`<Relationship Id="rIdComments" Type="${REL}/comments" Target="comments.xml"/>`);
    overrides.push('<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>');
  }
  if (extra.footnotes) {
    zip.addFile('word/footnotes.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${NS}>${extra.footnotes}</w:footnotes>`, 'utf8'));
    documentRels.push(`<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`);
    overrides.push('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>');
  }
  if (extra.numbering) {
    zip.addFile('word/numbering.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NS}>${extra.numbering}</w:numbering>`, 'utf8'));
    documentRels.push(`<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`);
    overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>');
  }
  for (const [id, target] of Object.entries(extra.hyperlinks || {})) {
    documentRels.push(`<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${target}" TargetMode="External"/>`);
  }
  if (extra.core) {
    zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${extra.core}</cp:coreProperties>`, 'utf8'));
    rootRels.push('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>');
    overrides.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');
  }
  if (extra.app) {
    zip.addFile('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">${extra.app}</Properties>`, 'utf8'));
    rootRels.push(`<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`);
    overrides.push('<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>');
  }
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaTypes].join('')}${overrides.join('')}</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rootRels.join('')}</Relationships>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documentRels.join('')}</Relationships>`, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`, 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(extra.styles || STYLES, 'utf8'));
  zip.addFile('word/theme/theme1.xml', Buffer.from(THEME, 'utf8'));
  fs.mkdirSync(sourceDir, { recursive: true });
  zip.writeZip(path.join(sourceDir, fileName));
  return `blind-check/source/${fileName}`;
}

function emfWithText(text) {
  const header = Buffer.alloc(88);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(88, 4);
  Buffer.from([0x20, 0x45, 0x4D, 0x46]).copy(header, 40);
  header.writeUInt32LE(0x10000, 44);
  // EXTTEXTOUTW：记录头 8 + 边界 16 + 图形模式与缩放 12，EMRTEXT 从 36 开始，字符串放在 80。
  const chars = Buffer.from(text, 'utf16le');
  const dxOffset = 80 + Math.ceil(chars.length / 4) * 4;
  const size = dxOffset + text.length * 4;
  const record = Buffer.alloc(size);
  record.writeUInt32LE(84, 0);
  record.writeUInt32LE(size, 4);
  record.writeUInt32LE(1, 24);
  record.writeUInt32LE(text.length, 44);
  record.writeUInt32LE(80, 48);
  record.writeUInt32LE(dxOffset, 72);
  chars.copy(record, 80);
  const eof = Buffer.alloc(20);
  eof.writeUInt32LE(14, 0);
  eof.writeUInt32LE(20, 4);
  header.writeUInt32LE(88 + size + 20, 48);
  return Buffer.concat([header, record, eof]);
}

function wmfWithAnsiText(bytes) {
  const padded = bytes.length % 2 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
  const placeable = Buffer.alloc(22);
  placeable.writeUInt32LE(0x9AC6CDD7, 0);
  const header = Buffer.alloc(18);
  header.writeUInt16LE(1, 0);
  header.writeUInt16LE(9, 2);
  header.writeUInt16LE(0x0300, 4);
  const recordBytes = 8 + padded.length + 4;
  const record = Buffer.alloc(recordBytes);
  record.writeUInt32LE(recordBytes / 2, 0);
  record.writeUInt16LE(0x0521, 4);
  record.writeUInt16LE(bytes.length, 6);
  padded.copy(record, 8);
  const eof = Buffer.alloc(6);
  eof.writeUInt32LE(3, 0);
  header.writeUInt32LE((18 + recordBytes + 6) / 2, 6);
  return Buffer.concat([placeable, header, record, eof]);
}

/** TIFF 结构的 EXIF：Artist 字段 + 带纬度的 GPS 段。 */
function exifTiff(artist) {
  const value = Buffer.concat([Buffer.from(artist, 'utf8'), Buffer.alloc(1)]);
  const tiff = Buffer.alloc(56 + value.length + 24);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x013B, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(value.length, 14);
  tiff.writeUInt32LE(56, 18);
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(38, 30);
  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x0002, 40);
  tiff.writeUInt16LE(5, 42);
  tiff.writeUInt32LE(3, 44);
  tiff.writeUInt32LE(56 + value.length, 48);
  value.copy(tiff, 56);
  return tiff;
}

/** JPEG：APP1 里放 EXIF（Artist + GPS），SOF0 给出 64×32 的尺寸。 */
function jpegWithExif(artist) {
  const exif = Buffer.concat([Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0]), exifTiff(artist)]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xFFE1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, exif, sof, Buffer.from([0xFF, 0xD9])]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG：作者写在 tEXt 块，或者（exif 为 true 时）只写在标准 eXIf 块里并带 GPS。 */
function pngWithAuthor(author, { exif = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixels = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    exif ? pngChunk('eXIf', exifTiff(author)) : pngChunk('tEXt', Buffer.concat([Buffer.from('Author', 'latin1'), Buffer.alloc(1), Buffer.from(author, 'utf8')])),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  NS,
  STYLES,
  run,
  para,
  cell,
  table,
  sectPr,
  pageNumberTextbox,
  numberingLevel,
  imagePara,
  buildDocx,
  emfWithText,
  wmfWithAnsiText,
  jpegWithExif,
  pngWithAuthor,
};
