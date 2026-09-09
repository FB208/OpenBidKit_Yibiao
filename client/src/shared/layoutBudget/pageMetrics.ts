/**
 * 版面度量器：把导出格式配置换算成"一页能装多少内容"的确定性数字。
 *
 * 正文生成阶段唯一需要的排版知识就是这些数字：一行多少字、一页多少行、
 * 一张图占多高。AI 仍然只收到块结构和字数，厘米和页码不出现在提示词里。
 *
 * 与 C# 侧 RestrictedHtmlWordInserter/RestrictedHtmlDocumentRenderer 的几何保持一致：
 * 图片按内容宽定宽、按纵横比推高，改一处就要改两处。
 */
import { resolveChromeLayout } from '../../../electron/shared/chrome/index.mjs';
import type { ExportFormatConfig, PageSetupConfig } from '../types/exportFormat';
import { SIZE_TO_PT } from '../types/exportFormat';

const PT_PER_CM = 72 / 2.54;

export const ptToCm = (pt: number) => pt / PT_PER_CM;
export const cmToPt = (cm: number) => cm * PT_PER_CM;

export const sizeToPt = (name: string) => SIZE_TO_PT[name] ?? 12;

/**
 * Word 的"单倍行距"行高不等于字号，它取自字体的 ascent+descent+lineGap。
 * 中文常用字体实测在字号的 1.28~1.32 之间，这里取 1.30 作为标定基准；
 * 测试页会把预测分页和排版引擎的实际分页并排显示，用于校准这个系数。
 */
export const SINGLE_LINE_FACTOR = 1.3;

/** 图片几何：与 C# RestrictedHtmlWordInserter.FigureSizes 逐项对应。 */
export const FIGURE_GEOMETRY = {
  square: { widthRatio: 0.65, aspectWidth: 1, aspectHeight: 1 },
  wide: { widthRatio: 0.8, aspectWidth: 3, aspectHeight: 2 },
  tall: { widthRatio: 0.5, aspectWidth: 3, aspectHeight: 4 },
  panorama: { widthRatio: 0.9, aspectWidth: 16, aspectHeight: 9 },
} as const;

export type FigureSize = keyof typeof FIGURE_GEOMETRY;
export type FigureGeneration = 'aiImage' | 'mermaid' | 'htmlImage';

/**
 * 画框适配方式，对应 C# 侧的 data-yb-fit。
 * contain 只把画框当上界，图按真实比例缩进去，一个像素都不切；
 * cover 裁成画框比例。流程图和信息图必须 contain，实景照片才适合 cover。
 */
export type FigureFit = 'contain' | 'cover';

/** 每种生成方式默认的适配方式：只有实景照片经得起裁。 */
export const DEFAULT_FIGURE_FIT: Record<FigureGeneration, FigureFit> = {
  mermaid: 'contain',
  htmlImage: 'contain',
  aiImage: 'cover',
};

/**
 * 单张图允许占的最大页高比例。
 * 卡太紧会把竖版和方形画框全部排除，模型就只剩横版可选、版面变得单调；
 * 放到 0.55 让四种画框都进候选，排不开的情况交给装箱和 advice 去兜。
 */
export const MAX_FIGURE_PAGE_RATIO = 0.55;

/** 表格预设：与 C# RestrictedHtmlDocumentRenderer 和受限 HTML 校验保持一致。 */
export type TablePreset =
  | 'plain' | 'headerRow' | 'headerColumn' | 'headerRowAndColumn'
  | 'imageText' | 'threeImages' | 'fourImages';

/**
 * 表格单元格的宽度占比和内边距，逐项对应 C# ResolveTableCellPlacement。
 * 图组和图文混排的图宽都从这里推，改一处就要改两处。
 */
export const CELL_PLACEMENT = {
  imageTextImage: { widthRatio: 0.44, paddingPt: 0 },
  imageTextBody: { widthRatio: 0.56, paddingPt: 12 },
  threeImages: { widthRatio: 1 / 3, paddingPt: 12 },
  fourImages: { widthRatio: 0.5, paddingPt: 12 },
} as const;

export const FIGURE_SIZES = Object.keys(FIGURE_GEOMETRY) as FigureSize[];

