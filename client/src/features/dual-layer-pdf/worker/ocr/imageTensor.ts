import type { Quad } from './ocrEngine';

export function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function getContext(canvas: HTMLCanvasElement) {
  return canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
}

export function resizeToCanvas(image: HTMLCanvasElement, width: number, height: number) {
  const canvas = createCanvas(width, height);
  const context = getContext(canvas);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 把图片转成模型输入张量（通道在前、单精度）。PaddleOCR 的模型按 OpenCV 的 BGR 通道顺序训练，
 * 均值和方差也按这个顺序逐通道使用，这里保持一致。
 */
export function imageToTensor(canvas: HTMLCanvasElement, mean: [number, number, number], std: [number, number, number]) {
  const { data } = getContext(canvas).getImageData(0, 0, canvas.width, canvas.height);
  const size = canvas.width * canvas.height;
  const tensor = new Float32Array(size * 3);
  for (let index = 0; index < size; index += 1) {
    const offset = index * 4;
    tensor[index] = (data[offset + 2] / 255 - mean[0]) / std[0];
    tensor[size + index] = (data[offset + 1] / 255 - mean[1]) / std[1];
    tensor[size * 2 + index] = (data[offset] / 255 - mean[2]) / std[2];
  }
  return tensor;
}

/** 把四边形（左上、右上、右下、左下）裁成水平的矩形图片，倾斜或旋转的文字行由此摆正。 */
export function cropQuad(image: HTMLCanvasElement, quad: Quad) {
  const [topLeft, topRight, , bottomLeft] = quad;
  const width = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
  const height = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
  const canvas = createCanvas(width, height);
  if (!(width > 0) || !(height > 0)) return canvas;

  // 裁剪图上的点 (u, v) 对应原图的 topLeft + u·ex + v·ey，画图时用它的逆变换。
  const ex = [(topRight[0] - topLeft[0]) / width, (topRight[1] - topLeft[1]) / width];
  const ey = [(bottomLeft[0] - topLeft[0]) / height, (bottomLeft[1] - topLeft[1]) / height];
  const determinant = ex[0] * ey[1] - ex[1] * ey[0];
  if (!determinant) return canvas;
  const context = getContext(canvas);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(
    ey[1] / determinant,
    -ex[1] / determinant,
    -ey[0] / determinant,
    ex[0] / determinant,
    (ey[0] * topLeft[1] - ey[1] * topLeft[0]) / determinant,
    (ex[1] * topLeft[0] - ex[0] * topLeft[1]) / determinant,
  );
  context.drawImage(image, 0, 0);
  return canvas;
}
