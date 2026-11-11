/** PDF 的仿射变换矩阵 [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f。 */
export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/** 先应用 inner 再应用 outer 的组合变换。 */
export function multiplyMatrix(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

export function applyMatrix(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/** 单位正方形经 matrix 变换后的外接矩形，即一张图片在目标坐标系中的范围。 */
export function unitSquareBounds(matrix: Matrix): Rect {
  const corners = [applyMatrix(matrix, 0, 0), applyMatrix(matrix, 1, 0), applyMatrix(matrix, 0, 1), applyMatrix(matrix, 1, 1)];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** 把相互重叠的矩形合并成一个，直到剩下的矩形两两不相交。 */
export function mergeOverlappingRects(rects: Rect[]): Rect[] {
  const merged = [...rects];
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (intersectRect(merged[i], merged[j])) {
          merged[i] = unionRect(merged[i], merged[j]);
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return merged;
}
