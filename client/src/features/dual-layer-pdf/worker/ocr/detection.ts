import type { Point, Quad } from './ocrEngine';
import { imageToTensor, resizeToCanvas } from './imageTensor';

export interface DetectionConfig {
  model: string;
  mean: [number, number, number];
  std: [number, number, number];
  /** 概率图二值化阈值。 */
  thresh: number;
  /** 文字框平均概率低于该值时丢弃。 */
  boxThresh: number;
  /** 文字框外扩比例：检测模型输出的是收缩后的文字核，需要按面积和周长外扩回完整文字行。 */
  unclipRatio: number;
  /** 检测输入的最长边上限，超过时等比缩小。 */
  maxSideLength: number;
}

const SIZE_STEP = 32;
/** 外扩前文字核的最短边下限（概率图像素），更小的是噪点。 */
const MIN_KERNEL_SIDE = 3;

/** 把图片缩到模型接受的尺寸（长宽都是 32 的倍数），返回输入张量和实际尺寸。 */
export function prepareDetectionInput(image: HTMLCanvasElement, config: DetectionConfig) {
  const ratio = Math.min(1, config.maxSideLength / Math.max(image.width, image.height));
  const width = Math.max(SIZE_STEP, Math.round((image.width * ratio) / SIZE_STEP) * SIZE_STEP);
  const height = Math.max(SIZE_STEP, Math.round((image.height * ratio) / SIZE_STEP) * SIZE_STEP);
  return { data: imageToTensor(resizeToCanvas(image, width, height), config.mean, config.std), width, height };
}

function cross(origin: Point, a: Point, b: Point) {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

/** 凸包（单调链算法），返回逆时针排列的顶点。 */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const build = (source: Point[]) => {
    const chain: Point[] = [];
    for (const point of source) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build(sorted.reverse())];
}

interface OrientedRect {
  /** 矩形两条边的单位方向。 */
  u: Point;
  n: Point;
  minU: number;
  maxU: number;
  minN: number;
  maxN: number;
}

/** 最小面积外接矩形：最优矩形必有一条边与凸包的某条边重合，逐边尝试即可。 */
function minAreaRect(hull: Point[]): OrientedRect | null {
  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let index = 0; index < hull.length; index += 1) {
    const from = hull[index];
    const to = hull[(index + 1) % hull.length];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (!length) continue;
    const u: Point = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    const n: Point = [-u[1], u[0]];
    let minU = Infinity;
    let maxU = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const [x, y] of hull) {
      const pu = x * u[0] + y * u[1];
      const pn = x * n[0] + y * n[1];
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const area = (maxU - minU) * (maxN - minN);
    if (area < bestArea) {
      bestArea = area;
      best = { u, n, minU, maxU, minN, maxN };
    }
  }
  return best;
}

/** 四个角按左上、右上、右下、左下排列：先按 x 分出左右两组，每组内上面的在前。 */
function orderQuad(points: Point[]): Quad {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const [topLeft, bottomLeft] = sorted.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const [topRight, bottomRight] = sorted.slice(2).sort((a, b) => a[1] - b[1]);
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/**
 * 从检测模型输出的概率图中取出文字行的框（DB 后处理）：
 * 二值化 → 逐个连通区域求最小外接矩形 → 按平均概率过滤 → 外扩 → 换算回原图坐标。
 */
export function extractTextBoxes(
  probability: Float32Array,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  config: DetectionConfig,
): Quad[] {
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;
  const boxes: Quad[] = [];
  const isText = (index: number) => probability[index] > config.thresh;

  for (let start = 0; start < probability.length; start += 1) {
    if (visited[start] || !isText(start)) continue;

    // 泛洪填充一个连通区域（八邻域），只收集边界像素的四个角用来求外接矩形。
    const corners: Point[] = [];
    let probabilitySum = 0;
    let pixelCount = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      probabilitySum += probability[index];
      pixelCount += 1;

      let boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!isText(neighbor)) {
            if (!dx || !dy) boundary = true;
          } else if (!visited[neighbor]) {
            visited[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
      if (boundary) corners.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }

    if (probabilitySum / pixelCount < config.boxThresh) continue;
    const rect = minAreaRect(convexHull(corners));
    if (!rect) continue;
    const rectWidth = rect.maxU - rect.minU;
    const rectHeight = rect.maxN - rect.minN;
    if (Math.min(rectWidth, rectHeight) < MIN_KERNEL_SIDE) continue;

    const expand = (rectWidth * rectHeight * config.unclipRatio) / (2 * (rectWidth + rectHeight));
    const toSource = (pu: number, pn: number): Point => [
      Math.min(sourceWidth, Math.max(0, (pu * rect.u[0] + pn * rect.n[0]) * scaleX)),
      Math.min(sourceHeight, Math.max(0, (pu * rect.u[1] + pn * rect.n[1]) * scaleY)),
    ];
    boxes.push(orderQuad([
      toSource(rect.minU - expand, rect.minN - expand),
      toSource(rect.maxU + expand, rect.minN - expand),
      toSource(rect.maxU + expand, rect.maxN + expand),
      toSource(rect.minU - expand, rect.maxN + expand),
    ]));
  }

  // 按从上到下、从左到右排列，文字层的顺序接近阅读顺序。
  return boxes.sort((a, b) => a[0][1] - b[0][1] || a[0][0] - b[0][0]);
}
