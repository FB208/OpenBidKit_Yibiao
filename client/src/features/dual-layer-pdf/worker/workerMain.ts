import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
// 用 legacy 构建：新版构建用到的个别新语法特性，当前 Electron 内置的 Chromium 还不支持。
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type {
  DualLayerPdfHost,
  DualLayerPdfOutlineNode,
  DualLayerPdfText,
  DualLayerPdfWorkerJob,
  DualLayerPdfWorkerResult,
} from '../types';
import { multiplyMatrix, type Matrix } from './geometry';
import { findImageRegions } from './imageRegions';
import { loadOcrEngine, type OcrEngine } from './ocr/ocrEngine';
import { recognizePageImages } from './ocr/pageOcr';

declare global {
  interface Window {
    dualLayerPdfHost: DualLayerPdfHost;
    dualLayerPdfWorker: { convert: (job: DualLayerPdfWorkerJob) => Promise<DualLayerPdfWorkerResult> };
  }
}

/** 输出页面图片的分辨率：150 dpi，对应国网操作手册里的 59.06 像素/厘米。 */
const OUTPUT_SCALE = 150 / 72;
const JPEG_QUALITY = 0.85;
const RANGE_CHUNK_SIZE = 1024 * 1024;

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const host = window.dualLayerPdfHost;

/** pdfjs 需要的字符映射表、标准字体和解码器直接从 pdfjs-dist 包目录读取，不经过网络请求。 */
const PDFJS_ASSET_DIRS: Record<string, string> = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
};

class HostBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    return host.readPdfjsAsset(`${PDFJS_ASSET_DIRS[kind]}/${filename}`);
  }
}

/** 按 pdfjs 的请求分段读取本地文件，几百 MB 的单层 PDF 也不必整个读进内存。 */
class LocalFileRangeTransport extends PDFDataRangeTransport {
  constructor(private readonly filePath: string) {
    super(host.getFileSize(filePath), null);
  }

  requestDataRange(begin: number, end: number) {
    const chunk = host.readFileRange(this.filePath, begin, end);
    queueMicrotask(() => this.onDataRange(begin, chunk));
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('页面图片生成失败'));
        return;
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

/** 读取正文文字及其位置：文字矩阵从 PDF 用户空间换算到输出页面坐标（原点在左下角，单位磅）。 */
async function readPageTexts(page: PDFPageProxy): Promise<DualLayerPdfText[]> {
  const viewport = page.getViewport({ scale: 1 });
  // 视口坐标的 y 轴向下，再翻转一次回到 PDF 的 y 轴向上，同时已包含页面旋转和裁剪框偏移。
  const toOutputPage = multiplyMatrix([1, 0, 0, -1, 0, viewport.height], viewport.transform as Matrix);
  const content = await page.getTextContent();
  const texts: DualLayerPdfText[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim() || !(item.width > 0)) continue;
    texts.push({
      text: item.str,
      matrix: multiplyMatrix(toOutputPage, item.transform as Matrix),
      advance: item.width,
    });
  }
  return texts;
}

async function readOutline(pdf: PDFDocumentProxy): Promise<DualLayerPdfOutlineNode[]> {
  type OutlineItem = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number];

  const convert = async (items: OutlineItem[]): Promise<DualLayerPdfOutlineNode[]> => {
    const nodes: DualLayerPdfOutlineNode[] = [];
    for (const item of items) {
      const children = await convert(item.items || []);
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (!Array.isArray(dest)) {
        // 没有跳转位置的书签无法保留，子书签上提一级。
        nodes.push(...children);
        continue;
      }

      const pageIndex = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      const kind = dest[1]?.name;
      const rawTop = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
      let top: number | undefined;
      if (typeof rawTop === 'number') {
        const viewport = (await pdf.getPage(pageIndex + 1)).getViewport({ scale: 1 });
        top = viewport.height - viewport.convertToViewportPoint(0, rawTop)[1];
      }
      nodes.push({ title: item.title, pageIndex, top, children });
    }
    return nodes;
  };

  return convert((await pdf.getOutline()) || []);
}

// 文字识别引擎在整个工作窗口里只加载一套，一批文档共用，随窗口销毁释放。
// 已加载的运行库模块在窗口关闭前不会被回收，每份文档各加载一次会让内存逐份累积。
let ocrEngineDir = '';
let ocrEnginePromise: Promise<OcrEngine> | null = null;

function getOcrEngine(ocrDir: string) {
  if (!ocrEnginePromise || ocrEngineDir !== ocrDir) {
    ocrEngineDir = ocrDir;
    ocrEnginePromise = loadOcrEngine(ocrDir);
  }
  return ocrEnginePromise;
}

async function convert(job: DualLayerPdfWorkerJob): Promise<DualLayerPdfWorkerResult> {
  const pdf = await getDocument({
    range: new LocalFileRangeTransport(job.pdfPath),
    rangeChunkSize: RANGE_CHUNK_SIZE,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    wasmUrl: 'wasm/',
    useWorkerFetch: false,
    BinaryDataFactory: HostBinaryDataFactory,
  }).promise;

  try {
    const canvas = document.createElement('canvas');
    let imagePageCount = 0;
    let ocrFailedPageCount = 0;

    for (let index = 0; index < pdf.numPages; index += 1) {
      const page = await pdf.getPage(index + 1);
      const pageViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: OUTPUT_SCALE });
      canvas.width = Math.round(renderViewport.width);
      canvas.height = Math.round(renderViewport.height);
      await page.render({ canvas, viewport: renderViewport, background: '#ffffff' }).promise;

      const texts = await readPageTexts(page);
      const imageRegions = await findImageRegions(page, pageViewport);
      if (imageRegions.length) {
        imagePageCount += 1;
        if (job.ocrDir) {
          try {
            texts.push(...await recognizePageImages({ page, pageViewport, imageRegions, nativeTexts: texts, engine: await getOcrEngine(job.ocrDir) }));
          } catch (error) {
            // 识别失败不影响这一页的图片和正文文字，只在结果里提示。
            ocrFailedPageCount += 1;
            console.warn('[dual-layer-pdf] 图片文字识别失败', index + 1, error);
          }
        }
      }

      await host.submitPage({
        index,
        pageCount: pdf.numPages,
        width: pageViewport.width,
        height: pageViewport.height,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        jpeg: await canvasToJpeg(canvas),
        texts,
      });
      page.cleanup();
    }

    return { pageCount: pdf.numPages, outline: await readOutline(pdf), imagePageCount, ocrFailedPageCount };
  } finally {
    await pdf.destroy();
  }
}

window.dualLayerPdfWorker = { convert };
