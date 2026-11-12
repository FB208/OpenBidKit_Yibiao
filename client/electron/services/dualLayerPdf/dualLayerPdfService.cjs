const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dialog, shell } = require('electron');
const { createDualLayerPdfWriter } = require('./pdfWriter.cjs');
const { createWorkerWindow } = require('./workerWindow.cjs');

/** 文字识别依赖的 ID；包格式与旧客户端不兼容时改用新的 ID（ocr-v2），旧客户端继续用旧包。 */
const OCR_DEPENDENCY_ID = 'ocr-v1';
const SOURCE_EXTENSIONS = ['.docx', '.doc', '.wps'];
const ACTIVE_STATUSES = ['exporting', 'rendering'];

class CanceledError extends Error {}

/**
 * Word 批量转换（双层 PDF、图片）：文件逐个处理，先用本机 Office 导出单层 PDF，再交给隐藏工作窗口逐页生成图片和文字层，
 * 双层 PDF 由 pdfWriter 流式写出，图片把同一张页面图片逐页存盘。
 * 文件列表和进度只保存在内存里，离开页面不中断，重启软件后不恢复。
 */
function createDualLayerPdfService({ app, dependencyService, getRendererWindowUrl, onEvent }) {
  // outputs 是整批共用的输出类型，每份文件开始处理时读取。
  const state = { running: false, canceling: false, outputDir: '', outputs: { pdf: true, image: false }, items: [] };
  let worker = null;
  let currentJob = null;
  let officeExportModule = null;

  function getState() {
    return {
      running: state.running,
      canceling: state.canceling,
      outputDir: state.outputDir,
      outputs: { ...state.outputs },
      items: state.items.map((item) => ({ ...item, warnings: [...item.warnings] })),
    };
  }

  function emit() {
    onEvent?.(getState());
  }

  function updateItem(item, patch) {
    Object.assign(item, patch);
    emit();
  }

  /** 共享模块是 ESM，主进程侧走动态 import（与 fileService.cjs 引 convert.mjs 同一模式）。 */
  async function loadOfficeExport() {
    if (!officeExportModule) {
      officeExportModule = await import(pathToFileURL(path.join(__dirname, 'officePdfExport.mjs')).href);
    }
    return officeExportModule;
  }

  async function getEnvironment() {
    const { listPdfBackends } = await loadOfficeExport();
    return { backends: await listPdfBackends(), ocrDependencyId: OCR_DEPENDENCY_ID };
  }

  function addFiles(filePaths) {
    const queued = new Set(state.items
      .filter((item) => item.status === 'pending' || ACTIVE_STATUSES.includes(item.status))
      .map((item) => item.sourcePath.toLowerCase()));
    for (const filePath of filePaths || []) {
      const sourcePath = String(filePath || '').trim();
      if (!SOURCE_EXTENSIONS.includes(path.extname(sourcePath).toLowerCase()) || queued.has(sourcePath.toLowerCase())) continue;
      queued.add(sourcePath.toLowerCase());
      state.items.push({
        id: crypto.randomUUID(),
        sourcePath,
        fileName: path.basename(sourcePath),
        status: 'pending',
        pageCount: 0,
        pageDone: 0,
        backendLabel: '',
        outputPath: '',
        imageDir: '',
        message: '',
        warnings: [],
      });
    }
    emit();
    return getState();
  }

  async function selectFiles() {
    const result = await dialog.showOpenDialog({
      title: '选择要转换的 Word 文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Word 文档', extensions: SOURCE_EXTENSIONS.map((extension) => extension.slice(1)) }],
    });
    return result.canceled ? getState() : addFiles(result.filePaths);
  }

  async function selectOutputDir() {
    const result = await dialog.showOpenDialog({
      title: '选择保存位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) {
      state.outputDir = result.filePaths[0];
      emit();
    }
    return getState();
  }

  function resetOutputDir() {
    state.outputDir = '';
    emit();
    return getState();
  }

  function setOutputs(outputs) {
    state.outputs = { pdf: Boolean(outputs.pdf), image: Boolean(outputs.image) };
    emit();
    return getState();
  }

  function removeItem(itemId) {
    state.items = state.items.filter((item) => item.id !== itemId || ACTIVE_STATUSES.includes(item.status));
    emit();
    return getState();
  }

  /** 清空列表；正在处理的文件保留。 */
  function clear() {
    state.items = state.items.filter((item) => ACTIVE_STATUSES.includes(item.status));
    emit();
    return getState();
  }

  /** 输出与源文件同名（PDF 带 .pdf，图片文件夹不带扩展名）；已有同名文件或文件夹时加序号，不覆盖。 */
  function resolveOutputPath(item, extension) {
    const dir = state.outputDir || path.dirname(item.sourcePath);
    const name = path.parse(item.fileName).name;
    let candidate = path.join(dir, `${name}${extension}`);
    for (let index = 1; fs.existsSync(candidate); index += 1) {
      candidate = path.join(dir, `${name}(${index})${extension}`);
    }
    return candidate;
  }

  function destroyWorker() {
    worker?.destroy();
    worker = null;
  }

  function ensureWorker() {
    if (!worker || worker.isDestroyed()) {
      worker = createWorkerWindow({ getRendererWindowUrl });
    }
    return worker;
  }

  function throwIfCanceling() {
    if (state.canceling) throw new CanceledError('已取消');
  }

  async function processItem(item) {
    const workDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'yibiao-dual-layer-pdf-'));
    const outputs = { ...state.outputs };
    let writer = null;
    // 本次新建的图片文件夹；转换成功后清空，失败或取消时整个删除。
    let imageDir = '';
    try {
      updateItem(item, { status: 'exporting', pageCount: 0, pageDone: 0, backendLabel: '', outputPath: '', imageDir: '', message: '', warnings: [] });
      const { exportWordToPdf } = await loadOfficeExport();
      const exported = await exportWordToPdf(item.sourcePath, workDir);
      throwIfCanceling();

      updateItem(item, { status: 'rendering', backendLabel: exported.backend.label });
      const outputPath = outputs.pdf ? resolveOutputPath(item, '.pdf') : '';
      if (outputs.pdf) writer = await createDualLayerPdfWriter(outputPath);
      if (outputs.image) {
        imageDir = resolveOutputPath(item, '');
        await fs.promises.mkdir(imageDir, { recursive: true });
      }
      currentJob = { item, writer, imageDir };

      const ocr = outputs.pdf ? dependencyService.getInstalled(OCR_DEPENDENCY_ID) : null;
      throwIfCanceling();
      const workerWindow = ensureWorker();
      await workerWindow.ready;
      const result = await workerWindow.convert({ pdfPath: exported.pdfPath, ocrDir: ocr?.installDir || '', textLayer: outputs.pdf });
      throwIfCanceling();

      const warnings = [];
      if (writer) {
        await writer.finish({ outline: result.outline, title: path.parse(item.fileName).name });
        writer = null;
        if (!result.outline.length) {
          warnings.push(exported.bookmarks ? '文档没有使用标题样式，未生成书签' : `${exported.backend.label} 导出时没有带出标题，未生成书签`);
        }
        if (result.imagePageCount > 0 && !ocr) {
          warnings.push(`有 ${result.imagePageCount} 页含图片，未安装文字识别组件，图片中的文字无法搜索和复制`);
        }
        if (result.ocrFailedPageCount > 0) {
          warnings.push(`有 ${result.ocrFailedPageCount} 页的图片文字识别失败，这些图片中的文字无法搜索和复制`);
        }
      }
      const finishedImageDir = imageDir;
      imageDir = '';
      updateItem(item, { status: 'done', outputPath, imageDir: finishedImageDir, warnings });
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      if (imageDir) await fs.promises.rm(imageDir, { recursive: true, force: true }).catch(() => undefined);
      if (state.canceling || error instanceof CanceledError) {
        updateItem(item, { status: 'canceled', message: '' });
      } else {
        // 工作窗口异常后丢弃，下一份文件重新创建。
        destroyWorker();
        updateItem(item, { status: 'error', message: error?.message || String(error) });
      }
    } finally {
      currentJob = null;
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function runQueue() {
    try {
      for (;;) {
        const next = state.canceling ? null : state.items.find((item) => item.status === 'pending');
        if (!next) break;
        await processItem(next);
      }
    } finally {
      destroyWorker();
      state.running = false;
      state.canceling = false;
      emit();
    }
  }

  /** 开始处理列表里等待中的文件；已在运行时新加入的文件会被同一轮处理。 */
  function start() {
    if (!state.running && state.items.some((item) => item.status === 'pending')) {
      state.running = true;
      emit();
      void runQueue();
    }
    return getState();
  }

  /** 取消当前这一轮：页面生成立即中止；本机 Office 正在导出时无法打断，等它结束后停止。 */
  function cancel() {
    if (state.running) {
      state.canceling = true;
      destroyWorker();
      emit();
    }
    return getState();
  }

  function retryItem(itemId) {
    const item = state.items.find((entry) => entry.id === itemId);
    if (item && ['error', 'canceled'].includes(item.status)) {
      updateItem(item, { status: 'pending', message: '', warnings: [] });
    }
    return start();
  }

  /** 工作窗口提交的一页：写入完成后才返回，工作窗口据此逐页推进。 */
  async function handleWorkerPage(sender, payload) {
    if (!currentJob || sender !== worker?.webContents) return;
    const { item, writer, imageDir } = currentJob;
    const jpeg = Buffer.from(payload.jpeg.buffer, payload.jpeg.byteOffset, payload.jpeg.byteLength);
    if (writer) {
      await writer.addPage({
        width: payload.width,
        height: payload.height,
        jpeg,
        imageWidth: payload.imageWidth,
        imageHeight: payload.imageHeight,
        texts: payload.texts,
      });
    }
    if (imageDir) {
      // 序号至少 3 位，页数更多时按总页数补齐，保证按文件名排序就是页码顺序。
      const pageNumber = String(payload.index + 1).padStart(Math.max(3, String(payload.pageCount).length), '0');
      await fs.promises.writeFile(path.join(imageDir, `${path.parse(item.fileName).name}_${pageNumber}.jpg`), jpeg);
    }
    updateItem(item, { pageCount: payload.pageCount, pageDone: payload.index + 1 });
  }

  function showInFolder(filePath) {
    shell.showItemInFolder(String(filePath || ''));
  }

  /** 主窗口关闭或应用退出时结束转换，避免隐藏窗口让应用无法退出。 */
  function close() {
    state.canceling = state.running;
    destroyWorker();
  }

  return {
    addFiles,
    cancel,
    clear,
    close,
    getEnvironment,
    getState,
    handleWorkerPage,
    removeItem,
    resetOutputDir,
    retryItem,
    selectFiles,
    selectOutputDir,
    setOutputs,
    showInFolder,
    start,
  };
}

module.exports = { createDualLayerPdfService, OCR_DEPENDENCY_ID };
