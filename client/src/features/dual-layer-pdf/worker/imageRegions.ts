import { OPS, type PDFPageProxy, type PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { IDENTITY_MATRIX, intersectRect, mergeOverlappingRects, multiplyMatrix, unitSquareBounds, type Matrix, type Rect } from './geometry';

/**
 * 找出页面上各张图片的位置（视口坐标，原点在左上角，单位为 scale=1 时的磅）。
 * 做法是遍历页面的绘制指令并跟踪当前变换矩阵：图片总是画在单位正方形里，再由变换矩阵放到页面上。
 * 相互重叠的图片合并成一个区域，避免同一处文字被识别两次。
 */
export async function findImageRegions(page: PDFPageProxy, viewport: PageViewport): Promise<Rect[]> {
  const operatorList = await page.getOperatorList();
  const pageRect: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const viewportMatrix = viewport.transform as Matrix;
  const stack: Matrix[] = [];
  const regions: Rect[] = [];
  let matrix: Matrix = IDENTITY_MATRIX;

  const addImage = (imageMatrix: Matrix) => {
    const region = intersectRect(unitSquareBounds(multiplyMatrix(viewportMatrix, imageMatrix)), pageRect);
    if (region) regions.push(region);
  };

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index];
    switch (fn) {
      case OPS.save:
        stack.push(matrix);
        break;
      case OPS.restore:
        matrix = stack.pop() ?? matrix;
        break;
      case OPS.transform:
        matrix = multiplyMatrix(matrix, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(matrix);
        if (Array.isArray(args?.[0])) matrix = multiplyMatrix(matrix, args[0] as Matrix);
        break;
      case OPS.paintFormXObjectEnd:
        matrix = stack.pop() ?? matrix;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        addImage(matrix);
        break;
      case OPS.paintImageXObjectRepeat: {
        // 同一张图片重复画在多个位置：args 为 [图片, 横向缩放, 纵向缩放, 位置数组(x, y 交替)]
        const [, scaleX, scaleY, positions] = args as [unknown, number, number, ArrayLike<number>];
        for (let i = 0; i + 1 < positions.length; i += 2) {
          addImage(multiplyMatrix(matrix, [scaleX, 0, 0, scaleY, positions[i], positions[i + 1]]));
        }
        break;
      }
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup:
        // 多张小图合并绘制，各自带变换矩阵
        for (const entry of (args?.[args.length - 1] ?? []) as Array<{ transform?: Matrix }>) {
          if (entry.transform) addImage(multiplyMatrix(matrix, entry.transform));
        }
        break;
      default:
        break;
    }
  });

  return mergeOverlappingRects(regions);
}
