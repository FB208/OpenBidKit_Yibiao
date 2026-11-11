// 双层 PDF 写入器自检：在中文临时目录里生成文件，再用 pdfjs 读回，核对页数、页面尺寸、文字层和书签。
// 运行：node --test scripts/check-dual-layer-pdf.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDualLayerPdfWriter } = require('../electron/services/dualLayerPdf/pdfWriter.cjs');

// 1×1 的占位 JPEG：自检只读文字层和书签，不解码图片。
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////'
  + '////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

const A4 = { width: 595.28, height: 841.89 };

async function readPdf(filePath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return getDocument({ data: new Uint8Array(fs.readFileSync(filePath)), disableFontFace: true, verbosity: 0 }).promise;
}

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '双层PDF自检-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('文字层、页面尺寸和书签能读回', async (t) => {
  const dir = createTempDir(t);
  const outputPath = path.join(dir, '投标文件（双层）.pdf');
  const writer = await createDualLayerPdfWriter(outputPath);

  await writer.addPage({
    ...A4,
    jpeg: PLACEHOLDER_JPEG,
    imageWidth: 1240,
    imageHeight: 1754,
    texts: [
      { text: '投标文件 Bid 2026', matrix: [12, 0, 0, 12, 72, 700], advance: 150 },
      { text: '𠮷野家（生僻字）', matrix: [16, 0, 0, 16, 72, 650], advance: 128 },
      // 逆时针旋转 90 度的文字
      { text: '竖排印章文字', matrix: [0, 10, -10, 0, 300, 400], advance: 60 },
      // 无效项应被跳过
      { text: '', matrix: [12, 0, 0, 12, 0, 0], advance: 10 },
      { text: '零宽', matrix: [12, 0, 0, 12, 0, 0], advance: 0 },
    ],
  });
  await writer.addPage({
    width: A4.height,
    height: A4.width,
    jpeg: PLACEHOLDER_JPEG,
    imageWidth: 1754,
    imageHeight: 1240,
    texts: [{ text: '第二页 横向', matrix: [14, 0, 0, 14, 100, 500], advance: 84 }],
  });

  const result = await writer.finish({
    title: '投标文件',
    outline: [
      { title: '第一章 概述', pageIndex: 0, top: 712, children: [{ title: '1.1 项目背景', pageIndex: 1, top: 514 }] },
      { title: '第二章 技术方案', pageIndex: 1 },
      { title: '指向不存在的页', pageIndex: 9 },
    ],
  });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(fs.readdirSync(dir), ['投标文件（双层）.pdf'], '不应留下临时文件');

  const pdf = await readPdf(outputPath);
  assert.equal(pdf.numPages, 2);

  const firstPage = await pdf.getPage(1);
  assert.deepEqual(firstPage.view.map((value) => Math.round(value * 100) / 100), [0, 0, A4.width, A4.height]);
  // pdfjs 会在空格处把一段文字拆成几项，这里按基线位置合并回行再比较。
  const firstItems = (await firstPage.getTextContent()).items.filter((item) => item.str.trim());
  const firstLine = firstItems.filter((item) => Math.abs(item.transform[5] - 700) < 0.01);
  assert.deepEqual(firstLine.map((item) => item.str), ['投标文件', 'Bid', '2026']);
  const second = firstItems.find((item) => Math.abs(item.transform[5] - 650) < 0.01);
  const rotated = firstItems.find((item) => Math.abs(item.transform[4] - 300) < 0.01);
  assert.equal(firstItems.length, 5, '空文字和零宽文字应被跳过');
  assert.equal(second.str, '𠮷野家（生僻字）', '超出基本平面的字符应能读回');
  assert.equal(rotated.str, '竖排印章文字');

  // 文字的位置、字号和宽度与写入时一致，说明选中区域能和图片上的字对齐。
  const first = firstLine[0];
  const last = firstLine.at(-1);
  assert.ok(Math.abs(first.transform[4] - 72) < 0.01);
  assert.ok(Math.abs(last.transform[4] + last.width - (72 + 150)) < 0.5, `整行宽度应为 150，实际 ${last.transform[4] + last.width - 72}`);
  assert.ok(Math.abs(first.height - 12) < 0.01);
  assert.ok(Math.abs(second.width - 128) < 0.5, `宽度应为 128，实际 ${second.width}`);
  assert.ok(Math.abs(rotated.transform[1]) > 0 && Math.abs(rotated.transform[0]) < 0.01, '旋转文字应保持方向');
  assert.ok(Math.abs(rotated.width - 60) < 0.5, `宽度应为 60，实际 ${rotated.width}`);

  const secondPage = await pdf.getPage(2);
  assert.deepEqual(secondPage.view.map((value) => Math.round(value * 100) / 100), [0, 0, A4.height, A4.width]);
  assert.deepEqual((await secondPage.getTextContent()).items.map((item) => item.str).filter((str) => str.trim()), ['第二页', '横向']);

  const outline = await pdf.getOutline();
  assert.deepEqual(outline.map((item) => item.title), ['第一章 概述', '第二章 技术方案']);
  assert.deepEqual(outline[0].items.map((item) => item.title), ['1.1 项目背景']);
  assert.equal(await pdf.getPageIndex(outline[0].dest[0]), 0);
  assert.equal(outline[0].dest[3], 712);
  assert.equal(await pdf.getPageIndex(outline[0].items[0].dest[0]), 1);
  assert.equal(await pdf.getPageIndex(outline[1].dest[0]), 1);

  const metadata = await pdf.getMetadata();
  assert.equal(metadata.info.Title, '投标文件');
  await pdf.destroy();
});

test('没有书签时不写大纲', async (t) => {
  const dir = createTempDir(t);
  const outputPath = path.join(dir, '无书签.pdf');
  const writer = await createDualLayerPdfWriter(outputPath);
  await writer.addPage({ ...A4, jpeg: PLACEHOLDER_JPEG, imageWidth: 1240, imageHeight: 1754, texts: [] });
  await writer.finish({ outline: [] });

  const pdf = await readPdf(outputPath);
  assert.equal(pdf.numPages, 1);
  assert.equal(await pdf.getOutline(), null);
  await pdf.destroy();
});

test('放弃写入后不留文件', async (t) => {
  const dir = createTempDir(t);
  const writer = await createDualLayerPdfWriter(path.join(dir, '已取消.pdf'));
  await writer.addPage({ ...A4, jpeg: PLACEHOLDER_JPEG, imageWidth: 1240, imageHeight: 1754, texts: [] });
  await writer.abort();
  assert.deepEqual(fs.readdirSync(dir), []);
});
