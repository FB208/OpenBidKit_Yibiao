/**
 * 小节骨架规划器：在正文生成之前，按版面度量把一个小节排成确定的块序列。
 *
 * 规划的产物是"块结构 + 每段字数区间 + 图片位置和尺寸"，不含任何内容。
 * 图片在这里就定好了位置和尺寸，正文生成时 AI 顺手把提示词和图例写出来，
 * 因此不再需要独立的图片编排阶段。
 *
 * 核心手法不是把内容切成等分槽位，而是前向装箱：逐块累加高度，
 * 发现图片会被挤到下一页时，改写它前面那段的字数配额，把当前页填满。
 * 调整的是"还没生成的配额"，不是已生成的正文，所以这不是事后修复。
 */
import type { FigureGeneration, FigureSize, PageMetrics, TablePreset } from './pageMetrics';
import {
  CELL_PLACEMENT,
  FIGURE_GEOMETRY,
  FIGURE_SIZES,
  MAX_FIGURE_PAGE_RATIO,
  cellImageWidthCm,
  charsForHeightCm,
  figureHeightAtWidthCm,
  figureGroupHeightCm,
  imageTextCharsPerLine,
  imageTextHeightCm,
  listHeightCm,
  paragraphHeightCm,
  tableHeightCm,
} from './pageMetrics';

/** 一段正文的字数下限；低于这个数读起来就不像一段话了。 */
export const MIN_PARAGRAPH_CHARS = 90;
/** 一段正文的字数上限；再长 AI 的字数控制就开始不准。 */
export const MAX_PARAGRAPH_CHARS = 420;
/** 默认每段目标字数。 */
export const DEFAULT_PARAGRAPH_CHARS = 230;
/** 下发给 AI 的字数区间半宽，按比例给，太窄 AI 达不到，太宽装箱失去意义。 */
export const PARAGRAPH_TOLERANCE_RATIO = 0.12;
/** 页尾剩余低于这个高度（按行数折算）就认为这一页填满了，不值得再调。 */
export const ACCEPTABLE_TAIL_LINES = 2;

export type SkeletonBlock =
  | { kind: 'heading'; id: string; level: number; text: string }
  | {
    kind: 'paragraph';
    id: string;
    role: 'lead' | 'body' | 'bridge' | 'close';
    targetChars: number;
    minChars: number;
    maxChars: number;
  }
  | {
    kind: 'list';
    id: string;
    ordered: boolean;
    items: number;
    charsPerItem: number;
  }
  | {
    kind: 'figure';
    id: string;
    /**
     * 版面给这张图的高度上界。装箱按它算，实际图只会更矮不会更高，
     * 所以无论模型挑了哪个画框，装箱结论都成立。
     */
    budgetHeightCm: number;
    /** 高度上界内可用的画框，模型从中挑一个最贴合内容的。 */
    allowedSizes: FigureSize[];
    /** 建议的生成方式。轮转分配，保证一节里三种方式都露面；模型可按内容改。 */
    suggestedGeneration: FigureGeneration;
  }
  | {
    kind: 'imageText';
    id: string;
    figureId: string;
    /**
     * 画框由版面定死，不交给模型。
     * 左格宽度固定是内容宽的 0.44，画框比例在这里不表达内容，只决定右栏文字
     * 能占多高；一旦交给模型选，行高就成了两个自由变量的较大者，装箱没法预测。
     */
    size: FigureSize;
    budgetHeightCm: number;
    suggestedGeneration: FigureGeneration;
    /** 右侧文字的字数配额，由图高反推：写满也撑不高这一行。 */
    targetChars: number;
    minChars: number;
    maxChars: number;
    /** 右栏最多几行，用来向模型说明这个上限的由来。 */
    maxLines: number;
  }
  | {
    kind: 'figureGroup';
    id: string;
    /** 三列并排或四宫格。 */
    count: 3 | 4;
    figureIds: string[];
    budgetHeightCm: number;
    allowedSizes: FigureSize[];
    suggestedGeneration: FigureGeneration;
  }
  | {
    kind: 'table';
    id: string;
    preset: TablePreset;
    /** 数据行数，不含表头。 */
    rows: number;
    cols: number;
    hasHeader: boolean;
  };

