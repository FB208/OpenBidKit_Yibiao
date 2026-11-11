import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DualLayerPdfText } from '../../types';
import { intersectRect, type Rect } from '../geometry';
import { createCanvas } from './imageTensor';
import type { OcrEngine, Point, Quad } from './ocrEngine';

export interface PageOcrRequest {
  page: PDFPageProxy;
  /** scale=1 的视口，图片区域和输出页面坐标都以它为准。 */
  pageViewport: PageViewport;
  imageRegions: Rect[];
  /** 这一页已有的正文文字，用来跳过与正文重叠的文字框。 */
  nativeTexts: DualLayerPdfText[];
  engine: OcrEngine;
}

/** 识别用的渲染分辨率：200 dpi，比输出图片高，小字更容易认出。 */
const OCR_SCALE = 200 / 72;
/** 文字框被正文文字覆盖超过这个比例时，认为它就是正文（如压在图片上的文本框），不再识别。 */
const NATIVE_TEXT_COVERAGE = 0.5;

function boundsOf(points: Point[]): Rect {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 正文文字在输出页面坐标（原点在左下角）中的外接矩形。 */
function nativeTextBounds(text: DualLayerPdfText): Rect {
  const [a, b, c, d, e, f] = text.matrix;
  const scale = Math.hypot(a, b) || 1;
  const along: Point = [(a / scale) * text.advance, (b / scale) * text.advance];
  return boundsOf([[e, f], [e + along[0], f + along[1]], [e + c, f + d], [e + along[0] + c, f + along[1] + d]]);
}

/**
 * 识别页面上各图片区域里的文字，返回可直接写进文字层的不可见文字。
 * 每个区域单独按较高分辨率渲染后识别，识别结果从区域像素坐标换算回输出页面坐标。
 */
export async function recognizePageImages({ page, pageViewport, imageRegions, nativeTexts, engine }: PageOcrRequest): Promise<DualLayerPdfText[]> {
  const pageHeight = pageViewport.height;
  const nativeRects = nativeTexts.map(nativeTextBounds);
  const texts: DualLayerPdfText[] = [];

  for (const region of imageRegions) {
    const canvas = createCanvas(region.width * OCR_SCALE, region.height * OCR_SCALE);
    await page.render({
      canvas,
      viewport: page.getViewport({ scale: OCR_SCALE, offsetX: -region.x * OCR_SCALE, offsetY: -region.y * OCR_SCALE }),
      background: '#ffffff',
    }).promise;

    // 区域像素坐标 → 输出页面坐标（磅，原点在左下角）
    const toPage = ([x, y]: Point): Point => [region.x + x / OCR_SCALE, pageHeight - (region.y + y / OCR_SCALE)];

    const lines = await engine.recognize(canvas, (quad: Quad) => {
      const box = boundsOf(quad.map(toPage));
      const area = box.width * box.height;
      if (!(area > 0)) return true;
      const covered = nativeRects.reduce((sum, rect) => {
        const overlap = intersectRect(box, rect);
        return overlap ? sum + overlap.width * overlap.height : sum;
      }, 0);
      return covered / area >= NATIVE_TEXT_COVERAGE;
    });

    for (const line of lines) {
      const [topLeft, , bottomRight, bottomLeft] = line.quad.map(toPage);
      const advance = Math.hypot(bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1]);
      const fontSize = Math.hypot(topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]);
      if (!(advance > 0) || !(fontSize > 0)) continue;
      // 文字矩阵：x 轴沿文字行底边、y 轴指向行顶，原点在行的左下角，字高等于行高。
      texts.push({
        text: line.text,
        matrix: [
          ((bottomRight[0] - bottomLeft[0]) / advance) * fontSize,
          ((bottomRight[1] - bottomLeft[1]) / advance) * fontSize,
          topLeft[0] - bottomLeft[0],
          topLeft[1] - bottomLeft[1],
          bottomLeft[0],
          bottomLeft[1],
        ],
        advance,
      });
    }
  }

  return texts;
}