export interface PageMetrics {
  /** 正文可用宽度（cm），已扣掉左右页边距。 */
  contentWidthCm: number;
  /** 正文可用高度（cm），已扣掉上下页边距与页眉页脚装饰让出的空间。 */
  contentHeightCm: number;
  bodySizePt: number;
  /** 一个汉字的宽度（cm）；中文全角，字宽等于字号。 */
  charWidthCm: number;
  /** 一行正文占的高度（cm），含行距。 */
  lineHeightCm: number;
  /** 正文段落的段前段后（cm）。 */
  paragraphSpaceBeforeCm: number;
  paragraphSpaceAfterCm: number;
  firstLineIndentChars: number;
  /** 每行容纳的汉字数。 */
  charsPerLine: number;
  /** 一页容纳的正文行数。 */
  linesPerPage: number;
  /** 一页纯正文时容纳的字数，仅用于展示量级。 */
  charsPerPage: number;
  /** 六级标题各自占的高度（cm），含段前段后。索引 0 = 一级标题。 */
  headingHeightCm: number[];
  /** 四种图片尺寸的画框高度（cm），不含图例。 */
  figureImageHeightCm: Record<FigureSize, number>;
  /** 四种图片尺寸的整块高度（cm），含图例和段间距。 */
  figureBlockHeightCm: Record<FigureSize, number>;
  /** 图片整块占一页的比例，用于判断某个尺寸在当前模板下是否过大。 */
  figurePageRatio: Record<FigureSize, number>;
  /** 一级标题是否强制另起一页；开启时误差不跨章累积。 */
  pageBreakBeforeLevel1: boolean;
  /** 正文分栏数；双栏时每栏宽度已经切好，上面所有宽度都是单栏的。 */
  columnCount: number;
}

/**
 * 一个"标准行" = 240 twips = 12pt。
 * Word 的 beforeLines/afterLines 按标准行（网格线）算，不是按段落自己的行高，
 * 预览侧的 patches/@docx-editor.dev+core+2.15.0.patch 用的也是这个口径。
 * 拿正文实际行高来换算，行单位的段间距会被系统性放大——小四 1.2 倍行距下多算 56%。
 */
const STANDARD_LINE_PT = 12;

/** 段前段后配置换算成 cm；单位可以是磅，也可以是标准行。 */
function spacingToCm(value: number, unit: string) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return ptToCm(unit === 'lines' ? value * STANDARD_LINE_PT : value);
}

/** 正文行距倍数。at-least / exact 走固定值，其余按倍数。 */
function resolveLineSpacingCm(config: ExportFormatConfig, sizePt: number) {
  const body = config.body_text;
  const single = ptToCm(sizePt) * SINGLE_LINE_FACTOR;
  const value = Number(body.line_spacing_value) || 1;
  switch (body.line_spacing_mode) {
    case 'single':
      return single;
    case 'one-and-half':
      return single * 1.5;
    case 'double':
      return single * 2;
    case 'exact':
      return ptToCm(value);
    case 'at-least':
      return Math.max(single, ptToCm(value));
    case 'multiple':
    default:
      return single * value;
  }
}

/** 分栏间距，与 C# CreateSectionProperties 写死的 720 twips 一致。 */
const COLUMN_SPACING_CM = 720 / 567;

/**
 * 页面可用宽高。
 * chrome 几何已经把装饰带让出的边距算进去了；分栏要再把内容宽按栏数切开，
 * 与 C# ResolvePageContentWidth 的算法保持一致——漏掉这一步，双栏下每一个
 * 宽度相关的数字都会大一倍。
 */
function resolveContentBox(page: PageSetupConfig) {
  const layout = resolveChromeLayout(page as unknown as Record<string, unknown>) as {
    widthCm: number;
    heightCm: number;
    marginTopCm: number;
    marginBottomCm: number;
    marginLeftCm: number;
    marginRightCm: number;
  };
  const rawWidthCm = layout.widthCm - layout.marginLeftCm - layout.marginRightCm;
  // 双栏只在横向时生效，和 C# 的 `landscape && two_column` 判断对齐。
  const columnCount = page.two_column && page.orientation === 'landscape' ? 2 : 1;
  const widthCm = columnCount > 1
    ? Math.max(1, rawWidthCm - COLUMN_SPACING_CM * (columnCount - 1)) / columnCount
    : rawWidthCm;
  return {
    widthCm,
    heightCm: layout.heightCm - layout.marginTopCm - layout.marginBottomCm,
    columnCount,
  };
}

