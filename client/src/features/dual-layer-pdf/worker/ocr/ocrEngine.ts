import { extractTextBoxes, prepareDetectionInput, type DetectionConfig } from './detection';
import { cropQuad, imageToTensor, resizeToCanvas } from './imageTensor';

export type Point = [number, number];
/** 文字行的四个角（图片像素），顺序为左上、右上、右下、左下（按阅读方向）。 */
export type Quad = [Point, Point, Point, Point];

export interface OcrLine {
  text: string;
  score: number;
  quad: Quad;
}

export interface OcrEngine {
  /** 识别一张图片里的文字行；shouldSkip 返回 true 的文字框不做识别（如已有正文文字覆盖的位置）。 */
  recognize: (image: HTMLCanvasElement, shouldSkip?: (quad: Quad) => boolean) => Promise<OcrLine[]>;
}

/** 文字识别依赖包里的 manifest.json，由 scripts/build-ocr-dependency.cjs 生成。 */
interface OcrManifest {
  format: number;
  runtime: { script: string; wasm: string };
  detection: DetectionConfig;
  orientation: { model: string; width: number; height: number; mean: [number, number, number]; std: [number, number, number] };
  recognition: { model: string; height: number; dictionary: string };
}

/** 这里用到的 onnxruntime-web 接口；运行库来自依赖包，不随应用打包，所以只声明用到的部分。 */
interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
}

interface OrtModule {
  env: { logLevel: string; wasm: { numThreads: number; wasmBinary?: ArrayBufferLike; proxy?: boolean } };
  InferenceSession: { create: (model: Uint8Array, options?: { executionProviders: string[]; logSeverityLevel?: number }) => Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
}

const SUPPORTED_MANIFEST_FORMAT = 1;
/** 文字行高度明显大于宽度时视为旋转了 90 度的文字，先转正再识别（PaddleOCR 的标准做法）。 */
const VERTICAL_LINE_RATIO = 1.5;
/** 方向分类判为上下颠倒且把握足够大时才翻转。 */
const UPSIDE_DOWN_CONFIDENCE = 0.9;
const MIN_RECOGNITION_SCORE = 0.5;
const MAX_RECOGNITION_WIDTH = 3200;
const RECOGNITION_MEAN: [number, number, number] = [0.5, 0.5, 0.5];

function readRequired(ocrDir: string, relativePath: string) {
  const bytes = window.dualLayerPdfHost.readFile(`${ocrDir}/${relativePath}`);
  if (!bytes) throw new Error(`文字识别组件缺少文件：${relativePath}`);
  return bytes;
}

/**
 * 加载文字识别组件：运行库脚本、wasm 和模型都从依赖目录读成字节后在本窗口里加载，不发起网络请求。
 * WASM 在非跨源隔离的页面里只能单线程运行。
 */
export async function loadOcrEngine(ocrDir: string): Promise<OcrEngine> {
  const decoder = new TextDecoder();
  const manifest = JSON.parse(decoder.decode(readRequired(ocrDir, 'manifest.json'))) as OcrManifest;
  if (manifest.format !== SUPPORTED_MANIFEST_FORMAT) {
    throw new Error('文字识别组件与当前软件版本不匹配，请更新软件或重新下载组件');
  }

  const scriptUrl = URL.createObjectURL(new Blob([new Uint8Array(readRequired(ocrDir, manifest.runtime.script))], { type: 'text/javascript' }));
  let ort: OrtModule;
  try {
    ort = await import(/* @vite-ignore */ scriptUrl) as OrtModule;
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = readRequired(ocrDir, manifest.runtime.wasm).buffer;

  const createSession = (model: string) => ort.InferenceSession.create(readRequired(ocrDir, model), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  const detector = await createSession(manifest.detection.model);
  const orientation = await createSession(manifest.orientation.model);
  const recognizer = await createSession(manifest.recognition.model);
  const dictionary = decoder.decode(readRequired(ocrDir, manifest.recognition.dictionary)).split('\n');

  const run = async (session: OrtSession, data: Float32Array, height: number, width: number) => {
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, height, width]) });
    return outputs[session.outputNames[0]];
  };

  async function detect(image: HTMLCanvasElement) {
    const input = prepareDetectionInput(image, manifest.detection);
    const output = await run(detector, input.data, input.height, input.width);
    return extractTextBoxes(output.data, input.width, input.height, image.width, image.height, manifest.detection);
  }

  async function isUpsideDown(lineImage: HTMLCanvasElement) {
    const { width, height, mean, std } = manifest.orientation;
    const output = await run(orientation, imageToTensor(resizeToCanvas(lineImage, width, height), mean, std), height, width);
    return output.data[1] > output.data[0] && output.data[1] >= UPSIDE_DOWN_CONFIDENCE;
  }

  /** 识别一行文字并做 CTC 解码：逐列取概率最大的字符，去掉空白符和相邻重复。 */
  async function readLine(lineImage: HTMLCanvasElement) {
    const height = manifest.recognition.height;
    const width = Math.min(MAX_RECOGNITION_WIDTH, Math.max(height, Math.round((lineImage.width / lineImage.height) * height)));
    const output = await run(recognizer, imageToTensor(resizeToCanvas(lineImage, width, height), RECOGNITION_MEAN, RECOGNITION_MEAN), height, width);
    const [, steps, classes] = output.dims;
    // 输出的第 0 类是空白符，其后依次是字典里的字符；模型比字典多出的最后一类是空格。
    let text = '';
    let scoreSum = 0;
    let count = 0;
    let previous = 0;
    for (let step = 0; step < steps; step += 1) {
      let best = 0;
      let bestScore = -Infinity;
      for (let index = 0, offset = step * classes; index < classes; index += 1) {
        if (output.data[offset + index] > bestScore) {
          bestScore = output.data[offset + index];
          best = index;
        }
      }
      if (best !== 0 && best !== previous) {
        text += best <= dictionary.length ? dictionary[best - 1] : ' ';
        scoreSum += bestScore;
        count += 1;
      }
      previous = best;
    }
    return { text: text.trim(), score: count ? scoreSum / count : 0 };
  }

  async function recognize(image: HTMLCanvasElement, shouldSkip?: (quad: Quad) => boolean) {
    const lines: OcrLine[] = [];
    for (const box of await detect(image)) {
      if (shouldSkip?.(box)) continue;
      let quad = box;
      let lineImage = cropQuad(image, quad);
      if (lineImage.height >= lineImage.width * VERTICAL_LINE_RATIO) {
        // 逆时针转 90 度：原来的右上角成为左上角，阅读方向变为原图的自上而下。
        quad = [quad[1], quad[2], quad[3], quad[0]];
        lineImage = cropQuad(image, quad);
      }
      if (await isUpsideDown(lineImage)) {
        quad = [quad[2], quad[3], quad[0], quad[1]];
        lineImage = cropQuad(image, quad);
      }
      const { text, score } = await readLine(lineImage);
      if (text && score >= MIN_RECOGNITION_SCORE) lines.push({ text, score, quad });
    }
    return lines;
  }

  return { recognize };
}
