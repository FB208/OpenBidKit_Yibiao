const { nativeImage } = require('electron');
const AdmZip = require('adm-zip');

// 暗标彩色图片判定：按像素内容而不是颜色模式判断，截图等真彩色 PNG 内容是黑白的不算彩色。
// 逐像素看 RGB 通道差，彩色像素占比超过阈值才判为彩色。流程图的彩色边框和文字只有一两个像素宽，
// 缩得太小会被白底冲淡，所以只把长边超过 2048 像素的大图缩小后再统计。
// nativeImage 只能解码 PNG 和 JPEG，BMP、GIF 等格式不做判断，也不转灰度。
const SAMPLE_EDGE = 2048;
const CHANNEL_SPREAD = 40;
const COLOR_RATIO = 0.01;
const DECODABLE_IMAGE = /\.(png|jpe?g)$/i;

/** 与助手的 part 名一致：统一正斜杠，去掉开头的斜杠。 */
function normalizePartName(entryName) {
  return String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function sampleColorRatio(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(width, height));
  const sample = scale < 1
    ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
    : image;
  // 位图为预乘 alpha 的 BGRA；半透明以下的像素不参与判断。
  const bitmap = sample.toBitmap();
  let opaque = 0;
  let colorful = 0;
  for (let index = 0; index < bitmap.length; index += 4) {
    if (bitmap[index + 3] < 128) continue;
    opaque += 1;
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > CHANNEL_SPREAD) colorful += 1;
  }
  return opaque ? colorful / opaque : 0;
}

/**
 * 读取 docx 内的位图逐张抽样，返回 [{ part, color, color_ratio }]，part 与助手里的图片 part 名一致。
 * 每张图之后让出事件循环，图片很多时不阻塞 Main，也能及时响应取消。
 * 待检副本按 UUID 命名且导入后不再改动，同一副本的结论缓存一份，检查后再修复时不重复解码。
 */
let cachedFacts = null;

async function collectImageColorFacts(docxPath, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new Error('检查已取消');
  if (cachedFacts?.path === docxPath) return cachedFacts.facts;
  const entries = new AdmZip(docxPath).getEntries()
    .filter((entry) => !entry.isDirectory && DECODABLE_IMAGE.test(entry.entryName) && !entry.entryName.startsWith('docProps/'));
  const facts = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (signal?.aborted) throw new Error('检查已取消');
    const entry = entries[index];
    const ratio = sampleColorRatio(entry.getData());
    if (ratio !== null) {
      facts.push({ part: normalizePartName(entry.entryName), color: ratio >= COLOR_RATIO, color_ratio: Number(ratio.toFixed(4)) });
    }
    onProgress?.(index + 1, entries.length);
    await new Promise((resolve) => setImmediate(resolve));
  }
  cachedFacts = { path: docxPath, facts };
  return facts;
}

/** 转灰度：按亮度把每个像素的 RGB 设为同一值，透明度不变；JPEG 仍存为 JPEG，其余存为 PNG。 */
function toGrayscale(buffer, isJpeg) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  for (let index = 0; index < bitmap.length; index += 4) {
    const gray = Math.round(0.114 * bitmap[index] + 0.587 * bitmap[index + 1] + 0.299 * bitmap[index + 2]);
    bitmap[index] = gray;
    bitmap[index + 1] = gray;
    bitmap[index + 2] = gray;
  }
  const result = nativeImage.createFromBitmap(bitmap, { width, height });
  return isJpeg ? result.toJPEG(90) : result.toPNG();
}

/**
 * 把 docx 里指定的位图转为灰度后另存一份，原文件不动；返回实际转换的 part。
 * 彩色图片修复要解码像素，助手不做：修复任务先用它生成灰度副本，再交给助手做其余修复。
 */
async function writeGrayscaleCopy(docxPath, targetPath, parts, { signal } = {}) {
  const wanted = new Set(parts);
  const zip = new AdmZip(docxPath);
  const converted = [];
  for (const entry of zip.getEntries()) {
    if (signal?.aborted) throw new Error('修复已取消');
    const part = normalizePartName(entry.entryName);
    if (entry.isDirectory || !wanted.has(part) || !DECODABLE_IMAGE.test(part)) continue;
    const gray = toGrayscale(entry.getData(), /\.jpe?g$/i.test(part));
    if (!gray) continue;
    zip.updateFile(entry, gray);
    converted.push(part);
    await new Promise((resolve) => setImmediate(resolve));
  }
  zip.writeZip(targetPath);
  return converted;
}

module.exports = {
  collectImageColorFacts,
  writeGrayscaleCopy,
  __test__: {
    sampleColorRatio,
    normalizePartName,
  },
};
