/** 单个文件的处理阶段：等待 → 导出单层 PDF → 生成页面 → 完成 / 失败 / 已取消。 */
export type DualLayerPdfItemStatus = 'pending' | 'exporting' | 'rendering' | 'done' | 'error' | 'canceled';

export interface DualLayerPdfItem {
  id: string;
  sourcePath: string;
  fileName: string;
  status: DualLayerPdfItemStatus;
  pageCount: number;
  pageDone: number;
  /** 实际使用的转换程序，如 Microsoft Word。 */
  backendLabel: string;
  /** 双层 PDF 的路径；没有输出双层 PDF 时为空。 */
  outputPath: string;
  /** 逐页图片所在文件夹；没有输出图片时为空。 */
  imageDir: string;
  /** 失败原因。 */
  message: string;
  /** 转换成功但需要用户知道的情况，如未生成书签。 */
  warnings: string[];
}

/** 输出类型，整批文件共用，至少选一种。 */
export interface DualLayerPdfOutputs {
  pdf: boolean;
  image: boolean;
}

export interface DualLayerPdfState {
  running: boolean;
  canceling: boolean;
  /** 输出文件夹；空字符串表示与源文件同目录。 */
  outputDir: string;
  outputs: DualLayerPdfOutputs;
  items: DualLayerPdfItem[];
}

export interface DualLayerPdfEnvironment {
  /** 本机可用的转换程序，按尝试顺序排列；为空时无法转换。 */
  backends: Array<{ type: 'word' | 'wps' | 'libreoffice'; label: string }>;
  /** 文字识别组件的依赖 ID。 */
  ocrDependencyId: string;
}

/** 隐藏工作窗口处理一份单层 PDF 的任务。 */
export interface DualLayerPdfWorkerJob {
  pdfPath: string;
  /** 文字识别组件的安装目录；空字符串表示未安装，不做图片文字识别。 */
  ocrDir: string;
  /** 是否需要文字层和书签；只输出图片时为 false，只渲染页面图片。 */
  textLayer: boolean;
}

/** 一段不可见文字：matrix 把 1 个单位的字高映射到页面坐标（磅，原点在左下角），advance 是沿书写方向的宽度。 */
export interface DualLayerPdfText {
  text: string;
  matrix: [number, number, number, number, number, number];
  advance: number;
}

export interface DualLayerPdfWorkerPage {
  index: number;
  pageCount: number;
  /** 页面尺寸，单位磅。 */
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  jpeg: Uint8Array;
  texts: DualLayerPdfText[];
}

export interface DualLayerPdfOutlineNode {
  title: string;
  pageIndex: number;
  /** 目标位置距页面底边的高度；没有时跳到页首。 */
  top?: number;
  children: DualLayerPdfOutlineNode[];
}

export interface DualLayerPdfWorkerResult {
  pageCount: number;
  outline: DualLayerPdfOutlineNode[];
  /** 含图片的页数。 */
  imagePageCount: number;
  /** 图片文字识别失败的页数。 */
  ocrFailedPageCount: number;
}

/** 隐藏工作窗口的预加载脚本暴露的桥。 */
export interface DualLayerPdfHost {
  readPdfjsAsset: (relativePath: string) => Uint8Array;
  getFileSize: (filePath: string) => number;
  readFileRange: (filePath: string, begin: number, end: number) => Uint8Array;
  readFile: (filePath: string) => Uint8Array | null;
  submitPage: (page: DualLayerPdfWorkerPage) => Promise<void>;
}