export interface PlacedBlock {
  block: SkeletonBlock;
  heightCm: number;
  /** 从 0 开始的物理页序号；单栏时与 column 相同。 */
  page: number;
  /** 从 0 开始的栏序号。双栏模板下一张物理页有两栏，装箱按栏走。 */
  column: number;
  /** 该块顶边距离本栏内容区顶部的距离。 */
  topCm: number;
}

export interface LayoutSimulation {
  placed: PlacedBlock[];
  /** 物理页数，可直接与排版引擎的 getPageGeometry() 对照。 */
  pageCount: number;
  /** 一张物理页有几栏，来自模板的分栏设置。 */
  columnsPerPage: number;
  /** 每栏末尾的剩余高度（cm）。栏底才是真实断点，所以按栏记。 */
  tailCm: number[];
  /** 每栏末尾剩余折合的正文行数。 */
  tailLines: number[];
  /** 超过阈值的空洞，是这套方案要消灭的目标。 */
  gaps: { page: number; column: number; heightCm: number; lines: number; ratio: number }[];
}

/** 空洞位置的中文说法：单栏只说页，双栏要说清是哪一栏，否则对不上 Word 里看到的版面。 */
export function describeGapPosition(
  gap: { page: number; column: number },
  columnsPerPage: number,
) {
  if (columnsPerPage <= 1) return `第 ${gap.page + 1} 页`;
  const inPage = gap.column - gap.page * columnsPerPage;
  const label = columnsPerPage === 2 ? ['左栏', '右栏'][inPage] : `第 ${inPage + 1} 栏`;
  return `第 ${gap.page + 1} 页${label ?? `第 ${inPage + 1} 栏`}`;
}

export interface SkeletonPlanInput {
  metrics: PageMetrics;
  /** 小节标题层级，1 起。 */
  headingLevel: number;
  headingText: string;
  /** 本节目标正文字数（不含标题和图例）。 */
  targetChars: number;
  /** 本节要配几张图。具体画什么、用什么画框、什么生成方式，都由模型按内容定。 */
  figureCount: number;
  /** 单张图允许占的最大页高比例，默认 MAX_FIGURE_PAGE_RATIO。 */
  maxFigurePageRatio?: number;
  /** 指定每个图块的版式；不给就按 FIGURE_LAYOUTS 轮转。 */
  figureLayouts?: FigureLayout[];
  /** 是否安排数据表格，默认按字数自动决定。 */
  withTable?: boolean;
  /** 是否在正文中安排一处列表。 */
  withList: boolean;
  /** 本节开始时当前页已用掉的高度；测试默认从整页开头排。 */
  startOffsetCm?: number;
}

export interface SkeletonPlan {
  blocks: SkeletonBlock[];
  simulation: LayoutSimulation;
  /** 规划过程中为消除空洞做的配额调整，用于在测试页解释算法行为。 */
  adjustments: string[];
  /** 调整后的正文总字数，与目标字数会有出入。 */
  plannedChars: number;
  /** 装箱后仍排不出好版面时给出的处置建议。空数组表示这一节排得开。 */
  advice: string[];
  /** 排完之后还有空洞就是不可行；调用方应据此减图或加字，而不是硬排。 */
  feasible: boolean;
}

/**
 * 一张图要排得不留空洞，它所在的那一页除它之外的地方都得有正文填。
 * 所以每张图的"入场费"就是一页减去图块高度所能容纳的字数。
 */
export function figureAdmissionChars(metrics: PageMetrics, figureHeightCm: number) {
  return charsForHeightCm(metrics, metrics.contentHeightCm - figureHeightCm);
}

