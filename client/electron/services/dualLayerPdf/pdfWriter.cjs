const fs = require('node:fs');
const zlib = require('node:zlib');

/**
 * 双层 PDF 写入器：每页一张整页图片，下面叠一层不可见文字，另带书签。
 * 逐页写文件，内存占用与页数无关；结束时再写页面树、书签和交叉引用表。
 *
 * 不可见文字沿用 Tesseract PDF 输出的做法（src/api/pdfrenderer.cpp，Apache-2.0）：
 * 嵌入一个没有字形的字体，文字按 UTF-16 编码，由 ToUnicode 映射回 Unicode，
 * 各阅读器据此搜索和复制；每段文字用横向缩放撑到原文宽度，保证选中位置与图片上的字对齐。
 */

// Tesseract 的无字形字体 tessdata/pdf.ttf（Apache-2.0），572 字节，每个字形宽半个字高。
const GLYPHLESS_FONT = Buffer.from(
  'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt48WUAAACsAAAANmho'
  + 'ZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABL'
  + 'cG9zdAABAAEAAAIcAAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA'
  + '//8AAAQAAAAAAAQAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAUAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAAB'
  + 'AAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAUAAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAAD'
  + 'ACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAAAAEAAAAA'
  + 'AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
);

/** 字体里每个字形的宽度占字高的比例（DW 500）。 */
const GLYPH_WIDTH_RATIO = 0.5;

const OBJ_CATALOG = 1;
const OBJ_PAGES = 2;
const OBJ_FONT = 3;
const OBJ_CID_FONT = 4;
const OBJ_CID_TO_GID = 5;
const OBJ_FONT_DESCRIPTOR = 6;
const OBJ_FONT_FILE = 7;
const OBJ_TO_UNICODE = 8;
const OBJ_INFO = 9;
const FIRST_FREE_OBJECT = 10;

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 10000) / 10000);
}

