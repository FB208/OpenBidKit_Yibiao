// 批量转双层 PDF 的整链路检查：本机 Office 导出 → 隐藏工作窗口逐页处理 → 写出双层 PDF，再读回核对。
// 需要 Electron 主进程和已构建的 dist（先运行 npm run build），本机要装有 Word、WPS 或 LibreOffice。
// 运行：node_modules\.bin\electron.cmd scripts/check-dual-layer-pdf-convert.cjs <Word 文档路径> [文字识别组件目录]
// 文档会被复制到中文临时目录再转换，结果文件路径打印在最后，供人工在阅读器里查看。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { createDualLayerPdfService } = require('../electron/services/dualLayerPdf/dualLayerPdfService.cjs');
const { registerDualLayerPdfIpc } = require('../electron/ipc/dualLayerPdfIpc.cjs');

const [sourceArg, ocrDir] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

async function readBack(pdfPath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const items = (await page.getTextContent()).items.filter((item) => item.str.trim());
    pages.push({ page: index, size: page.view.slice(2).map(Math.round).join('x'), textItems: items.length, sample: items.slice(0, 6).map((item) => item.str).join(' | ').slice(0, 120) });
  }
  const outline = await pdf.getOutline();
  const flatten = (nodes, depth = 0) => (nodes || []).flatMap((node) => [`${'  '.repeat(depth)}${node.title}`, ...flatten(node.items, depth + 1)]);
  await pdf.destroy();
  return { pageCount: pages.length, pages, outline: flatten(outline) };
}

// 工作窗口销毁后没有任何窗口，默认会直接退出，读回结果前先保持运行。
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    if (!sourceArg) throw new Error('请传入 Word 文档路径');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), '双层PDF整链路-'));
    const sourcePath = path.join(workDir, path.basename(sourceArg));
    fs.copyFileSync(sourceArg, sourcePath);

    const indexUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();
    const startedAt = Date.now();
    const finished = new Promise((resolve) => {
      const service = createDualLayerPdfService({
        app,
        dependencyService: { getInstalled: () => (ocrDir ? { installDir: path.resolve(ocrDir) } : null) },
        getRendererWindowUrl: (name) => `${indexUrl}?window=${name}`,
        onEvent: (state) => {
          const item = state.items[0];
          if (item) process.stdout.write(`\r${item.status} ${item.pageDone}/${item.pageCount}   `);
          if (!state.running && item && !['pending', 'exporting', 'rendering'].includes(item.status)) resolve(item);
        },
      });
      registerDualLayerPdfIpc({ dualLayerPdfService: service });
      service.addFiles([sourcePath]);
      service.start();
    });

    const item = await finished;
    console.log(`\n耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
    console.log(JSON.stringify({ status: item.status, message: item.message, backend: item.backendLabel, warnings: item.warnings, outputPath: item.outputPath }, null, 2));
    if (item.status !== 'done') throw new Error(item.message || `转换未完成：${item.status}`);

    const result = await readBack(item.outputPath);
    console.log(`输出 ${fs.statSync(item.outputPath).size} 字节，${result.pageCount} 页`);
    for (const page of result.pages) console.log(`  第 ${page.page} 页 ${page.size} 文字 ${page.textItems} 段：${page.sample}`);
    console.log(`书签 ${result.outline.length} 个：\n${result.outline.slice(0, 20).join('\n')}`);
    if (result.pageCount !== item.pageCount) throw new Error('读回的页数与转换时不一致');
    exitCode = 0;
  } catch (error) {
    console.error('\n检查失败：', error);
  } finally {
    app.exit(exitCode);
  }
});