/** 给定字数最多排得下几张图。 */
export function maxFiguresForChars(metrics: PageMetrics, chars: number, maxPageRatio = MAX_FIGURE_PAGE_RATIO) {
  const admission = figureAdmissionChars(metrics, resolveFigureBudget(metrics, maxPageRatio).heightCm);
  if (admission <= 0) return 0;
  return Math.max(0, Math.floor(chars / admission));
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 图例字号；模板里可配，这里取常见的小五，只影响几毫米的估算。 */
const CAPTION_SIZE_PT = 9;

/** 版式轮转：图块按顺序换花样，保证一节里不会清一色都是独立图。 */
const FIGURE_LAYOUTS = ['single', 'imageText', 'group3', 'group4', 'single', 'imageText'] as const;
export type FigureLayout = (typeof FIGURE_LAYOUTS)[number];
export { FIGURE_LAYOUTS };

/** 生成方式轮转：保证 mermaid、htmlImage、aiImage 三种都露面。 */
const GENERATION_ROTATION: FigureGeneration[] = ['mermaid', 'htmlImage', 'aiImage'];

/** 数据表格预设轮转，避免每次都是同一种表头形态。 */
const TABLE_PRESETS: TablePreset[] = ['headerRow', 'headerRowAndColumn', 'headerColumn'];

/**
 * 一个块占多高。
 *
 * 凡是模型有发挥余地的地方一律按上界算：段落按字数区间的上限、图按预算高度。
 * 写少了只是让后面的内容往上走，页尾的空隙会被下一段的文字自然流过去补上；
 * 写多了却会把整块不可分内容顶到下一页，留下一整片空白。
 * 两种误差的代价完全不对称，所以只能往保守的一侧靠。
 */
function blockHeightCm(metrics: PageMetrics, block: SkeletonBlock) {
  switch (block.kind) {
    case 'heading':
      return metrics.headingHeightCm[clamp(block.level, 1, 6) - 1] ?? metrics.lineHeightCm * 2;
    case 'paragraph':
      return paragraphHeightCm(metrics, block.maxChars);
    case 'list':
      return listHeightCm(metrics, block.items, block.charsPerItem);
    case 'figure':
    case 'figureGroup':
      return block.budgetHeightCm;
    case 'imageText':
      // 画框由版面定死，右栏字数又是照图高反推的，所以这里的高度就是图高。
      return imageTextHeightCm(metrics, block.size, block.maxChars, CAPTION_SIZE_PT);
    case 'table':
      return tableHeightCm(metrics, block.rows, block.hasHeader, CAPTION_SIZE_PT);
    default:
      return 0;
  }
}

/**
 * 前向装箱：图片和表格这类块整体不可拆，放不下就整块进下一页；
 * 段落可以跨页，所以它只是把游标往前推。
 */
export function simulateLayout(
  metrics: PageMetrics,
  blocks: SkeletonBlock[],
  startOffsetCm = 0,
): LayoutSimulation {
  // 装箱的单位是栏不是页：双栏模板下 metrics 的宽高都已经是单栏的，
  // 填满一栏只是换栏，两栏才凑成一张物理页。页数要按栏数折算回去，
  // 否则双栏下预测页数会是实际的两倍，跟排版引擎的分页对不上。
  const columnHeight = metrics.contentHeightCm;
  const columnsPerPage = Math.max(1, metrics.columnCount);
  const pageOf = (column: number) => Math.floor(column / columnsPerPage);

  const placed: PlacedBlock[] = [];
  const tailCm: number[] = [];
  let column = 0;
  let cursor = clamp(startOffsetCm, 0, columnHeight);

  for (const block of blocks) {
    const height = blockHeightCm(metrics, block);
    // 图、图组、图文混排、表格都整体不可分：C# 侧给表格行设了 CantSplit。
    const atomic = block.kind !== 'paragraph' && block.kind !== 'list';
    const remain = columnHeight - cursor;

    if (atomic && height > remain && height <= columnHeight) {
      // 整块放不下：当前栏在这里结束，剩余高度就是空洞。
      tailCm[column] = remain;
      column += 1;
      cursor = 0;
    }

    placed.push({ block, heightCm: height, page: pageOf(column), column, topCm: cursor });
    cursor += height;

    while (cursor > columnHeight) {
      // 段落跨栏：溢出的部分顺延到下一栏，栏尾没有空洞。
      tailCm[column] = 0;
      cursor -= columnHeight;
      column += 1;
    }
  }

  tailCm[column] = columnHeight - cursor;
  const tailLines = tailCm.map((value) => Math.max(0, Math.round(value / metrics.lineHeightCm)));
  const gaps = tailCm
    .map((heightCm, index) => ({
      page: pageOf(index),
      column: index,
      heightCm,
      lines: tailLines[index],
      ratio: heightCm / columnHeight,
    }))
    // 最后一栏的剩余是正常的段落结束，不算空洞。
    .filter((gap) => gap.column < tailCm.length - 1 && gap.lines > ACCEPTABLE_TAIL_LINES);

  return {
    placed,
    pageCount: Math.ceil(tailCm.length / columnsPerPage),
    columnsPerPage,
    tailCm,
    tailLines,
    gaps,
  };
}

/** 先按目标字数铺一组等长段落，图片按序插在段落之间，两侧都留正文。 */
function buildInitialBlocks(input: SkeletonPlanInput): SkeletonBlock[] {
  const { metrics, targetChars, withList } = input;
  const figureBlockCount = Math.max(0, Math.floor(input.figureCount));
  const budget = resolveFigureBudget(metrics, input.maxFigurePageRatio);

  // 版式先定下来，正文字数才知道要扣掉多少给图文混排的右栏。
  const layouts = Array.from(
    { length: figureBlockCount },
    (_, index) => (input.figureLayouts?.[index] ?? FIGURE_LAYOUTS[index % FIGURE_LAYOUTS.length]) as FigureLayout,
  );
  // 图文混排右栏的文字算正文，按真实配额从总字数里先扣掉。
  const imageTextCount = layouts.filter((layout) => layout === 'imageText').length;
  const imageTextChars = imageTextCount > 0
    ? imageTextQuota(metrics, pickImageTextSize(metrics, budget.sizes)).targetChars
    : 0;

  const listItems = withList ? 3 : 0;
  const listCharsPerItem = 28;
  const listChars = listItems * listCharsPerItem;
  const tableCount = input.withTable === false
    ? 0
    // 每一千五百字给一个数据表格的位置，短小节就不塞表了。
    : Math.min(2, Math.floor(targetChars / 1500));
  const tableRows = 3;
  // 表格里的文字也是正文，粗算每格 12 字。
  const tableChars = tableCount * (tableRows + 1) * 3 * 12;

  const proseChars = Math.max(
    MIN_PARAGRAPH_CHARS,
    targetChars - listChars - imageTextCount * imageTextChars - tableChars,
  );

  const paragraphCount = Math.max(
    // 每个图块两侧都要有正文，所以段落数不能少于图块数加一。
    figureBlockCount + 1,
    Math.round(proseChars / DEFAULT_PARAGRAPH_CHARS) || 1,
  );
  const perParagraph = clamp(
    Math.round(proseChars / paragraphCount),
    MIN_PARAGRAPH_CHARS,
    MAX_PARAGRAPH_CHARS,
  );

  const blocks: SkeletonBlock[] = [
    { kind: 'heading', id: 'h', level: input.headingLevel, text: input.headingText },
  ];

  const paragraphs: SkeletonBlock[] = Array.from({ length: paragraphCount }, (_, index) => ({
    kind: 'paragraph' as const,
    id: `p${index + 1}`,
    role: index === 0
      ? 'lead' as const
      : index === paragraphCount - 1 ? 'close' as const : 'body' as const,
    targetChars: perParagraph,
    minChars: Math.round(perParagraph * (1 - PARAGRAPH_TOLERANCE_RATIO)),
    maxChars: Math.round(perParagraph * (1 + PARAGRAPH_TOLERANCE_RATIO)),
  }));

  // 图块插在段落之间的等分位置，保证首段之后、末段之前。
  const figureSlots = Array.from({ length: figureBlockCount }, (_, index) => {
    const step = paragraphCount / (figureBlockCount + 1);
    return clamp(Math.round(step * (index + 1)), 1, paragraphCount - 1);
  });
  // 表格错开图块，避免图挨着表连成一大块不可分内容。
  const tableSlots = Array.from({ length: tableCount }, (_, index) => {
    const step = paragraphCount / (tableCount + 1);
    const slot = clamp(Math.round(step * (index + 1)) + 1, 1, paragraphCount - 1);
    return figureSlots.includes(slot) ? clamp(slot + 1, 1, paragraphCount - 1) : slot;
  });

  let figureSerial = 0;
  const nextFigureId = () => `fig${(figureSerial += 1)}`;

  let listInserted = !withList;
  paragraphs.forEach((paragraph, index) => {
    blocks.push(paragraph);
    const slot = index + 1;

    const figureIndex = figureSlots.indexOf(slot);
    if (figureIndex >= 0) {
      // 生成方式按轮转分配，三种方式在一节里都会露面。
      const suggestedGeneration = GENERATION_ROTATION[figureIndex % GENERATION_ROTATION.length];
      const layout = layouts[figureIndex];
      const common = {
        budgetHeightCm: budget.heightCm,
        allowedSizes: budget.sizes,
        suggestedGeneration,
      };
      if (layout === 'imageText') {
        // 画框先定，右栏字数照图高反推，这一块的高度就此锁死。
        const size = pickImageTextSize(metrics, budget.sizes);
        blocks.push({
          kind: 'imageText',
          id: `mix${figureIndex + 1}`,
          figureId: nextFigureId(),
          size,
          budgetHeightCm: budget.heightCm,
          suggestedGeneration,
          ...imageTextQuota(metrics, size),
        });
      } else if (layout === 'group3' || layout === 'group4') {
        const count = layout === 'group3' ? 3 : 4;
        const groupSize = pickGroupSize(metrics, budget.sizes, count);
        blocks.push({
          kind: 'figureGroup',
          id: `grp${figureIndex + 1}`,
          count,
          figureIds: Array.from({ length: count }, () => nextFigureId()),
          ...common,
          allowedSizes: [groupSize],
          budgetHeightCm: figureGroupHeightCm(metrics, count, groupSize, CAPTION_SIZE_PT),
        });
      } else {
        blocks.push({ kind: 'figure', id: nextFigureId(), ...common });
      }
    }

    const tableIndex = tableSlots.indexOf(slot);
    if (tableIndex >= 0) {
      blocks.push({
        kind: 'table',
        id: `tbl${tableIndex + 1}`,
        preset: TABLE_PRESETS[tableIndex % TABLE_PRESETS.length],
        rows: tableRows,
        cols: 3,
        hasHeader: TABLE_PRESETS[tableIndex % TABLE_PRESETS.length] !== 'headerColumn',
      });
    }

    if (!listInserted && index === 0) {
      blocks.push({
        kind: 'list',
        id: 'list1',
        ordered: true,
        items: listItems,
        charsPerItem: listCharsPerItem,
      });
      listInserted = true;
    }
  });

  return blocks;
}

/**
 * 图组里每格只有三分之一或一半宽，竖版画框会让整组高得离谱。
 * 所以在候选里挑整组高度最矮的那个，宁可方一点也不要一组撑掉大半页。
 */
function pickGroupSize(metrics: PageMetrics, allowed: FigureSize[], count: 3 | 4): FigureSize {
  return [...allowed].sort(
    (left, right) => figureGroupHeightCm(metrics, count, left, CAPTION_SIZE_PT)
      - figureGroupHeightCm(metrics, count, right, CAPTION_SIZE_PT),
  )[0];
}

/**
 * 算出单张图的高度预算和可用画框。
 *
 * 预算是页高的固定比例：超过这个数，正文很难在同一页把图周围填满。
 * 可用画框是所有整块高度不超预算的尺寸；一个都不剩时退回最矮的那个，
 * 让规划继续往下走，可行性由 advice 去报，而不是在这里抛错。
 */
export function resolveFigureBudget(metrics: PageMetrics, maxPageRatio = MAX_FIGURE_PAGE_RATIO) {
  const heightCm = metrics.contentHeightCm * maxPageRatio;
  const sizes = FIGURE_SIZES.filter((size) => metrics.figureBlockHeightCm[size] <= heightCm);
  const shortest = [...FIGURE_SIZES].sort(
    (left, right) => metrics.figureBlockHeightCm[left] - metrics.figureBlockHeightCm[right],
  )[0];
  return { heightCm, sizes: sizes.length > 0 ? sizes : [shortest] };
}

/**
 * 图文混排右栏的字数上限，由左侧图的高度反推。
 *
 * 表格行高是"图高和文字高的较大者"。让文字最多正好写满图那么高，行高就恒等于
 * 图高，这一块从此完全可预测——这是 imageText 不再制造空白页的关键。
 * 留一行余量吸收标点换行的抖动。
 */
export function imageTextQuota(metrics: PageMetrics, size: FigureSize) {
  const imageWidthCm = cellImageWidthCm(metrics, CELL_PLACEMENT.imageTextImage);
  const imageHeightCm = figureHeightAtWidthCm(imageWidthCm, size);
  const maxLines = Math.max(2, Math.floor(imageHeightCm / metrics.lineHeightCm) - 1);
  const maxChars = maxLines * imageTextCharsPerLine(metrics);
  // 目标定在上限的九成，留一点写不满也不算违规的余地。
  const targetChars = Math.max(MIN_PARAGRAPH_CHARS, Math.round(maxChars * 0.9));
  return {
    maxLines,
    targetChars,
    minChars: Math.round(targetChars * (1 - PARAGRAPH_TOLERANCE_RATIO)),
    maxChars,
  };
}

/**
 * 图文混排用哪个画框：右栏要能写下一段像样的说明，整块又不能顶掉大半页。
 * 在够写的画框里挑最矮的。
 */
export function pickImageTextSize(metrics: PageMetrics, allowed: FigureSize[]): FigureSize {
  const scored = allowed.map((size) => ({ size, quota: imageTextQuota(metrics, size) }));
  const usable = scored.filter((item) => item.quota.maxChars >= MIN_PARAGRAPH_CHARS * 1.5);
  const pool = usable.length > 0 ? usable : scored;
  return pool.sort((left, right) => left.quota.maxChars - right.quota.maxChars)[0].size;
}

type ParagraphBlock = Extract<SkeletonBlock, { kind: 'paragraph' }>;

/** 配额变了就同步区间，区间永远围着目标字数走。 */
function retune(paragraph: ParagraphBlock) {
  paragraph.minChars = Math.round(paragraph.targetChars * (1 - PARAGRAPH_TOLERANCE_RATIO));
  paragraph.maxChars = Math.round(paragraph.targetChars * (1 + PARAGRAPH_TOLERANCE_RATIO));
}

/** 高度差换算成字数：按整行取，一行不够写就不算。 */
function charsForGrowth(metrics: PageMetrics, heightCm: number) {
  return Math.max(0, Math.floor(heightCm / metrics.lineHeightCm) * metrics.charsPerLine);
}

function charsForReduction(metrics: PageMetrics, heightCm: number) {
  return Math.max(0, Math.ceil(heightCm / metrics.lineHeightCm) * metrics.charsPerLine);
}

/** 从一段范围里的正文匀出字数，每段都不低于下限。返回实际匀到的数量。 */
function takeChars(blocks: SkeletonBlock[], range: number[], amount: number) {
  let remaining = amount;
  for (const index of range) {
    if (remaining <= 0) break;
    const block = blocks[index];
    if (!block || block.kind !== 'paragraph') continue;
    const spare = block.targetChars - MIN_PARAGRAPH_CHARS;
    if (spare <= 0) continue;
    const taken = Math.min(spare, remaining);
    block.targetChars -= taken;
    retune(block);
    remaining -= taken;
  }
  return amount - remaining;
}

/** 把字数还回一段范围里的正文，每段都不超过上限。返回实际还掉的数量。 */
function giveChars(blocks: SkeletonBlock[], range: number[], amount: number) {
  let remaining = amount;
  for (const index of range) {
    if (remaining <= 0) break;
    const block = blocks[index];
    if (!block || block.kind !== 'paragraph') continue;
    const room = MAX_PARAGRAPH_CHARS - block.targetChars;
    if (room <= 0) continue;
    const given = Math.min(room, remaining);
    block.targetChars += given;
    retune(block);
    remaining -= given;
  }
  return amount - remaining;
}

const indexRange = (from: number, to: number) => {
  const result: number[] = [];
  const step = from <= to ? 1 : -1;
  for (let index = from; step > 0 ? index <= to : index >= to; index += step) result.push(index);
  return result;
};

/**
 * 消除空洞：找出被挤到下一页的图片，要么把它前面写长填满本页，要么把前面写短
 * 让图片回到本页。两条路都同时在小节内部做等量的反向调整，所以总字数守恒——
 * 版面预算重新分配配额，而不是凭空加内容。
 *
 * 页尾剩余超过图块高度一半时，加字更近；否则减字更近。
 */
function closeGaps(input: SkeletonPlanInput, blocks: SkeletonBlock[]) {
  const { metrics } = input;
  const adjustments: string[] = [];
  const working = blocks.map((block) => ({ ...block }));

  for (let round = 0; round < 8; round += 1) {
    const simulation = simulateLayout(metrics, working, input.startOffsetCm);
    if (simulation.gaps.length === 0) break;

    const gap = simulation.gaps[0];
    // 被挤走的是"下一栏"的第一块，双栏下和"下一页"不是一回事。
    const offenderIndex = simulation.placed.findIndex((item) => item.column === gap.column + 1);
    if (offenderIndex <= 0) break;

    const offender = working[offenderIndex];
    const offenderHeight = offender.kind === 'paragraph' || offender.kind === 'list'
      ? 0
      : blockHeightCm(metrics, offender);
    // 前面的正文按由近及远调整，后面的正文用来对冲，保证小节总字数不变。
    const before = indexRange(offenderIndex - 1, 0);
    const after = indexRange(offenderIndex + 1, working.length - 1);
    const hostIndex = before.find((index) => working[index].kind === 'paragraph');
    if (hostIndex === undefined) break;

    const preferShrink = offenderHeight > 0 && gap.heightCm > offenderHeight / 2;
    let changed = false;

    if (preferShrink) {
      const need = charsForReduction(metrics, offenderHeight - gap.heightCm);
      const taken = takeChars(working, before, need);
      if (taken > 0) {
        giveChars(working, after, taken);
        adjustments.push(
          `${describeGapPosition(gap, simulation.columnsPerPage)}尾剩 ${gap.lines} 行，图差一点放得下：`
          + `前文减 ${taken} 字把图拉回来，减掉的字匀给后文。`,
        );
        changed = true;
      }
    }

    if (!changed) {
      const need = charsForGrowth(metrics, gap.heightCm);
      if (need <= 0) break;
      const host = working[hostIndex] as ParagraphBlock;
      const direct = Math.min(need, MAX_PARAGRAPH_CHARS - host.targetChars);
      let filled = 0;

      if (direct > 0) {
        host.targetChars += direct;
        retune(host);
        filled += direct;
      }

      const rest = need - filled;
      if (rest >= MIN_PARAGRAPH_CHARS) {
        // 一段吃不下剩下的，就在图前补一段过渡正文专门承接。
        const filler = clamp(rest, MIN_PARAGRAPH_CHARS, MAX_PARAGRAPH_CHARS);
        const block: ParagraphBlock = {
          kind: 'paragraph',
          id: `p-fill${round + 1}`,
          role: 'bridge',
          targetChars: filler,
          minChars: 0,
          maxChars: 0,
        };
        retune(block);
        working.splice(offenderIndex, 0, block);
        filled += filler;
      }

      if (filled <= 0) break;
      // 加出来的字从后文匀回来；后文匀不出就认了，这一节会比目标略长。
      const offenderNow = working.indexOf(offender);
      const returned = takeChars(working, indexRange(offenderNow + 1, working.length - 1), filled);
      adjustments.push(
        `${describeGapPosition(gap, simulation.columnsPerPage)}尾剩 ${gap.lines} 行，前文加 ${filled} 字填满`
        + `${returned > 0 ? `，其中 ${returned} 字从后文匀出` : '（后文无字可匀，本节略长）'}。`,
      );
      changed = true;
    }

    if (!changed) break;
  }

  return { blocks: working, adjustments };
}

export function planSectionSkeleton(input: SkeletonPlanInput): SkeletonPlan {
  const initial = buildInitialBlocks(input);
  const { blocks, adjustments } = closeGaps(input, initial);
  const simulation = simulateLayout(input.metrics, blocks, input.startOffsetCm);
  const plannedChars = blocks.reduce((total, block) => {
    if (block.kind === 'paragraph' || block.kind === 'imageText') return total + block.targetChars;
    if (block.kind === 'list') return total + block.items * block.charsPerItem;
    // 表格里的文字也是正文，按每格 12 字粗算，和铺骨架时的口径一致。
    if (block.kind === 'table') return total + (block.rows + (block.hasHeader ? 1 : 0)) * block.cols * 12;
    return total;
  }, 0);

  const advice: string[] = [];
  if (simulation.gaps.length > 0 && input.figureCount > 0) {
    // 排不开只有两种解法：加字或者减图，两个数都算出来交给调用方选。
    const budget = resolveFigureBudget(input.metrics, input.maxFigurePageRatio);
    const admission = figureAdmissionChars(input.metrics, budget.heightCm);
    const affordable = admission > 0 ? Math.floor(input.targetChars / admission) : 0;
    advice.push(
      `本节 ${input.targetChars} 字配 ${input.figureCount} 张图排不开，仍有 ${simulation.gaps.length} 处空洞。`
      + `每张图需要约 ${admission} 字正文才填得满它那一页：`
      + `把正文提到约 ${admission * input.figureCount} 字，或把配图减到 ${affordable} 张。`,
    );
  }
  if (plannedChars > input.targetChars * 1.1) {
    advice.push(`为填满版面，配额比目标多了 ${plannedChars - input.targetChars} 字（${input.targetChars} → ${plannedChars}）。`);
  }

  return { blocks, simulation, adjustments, plannedChars, advice, feasible: simulation.gaps.length === 0 };
}

/**
 * 模型挑的画框由版面裁决：在预算内就照用，超预算就降到候选里最接近的那个。
 * 模型说了算的是"这张图该横着还是竖着"，版面说了算的是"最多能占多高"。
 */
export function resolveFigureSize(
  prefer: FigureSize | undefined,
  allowed: FigureSize[],
): { size: FigureSize; downgraded: boolean } {
  if (prefer && allowed.includes(prefer)) return { size: prefer, downgraded: false };
  if (!prefer) return { size: allowed[0], downgraded: false };
  // 降级时挑比例最接近原选择的那个，尽量保住模型对横竖的判断。
  const wanted = FIGURE_GEOMETRY[prefer].aspectWidth / FIGURE_GEOMETRY[prefer].aspectHeight;
  const closest = [...allowed].sort((left, right) => {
    const deltaLeft = Math.abs(FIGURE_GEOMETRY[left].aspectWidth / FIGURE_GEOMETRY[left].aspectHeight - wanted);
    const deltaRight = Math.abs(FIGURE_GEOMETRY[right].aspectWidth / FIGURE_GEOMETRY[right].aspectHeight - wanted);
    return deltaLeft - deltaRight;
  })[0];
  return { size: closest, downgraded: true };
}
