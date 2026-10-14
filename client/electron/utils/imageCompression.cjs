const { nativeImage } = require('electron');

// 按 A4 正文区域约 16×24cm、300 DPI 限制像素，打印仍清晰；只缩小不放大。
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 2880;
const JPEG_QUALITY = 90;

// 透明像素铺白：解码后的位图为预乘 alpha 的 BGRA，直接转 JPEG 会变成黑底。
function flattenOnWhite(image) {
  const bitmap = image.toBitmap();
  let transparent = false;
  for (let index = 0; index < bitmap.length; index += 4) {
    const alpha = bitmap[index + 3];
    if (alpha === 255) continue;
    transparent = true;
    bitmap[index] += 255 - alpha;
    bitmap[index + 1] += 255 - alpha;
    bitmap[index + 2] += 255 - alpha;
    bitmap[index + 3] = 255;
  }
  return transparent ? nativeImage.createFromBitmap(bitmap, image.getSize()) : image;
}

// 生成图落盘前压缩：超出上限按原比例缩小，统一转 JPEG；GIF 或无法解码的图片原样返回。
// extension 不带点，返回值同样不带点。
function compressGeneratedImage(buffer, extension) {
  if (extension === 'gif') return { buffer, extension };
  const source = nativeImage.createFromBuffer(buffer);
  if (source.isEmpty()) return { buffer, extension };

  const { width, height } = source.getSize();
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  const resized = scale < 1
    ? source.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' })
    : source;
  const image = flattenOnWhite(resized);
  return { buffer: image.toJPEG(JPEG_QUALITY), extension: 'jpg', ...image.getSize() };
}

module.exports = {
  compressGeneratedImage,
};