export function resolvePageMetrics(config: ExportFormatConfig): PageMetrics {
  const box = resolveContentBox(config.page);
  const bodySizePt = sizeToPt(config.body_text.size);
  const charWidthCm = ptToCm(bodySizePt);
  const lineHeightCm = resolveLineSpacingCm(config, bodySizePt);

  const paragraphSpaceBeforeCm = spacingToCm(
    config.body_text.spacing_before,
    config.body_text.spacing_before_unit,
  );
  const paragraphSpaceAfterCm = spacingToCm(
    config.body_text.spacing_after,
    config.body_text.spacing_after_unit,
  );

  const charsPerLine = Math.max(1, Math.floor(box.widthCm / charWidthCm));
  const linesPerPage = Math.max(1, Math.floor(box.heightCm / lineHeightCm));

  const headingHeightCm = config.headings.map((heading) => {
    const size = sizeToPt(heading.size);
    const spacing = Number(heading.line_spacing) || 1;
    return ptToCm(size) * SINGLE_LINE_FACTOR * spacing
      + ptToCm(heading.spacing_before_pt || 0)
      + ptToCm(heading.spacing_after_pt || 0);
  });

  // 图片宽度同时受尺寸预设和"图片最大宽度"设置约束，与 C# 侧的 Math.Min 一致。
  const maxWidthRatio = Math.max(0.1, Math.min(1, (config.image.max_width_percent || 100) / 100));
  const captionHeightCm = ptToCm(sizeToPt(config.image.caption_size)) * SINGLE_LINE_FACTOR;

  const figureImageHeightCm = {} as Record<FigureSize, number>;
  const figureBlockHeightCm = {} as Record<FigureSize, number>;
  const figurePageRatio = {} as Record<FigureSize, number>;
  for (const size of FIGURE_SIZES) {
    const spec = FIGURE_GEOMETRY[size];
    const widthCm = box.widthCm * Math.min(spec.widthRatio, maxWidthRatio);
    const imageHeightCm = widthCm * (spec.aspectHeight / spec.aspectWidth);
    const blockHeightCm = imageHeightCm + captionHeightCm + paragraphSpaceBeforeCm + paragraphSpaceAfterCm;
    figureImageHeightCm[size] = imageHeightCm;
    figureBlockHeightCm[size] = blockHeightCm;
    figurePageRatio[size] = blockHeightCm / box.heightCm;
  }

  return {
    contentWidthCm: box.widthCm,
    contentHeightCm: box.heightCm,
    bodySizePt,
    charWidthCm,
    lineHeightCm,
    paragraphSpaceBeforeCm,
    paragraphSpaceAfterCm,
    firstLineIndentChars: config.body_text.first_line_indent_chars || 0,
    charsPerLine,
    linesPerPage,
    charsPerPage: charsPerLine * linesPerPage,
    headingHeightCm,
    figureImageHeightCm,
    figureBlockHeightCm,
    figurePageRatio,
    pageBreakBeforeLevel1: config.heading_level1_page_break_before === true,
    columnCount: box.columnCount,
  };
}

/** 一段指定字数的正文占多高（cm），含段前段后。首行缩进吃掉首行的若干字。 */
export function paragraphHeightCm(metrics: PageMetrics, chars: number) {
  const effective = Math.max(1, chars + metrics.firstLineIndentChars);
  const lines = Math.max(1, Math.ceil(effective / metrics.charsPerLine));
  return lines * metrics.lineHeightCm + metrics.paragraphSpaceBeforeCm + metrics.paragraphSpaceAfterCm;
}

/** 反过来：给定一段可用的高度，能写多少字。 */
export function charsForHeightCm(metrics: PageMetrics, heightCm: number) {
  const usable = heightCm - metrics.paragraphSpaceBeforeCm - metrics.paragraphSpaceAfterCm;
  const lines = Math.floor(usable / metrics.lineHeightCm);
  if (lines <= 0) return 0;
  return Math.max(0, lines * metrics.charsPerLine - metrics.firstLineIndentChars);
}

/**
 * 列表块高度：每项按独立段落算，列表缩进吃掉的字数一并折进去。
 * 段前段后也逐项计入——Word 里每个 li 都是独立段落，各自套一份正文间距
 * （见 client/开发说明.md「普通正文与列表逐段应用」），整块只加一次会低估高度。
 */
export function listHeightCm(metrics: PageMetrics, items: number, charsPerItem: number) {
  const indent = metrics.firstLineIndentChars + 2;
  const perItemLines = Math.max(1, Math.ceil((charsPerItem + indent) / metrics.charsPerLine));
  const perItemCm = perItemLines * metrics.lineHeightCm
    + metrics.paragraphSpaceBeforeCm
    + metrics.paragraphSpaceAfterCm;
  return items * perItemCm;
}