/** PDF 文本串：带 BOM 的 UTF-16BE 十六进制，用于书签标题等元数据。 */
function unicodeString(text) {
  return `<FEFF${Buffer.from(String(text || ''), 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

/** 基本平面的编码原样映射成 Unicode；代理区的编码由 supplementaryCodes 分配给超出基本平面的字符。 */
function buildToUnicodeCMap(supplementaryCodes) {
  const blocks = [];
  const pushBlocks = (keyword, entries) => {
    for (let index = 0; index < entries.length; index += 100) {
      const block = entries.slice(index, index + 100);
      blocks.push(`${block.length} begin${keyword}\n${block.join('\n')}\nend${keyword}`);
    }
  };

  const ranges = [];
  for (let high = 0; high < 256; high += 1) {
    if (high >= 0xd8 && high <= 0xdf) continue;
    const prefix = high.toString(16).padStart(2, '0').toUpperCase();
    ranges.push(`<${prefix}00> <${prefix}FF> <${prefix}00>`);
  }
  pushBlocks('bfrange', ranges);
  pushBlocks('bfchar', [...supplementaryCodes].map(([codePoint, code]) => {
    const unicode = Buffer.from(String.fromCodePoint(codePoint), 'utf16le').swap16().toString('hex').toUpperCase();
    return `<${code.toString(16).toUpperCase()}> <${unicode}>`;
  }));

  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/**
 * 一页的不可见文字。每项 { text, matrix, advance }：
 * matrix 是文字矩阵（页面坐标，单位磅，原点在左下角），把 1 个单位的字高映射到页面上；
 * advance 是这段文字沿书写方向在页面上的宽度。
 */
function buildTextOperators(texts, encodeText) {
  const lines = ['BT', '3 Tr'];
  for (const item of texts || []) {
    const text = String(item?.text || '');
    const [a, b, c, d, e, f] = item?.matrix || [];
    const fontSize = Math.hypot(c, d);
    const horizontalScale = Math.hypot(a, b);
    const advance = Number(item?.advance) || 0;
    if (!text || !(fontSize > 0) || !(horizontalScale > 0) || !(advance > 0)) continue;

    const encoded = encodeText(text);
    const naturalWidth = (encoded.length / 2) * GLYPH_WIDTH_RATIO * horizontalScale;
    lines.push(`/F1 ${formatNumber(fontSize)} Tf`);
    lines.push(`${formatNumber((advance / naturalWidth) * 100)} Tz`);
    lines.push(`${[a / fontSize, b / fontSize, c / fontSize, d / fontSize, e, f].map(formatNumber).join(' ')} Tm`);
    lines.push(`<${encoded.toString('hex').toUpperCase()}> Tj`);
  }
  lines.push('ET');
  return lines.join('\n');
}

async function createDualLayerPdfWriter(outputPath) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.promises.open(tempPath, 'w');
  const offsets = new Map();
  const pageObjects = [];
  let position = 0;
  let nextObject = FIRST_FREE_OBJECT;
  // 临时文件已改名为目标文件，或已被删除。
  let settled = false;
  // 超出基本平面的字符（生僻字等）各占用代理区的一个编码：阅读器不一定会把两个代理编码拼成一个字。
  const supplementaryCodes = new Map();

  function encodeText(text) {
    const codes = [];
    for (const char of text) {
      const codePoint = char.codePointAt(0);
      if (codePoint < 0x10000) {
        codes.push(codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint);
      } else if (supplementaryCodes.has(codePoint)) {
        codes.push(supplementaryCodes.get(codePoint));
      } else if (supplementaryCodes.size < 0x800) {
        supplementaryCodes.set(codePoint, 0xd800 + supplementaryCodes.size);
        codes.push(supplementaryCodes.get(codePoint));
      } else {
        codes.push(0xfffd);
      }
    }
    const buffer = Buffer.alloc(codes.length * 2);
    codes.forEach((code, index) => buffer.writeUInt16BE(code, index * 2));
    return buffer;
  }

  async function write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
    await handle.write(buffer, 0, buffer.length, position);
    position += buffer.length;
  }

  async function writeObject(number, dictionary, stream) {
    offsets.set(number, position);
    if (stream) {
      await write(`${number} 0 obj\n${dictionary}\nstream\n`);
      await write(stream);
      await write('\nendstream\nendobj\n');
    } else {
      await write(`${number} 0 obj\n${dictionary}\nendobj\n`);
    }
  }

  async function writeFontObjects() {
    await writeObject(OBJ_FONT, `<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H /DescendantFonts [${OBJ_CID_FONT} 0 R] /ToUnicode ${OBJ_TO_UNICODE} 0 R >>`);
    await writeObject(OBJ_CID_FONT, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont /CIDToGIDMap ${OBJ_CID_TO_GID} 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${OBJ_FONT_DESCRIPTOR} 0 R /DW ${GLYPH_WIDTH_RATIO * 1000} >>`);
    // 所有编码都指向字体里唯一的那个空字形。
    const cidToGid = zlib.deflateSync(Buffer.alloc(2 * 65536, Buffer.from([0, 1])));
    await writeObject(OBJ_CID_TO_GID, `<< /Length ${cidToGid.length} /Filter /FlateDecode >>`, cidToGid);
    await writeObject(OBJ_FONT_DESCRIPTOR, `<< /Type /FontDescriptor /FontName /GlyphLessFont /Flags 5 /FontBBox [0 0 500 1000] /ItalicAngle 0 /Ascent 1000 /Descent -1 /CapHeight 1000 /StemV 80 /FontFile2 ${OBJ_FONT_FILE} 0 R >>`);
    await writeObject(OBJ_FONT_FILE, `<< /Length ${GLYPHLESS_FONT.length} /Length1 ${GLYPHLESS_FONT.length} >>`, GLYPHLESS_FONT);
    const toUnicode = zlib.deflateSync(Buffer.from(buildToUnicodeCMap(supplementaryCodes), 'latin1'));
    await writeObject(OBJ_TO_UNICODE, `<< /Length ${toUnicode.length} /Filter /FlateDecode >>`, toUnicode);
  }

  await write(Buffer.concat([Buffer.from('%PDF-1.5\n%', 'latin1'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n', 'latin1')]));
  /**
   * 追加一页：width/height 是页面尺寸（磅），jpeg 是整页图片，imageWidth/imageHeight 是图片像素尺寸，
   * texts 是这一页的不可见文字。先写文字再画图片，文字位于图片下方。
   */
  async function addPage({ width, height, jpeg, imageWidth, imageHeight, texts }) {
    const pageObject = nextObject;
    const contentObject = nextObject + 1;
    const imageObject = nextObject + 2;
    nextObject += 3;

    const image = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg);
    await writeObject(imageObject, `<< /Type /XObject /Subtype /Image /Width ${Math.round(imageWidth)} /Height ${Math.round(imageHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>`, image);

    const content = zlib.deflateSync(Buffer.from([
      buildTextOperators(texts, encodeText),
      `q ${formatNumber(width)} 0 0 ${formatNumber(height)} 0 0 cm /Im0 Do Q`,
      '',
    ].join('\n'), 'latin1'));
    await writeObject(contentObject, `<< /Length ${content.length} /Filter /FlateDecode >>`, content);

    await writeObject(pageObject, `<< /Type /Page /Parent ${OBJ_PAGES} 0 R /MediaBox [0 0 ${formatNumber(width)} ${formatNumber(height)}] /Contents ${contentObject} 0 R /Resources << /ProcSet [/PDF /Text /ImageC] /Font << /F1 ${OBJ_FONT} 0 R >> /XObject << /Im0 ${imageObject} 0 R >> >> >>`);
    pageObjects.push(pageObject);
  }

  /** 书签树 [{ title, pageIndex, top, children }]：top 是目标位置距页面底边的高度，缺省时跳到页首。 */
  async function writeOutline(outline) {
    const entries = [];
    const collect = (nodes, parent) => {
      const siblings = [];
      for (const node of nodes || []) {
        if (!(node?.pageIndex >= 0) || node.pageIndex >= pageObjects.length) continue;
        const entry = { object: nextObject, node, parent, children: [], descendants: 0 };
        nextObject += 1;
        entries.push(entry);
        siblings.push(entry);
        entry.children = collect(node.children, entry.object);
        entry.descendants = entry.children.reduce((sum, child) => sum + 1 + child.descendants, 0);
      }
      siblings.forEach((entry, index) => {
        entry.prev = siblings[index - 1]?.object;
        entry.next = siblings[index + 1]?.object;
      });
      return siblings;
    };

    const rootObject = nextObject;
    nextObject += 1;
    const roots = collect(outline, rootObject);
    if (!roots.length) {
      nextObject -= 1;
      return 0;
    }

    for (const entry of entries) {
      const top = Number.isFinite(entry.node.top) ? formatNumber(entry.node.top) : 'null';
      const parts = [
        `/Title ${unicodeString(entry.node.title)}`,
        `/Parent ${entry.parent} 0 R`,
        `/Dest [${pageObjects[entry.node.pageIndex]} 0 R /XYZ null ${top} null]`,
      ];
      if (entry.prev) parts.push(`/Prev ${entry.prev} 0 R`);
      if (entry.next) parts.push(`/Next ${entry.next} 0 R`);
      if (entry.children.length) {
        // 负数表示默认折叠，打开文件时只展开第一级书签。
        parts.push(`/First ${entry.children[0].object} 0 R /Last ${entry.children.at(-1).object} 0 R /Count -${entry.descendants}`);
      }
      await writeObject(entry.object, `<< ${parts.join(' ')} >>`);
    }
    await writeObject(rootObject, `<< /Type /Outlines /First ${roots[0].object} 0 R /Last ${roots.at(-1).object} 0 R /Count ${roots.length} >>`);
    return rootObject;
  }

  /** 写完页面树、书签和交叉引用表，并把临时文件改名为目标文件。 */
  async function finish({ outline, title } = {}) {
    // 字体的 Unicode 映射表要等全部文字编码完才能确定，所以放在最后写。
    await writeFontObjects();
    const outlineObject = await writeOutline(outline);
    await writeObject(OBJ_PAGES, `<< /Type /Pages /Count ${pageObjects.length} /Kids [${pageObjects.map((number) => `${number} 0 R`).join(' ')}] >>`);
    await writeObject(OBJ_CATALOG, `<< /Type /Catalog /Pages ${OBJ_PAGES} 0 R${outlineObject ? ` /Outlines ${outlineObject} 0 R /PageMode /UseOutlines` : ''} >>`);
    await writeObject(OBJ_INFO, `<< /Producer (OpenBidKit Yibiao)${title ? ` /Title ${unicodeString(title)}` : ''} >>`);

    const xrefPosition = position;
    const lines = [`xref\n0 ${nextObject}\n`, '0000000000 65535 f \n'];
    for (let number = 1; number < nextObject; number += 1) {
      lines.push(offsets.has(number)
        ? `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`
        : '0000000000 65535 f \n');
    }
    await write(lines.join(''));
    await write(`trailer\n<< /Size ${nextObject} /Root ${OBJ_CATALOG} 0 R /Info ${OBJ_INFO} 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);

    await handle.close();
    await fs.promises.rename(tempPath, outputPath);
    settled = true;
    return { pageCount: pageObjects.length };
  }

  /** 放弃写入并删除临时文件；写完但改名失败时同样要删。 */
  async function abort() {
    if (settled) return;
    settled = true;
    await handle.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true });
  }

  return { addPage, finish, abort };
}

module.exports = { createDualLayerPdfWriter };
