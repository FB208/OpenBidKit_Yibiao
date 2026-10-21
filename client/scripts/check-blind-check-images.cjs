// 暗标彩色图片判定验证：nativeImage 只在 Electron 主进程可用，需用 Electron 直接运行（client 目录，不设 ELECTRON_RUN_AS_NODE）：
//   node_modules\.bin\electron.cmd scripts/check-blind-check-images.cjs
// 在内存里生成灰度、彩色、少量彩点、透明底等图片，写入中文临时目录的 docx，断言抽样结论，并经任务调用真实助手验证接线。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const AdmZip = require('adm-zip');
const { collectImageColorFacts, writeGrayscaleCopy } = require('../electron/services/blindCheckImageColor.cjs');
const { normalizeProfile } = require('../electron/services/blindCheckPresets.cjs');
const { runBlindCheckFixTask } = require('../electron/services/blindCheckFixTask.cjs');
const { runBlindCheckTask } = require('../electron/services/blindCheckTask.cjs');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');

/** pixel(x, y) 返回 [r, g, b, a]；位图按 BGRA 写入。 */
function createImage(width, height, pixel) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha = 255] = pixel(x, y);
      const index = (y * width + x) * 4;
      // nativeImage 的位图是预乘 alpha。
      bitmap[index] = Math.round(blue * alpha / 255);
      bitmap[index + 1] = Math.round(green * alpha / 255);
      bitmap[index + 2] = Math.round(red * alpha / 255);
      bitmap[index + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

const gray = (x) => {
  const value = Math.round((x * 255) / 399);
  return [value, value, value];
};

const samples = {
  'word/media/gray-gradient.png': { expected: false, data: createImage(400, 300, gray).toPNG() },
  'word/media/gray-photo.jpeg': { expected: false, data: createImage(400, 300, (x, y) => gray((x + y) % 400)).toJPEG(80) },
  'word/media/color-chart.png': { expected: true, data: createImage(300, 200, (x) => (x < 150 ? [220, 30, 30] : [30, 60, 200])).toPNG() },
  'word/media/color-photo.jpg': { expected: true, data: createImage(320, 240, (x, y) => [x % 256, y % 256, 128]).toJPEG(85) },
  // 白底文档截图里只有一个 3×3 的彩色像素点：占比远低于阈值，不算彩色。
  'word/media/tiny-dot.png': { expected: false, data: createImage(600, 400, (x, y) => (x >= 300 && x < 303 && y >= 200 && y < 203 ? [255, 0, 0] : (y % 20 < 2 ? [40, 40, 40] : [255, 255, 255]))).toPNG() },
  // 透明底上的灰色文字：透明像素不参与判断。
  'word/media/transparent.png': { expected: false, data: createImage(200, 100, (x, y) => (y % 10 < 3 ? [60, 60, 60, 255] : [255, 0, 0, 0])).toPNG() },
  // Mermaid 默认主题的流程图：淡紫色填充加 2 像素紫色边框，缩到很小时边框会被白底冲淡，按原图判断是彩色。
  'word/media/flowchart.png': {
    expected: true,
    data: createImage(1600, 1200, (x, y) => (x % 200 < 2 || y % 200 < 2 ? [147, 112, 219] : (x % 200 > 40 && y % 200 > 60 && y % 200 < 140 ? [236, 236, 255] : [255, 255, 255]))).toPNG(),
  },
};

async function run() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), '暗标图片颜色验证-'));
  try {
    // BMP：nativeImage 只能解码 PNG 和 JPEG，BMP 不做判断；手工写一个 24 位 2×2 的彩色位图验证会被跳过。
    const bmp = Buffer.alloc(54 + 16);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(2, 18);
    bmp.writeInt32LE(2, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(16, 34);
    Buffer.from([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0]).copy(bmp, 54);

    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>', 'utf8'));
    for (const [name, sample] of Object.entries(samples)) zip.addFile(name, sample.data);
    zip.addFile('word/media/color.bmp', bmp);
    // 文件属性里的缩略图不是正文图片，不参与判断。
    zip.addFile('docProps/thumbnail.jpeg', samples['word/media/color-photo.jpg'].data);
    const docxPath = path.join(workDir, '彩色图片.docx');
    zip.writeZip(docxPath);

    const progress = [];
    const facts = await collectImageColorFacts(docxPath, { onProgress: (done, total) => progress.push(`${done}/${total}`) });
    const byPart = Object.fromEntries(facts.map((fact) => [fact.part, fact]));
    assert.equal(byPart['docProps/thumbnail.jpeg'], undefined, '缩略图不参与判断');
    assert.equal(byPart['word/media/color.bmp'], undefined, 'BMP 不做判断');
    for (const [name, sample] of Object.entries(samples)) {
      assert.ok(byPart[name], `缺少 ${name} 的结论：${JSON.stringify(facts)}`);
      assert.equal(byPart[name].color, sample.expected, `${name} 判定错误：${JSON.stringify(byPart[name])}`);
    }
    assert.equal(progress.at(-1), `${Object.keys(samples).length}/${Object.keys(samples).length}`);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectImageColorFacts(docxPath, { signal: controller.signal }), /检查已取消/);

    for (const fact of facts) console.log(`[彩色判定] ${fact.part} color=${fact.color} ratio=${fact.color_ratio}`);

    // 转灰度：只转指定的图，格式和尺寸不变，转完按像素复判不再是彩色；其他条目原样保留。
    const colorParts = ['word/media/color-chart.png', 'word/media/color-photo.jpg', 'word/media/flowchart.png'];
    const grayPath = path.join(workDir, '灰度副本.docx');
    const converted = await writeGrayscaleCopy(docxPath, grayPath, [...colorParts, 'word/media/color.bmp']);
    assert.deepEqual([...converted].sort(), [...colorParts].sort(), 'BMP 不能解码，不转换');
    const grayFacts = Object.fromEntries((await collectImageColorFacts(grayPath)).map((fact) => [fact.part, fact]));
    const grayZip = new AdmZip(grayPath);
    const originalZip = new AdmZip(docxPath);
    for (const part of colorParts) {
      assert.equal(grayFacts[part].color, false, `${part} 转灰度后仍判为彩色：${JSON.stringify(grayFacts[part])}`);
      const before = nativeImage.createFromBuffer(originalZip.getEntry(part).getData()).getSize();
      const data = grayZip.getEntry(part).getData();
      assert.deepEqual(nativeImage.createFromBuffer(data).getSize(), before, `${part} 尺寸不变`);
      assert.equal(data[0], part.endsWith('.jpg') ? 0xFF : 0x89, `${part} 保持原格式`);
    }
    for (const part of ['word/media/gray-gradient.png', 'word/media/color.bmp', 'docProps/thumbnail.jpeg']) {
      assert.ok(grayZip.getEntry(part).getData().equals(originalZip.getEntry(part).getData()), `${part} 原样保留`);
    }

    await checkTaskWiring(workDir);
    await checkFixWiring(workDir);
    console.log('check-blind-check-images: 全部通过');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** 任务接线：开启彩色检查后，Main 抽样结论随请求传给真实助手，结果里只报彩色的那张图。 */
async function checkTaskWiring(userData) {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const imagePara = (rid) => `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdColor" Type="${REL}/image" Target="media/image1.png"/><Relationship Id="rIdGray" Type="${REL}/image" Target="media/image2.png"/></Relationships>`, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:r><w:t>彩色图片样本。</w:t></w:r></w:p>${imagePara('rIdColor')}${imagePara('rIdGray')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body></w:document>`, 'utf8'));
  zip.addFile('word/media/image1.png', samples['word/media/color-chart.png'].data);
  zip.addFile('word/media/image2.png', samples['word/media/gray-gradient.png'].data);
  const sourceDir = path.join(userData, 'workspace', 'blind-check', 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, '彩色.docx');
  zip.writeZip(sourcePath);

  const helper = createOpenXmlHelperService({ app: { isPackaged: false, getPath: () => userData, getAppPath: () => path.join(__dirname, '..') } });
  const checkpoints = [];
  const logs = [];
  try {
    await runBlindCheckTask({
      workspaceStore: {
        prepareCheckInput: () => ({
          source: 'blind-check/source/彩色.docx',
          sourcePath,
          fileName: '彩色.docx',
          presetName: '通用',
          profile: normalizeProfile({ image: { check_color: true } }),
          sensitiveWords: [],
          signature: 'sig',
        }),
        setAiReviewEnabled: () => undefined,
      },
      openXmlHelperService: helper,
      updateTask: (patch) => logs.push(patch.logs?.at(-1)),
      checkpointTask: (task, { result }) => checkpoints.push({ task, result }),
      taskControl: { signal: new AbortController().signal },
    });
  } finally {
    await helper.closeBlindCheck();
  }
  const { task, result } = checkpoints.at(-1);
  assert.equal(task.status, 'success', task.error);
  const color = result.groups.filter((group) => group.ruleId === 'image.color');
  assert.equal(color.length, 1, JSON.stringify(result.groups.map((group) => `${group.ruleId}:${group.message}`)));
  assert.equal(color[0].count, 1);
  assert.match(color[0].samples[0].detail, /image1\.png（PNG，300×200），彩色像素约占 100%/);
  assert.equal(result.stats.images, 2);
  assert.ok(logs.includes('正在检查图片颜色（2/2）'), JSON.stringify(logs));
}

/** 修复接线：勾选彩色图片时 Main 先转灰度再交给真实助手，复查不再报彩色，修复明细记入转换张数，灰度中间副本删除。 */
async function checkFixWiring(userData) {
  const workspace = path.join(userData, 'workspace');
  const sourcePath = path.join(workspace, 'blind-check', 'source', '彩色.docx');
  const output = 'blind-check/fixed/彩色.docx';
  const helper = createOpenXmlHelperService({ app: { isPackaged: false, getPath: () => userData, getAppPath: () => path.join(__dirname, '..') } });
  const checkpoints = [];
  try {
    await runBlindCheckFixTask({
      workspaceStore: {
        prepareFixInput: () => ({
          source: 'blind-check/source/彩色.docx',
          sourcePath,
          fileName: '彩色.docx',
          presetName: '通用',
          profile: normalizeProfile({ image: { check_color: true } }),
          sensitiveWords: [],
          signature: 'sig',
          fixRules: ['image.color'],
          output,
          outputPath: path.join(workspace, output),
        }),
        setFixAiEnabled: () => undefined,
        loadBlindCheck: () => ({ result: { status: 'success', inputSignature: 'sig', summary: { high: 0, medium: 1, low: 0, total: 1 }, groups: [{ ruleId: 'image.color', count: 1 }] } }),
        removeStaleFixedFiles: () => {},
      },
      openXmlHelperService: helper,
      updateTask: () => {},
      checkpointTask: (task, { fixResult }) => checkpoints.push({ task, fixResult }),
      taskControl: { signal: new AbortController().signal },
    });
  } finally {
    await helper.closeBlindCheck();
  }
  const { task, fixResult } = checkpoints.at(-1);
  assert.equal(task.status, 'success', task.error);
  assert.equal(fixResult.fixes['image.color'], 1);
  assert.ok(!fixResult.groups.some((group) => group.ruleId === 'image.color'), JSON.stringify(fixResult.groups));
  assert.equal(fixResult.sourceBytes, fs.statSync(sourcePath).size, '文件大小按原文件计');
  assert.ok(!fs.existsSync(path.join(workspace, 'blind-check', 'fixed', '彩色.gray.docx')), '灰度中间副本已删除');
  const facts = await collectImageColorFacts(path.join(workspace, output));
  assert.ok(facts.length === 2 && facts.every((fact) => !fact.color), JSON.stringify(facts));
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