/** 表格单元格里一张图的画框宽度（cm）：单元格宽扣掉内边距。 */
export function cellImageWidthCm(
  metrics: PageMetrics,
  placement: { widthRatio: number; paddingPt: number },
) {
  return Math.max(0.5, metrics.contentWidthCm * placement.widthRatio - ptToCm(placement.paddingPt));
}

/** 一个画框在给定宽度下的高度。 */
export function figureHeightAtWidthCm(widthCm: number, size: FigureSize) {
  const spec = FIGURE_GEOMETRY[size];
  return widthCm * (spec.aspectHeight / spec.aspectWidth);
}

/** 图例加图片前后间距，图块比画框本身要高出这一截。 */
export function figureChromeHeightCm(metrics: PageMetrics, captionSizePt: number) {
  return ptToCm(captionSizePt) * SINGLE_LINE_FACTOR
    + metrics.paragraphSpaceBeforeCm
    + metrics.paragraphSpaceAfterCm;
}

/**
 * 图组（三列或四宫格）的整块高度。
 * 三图一行，四图两行；每格图宽由单元格占比决定，高按画框比例推。
 */
export function figureGroupHeightCm(
  metrics: PageMetrics,
  count: 3 | 4,
  size: FigureSize,
  captionSizePt: number,
) {
  const placement = count === 3 ? CELL_PLACEMENT.threeImages : CELL_PLACEMENT.fourImages;
  const widthCm = cellImageWidthCm(metrics, placement);
  const rows = count === 3 ? 1 : 2;
  const perRow = figureHeightAtWidthCm(widthCm, size) + ptToCm(captionSizePt) * SINGLE_LINE_FACTOR;
  // 组标题占一行，表格上下各留一点间距。
  return rows * perRow
    + ptToCm(captionSizePt) * SINGLE_LINE_FACTOR
    + metrics.paragraphSpaceBeforeCm
    + metrics.paragraphSpaceAfterCm;
}

/**
 * 图文混排块的整块高度：行高取图和文字里较高的那个。
 * 文字挤在 0.56 宽的单元格里，每行装的字比正文少得多，这一点必须算进去。
 */
export function imageTextHeightCm(
  metrics: PageMetrics,
  size: FigureSize,
  textChars: number,
  captionSizePt: number,
) {
  const imageWidthCm = cellImageWidthCm(metrics, CELL_PLACEMENT.imageTextImage);
  const imageHeightCm = figureHeightAtWidthCm(imageWidthCm, size)
    + ptToCm(captionSizePt) * SINGLE_LINE_FACTOR;

  const textWidthCm = cellImageWidthCm(metrics, CELL_PLACEMENT.imageTextBody);
  const charsPerLine = Math.max(1, Math.floor(textWidthCm / metrics.charWidthCm));
  const textHeightCm = Math.ceil(textChars / charsPerLine) * metrics.lineHeightCm;

  return Math.max(imageHeightCm, textHeightCm)
    + ptToCm(captionSizePt) * SINGLE_LINE_FACTOR
    + metrics.paragraphSpaceBeforeCm
    + metrics.paragraphSpaceAfterCm;
}

/** 图文混排右侧单元格每行能写多少字，用来把字数配额换算成高度。 */
export function imageTextCharsPerLine(metrics: PageMetrics) {
  const widthCm = cellImageWidthCm(metrics, CELL_PLACEMENT.imageTextBody);
  return Math.max(1, Math.floor(widthCm / metrics.charWidthCm));
}

/**
 * 数据表格的整块高度。
 * 单元格行高按正文行高加内边距估，多行文字的单元格会更高，这里按每格一行估，
 * 属于偏乐观的估计——表格撑高只会让后面的正文往下走，不会凭空造出空洞。
 */
export function tableHeightCm(metrics: PageMetrics, rows: number, hasHeader: boolean, captionSizePt: number) {
  const rowHeightCm = metrics.lineHeightCm * 1.35;
  return (rows + (hasHeader ? 1 : 0)) * rowHeightCm
    + ptToCm(captionSizePt) * SINGLE_LINE_FACTOR
    + metrics.paragraphSpaceBeforeCm
    + metrics.paragraphSpaceAfterCm;
}
