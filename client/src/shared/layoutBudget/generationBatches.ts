/**
 * 按骨架把一节正文切成几批生成。
 *
 * 一次请求写五千字会撞上服务商的单次输出上限，返回半截 HTML。骨架本来就把内容
 * 切成了带明确配额的独立块，图块又是天然的分隔点，所以分批不需要引入 agent：
 * 每批仍是一次普通请求，装箱和配额一概不变，只是把生成动作切开了。
 *
 * 批次之间靠三样东西保持连贯：完整的块清单（模型始终看得到全局结构和自己在哪一段）、
 * 上一批结尾的原文（承接语气）、已经写过的要点（不重复论述）。
 */
import type { SkeletonBlock, SkeletonPlan } from './sectionSkeleton';
import { describeSkeleton, type SkeletonPromptContext } from './skeletonPrompt';

/** 每批的目标字数。太大又会撞上限，太小则批次多、承接成本高。 */
export const DEFAULT_BATCH_CHARS = 2000;
/** 达到这个字数之后，遇到图块就切——图块是最自然的段落分界。 */
export const BATCH_SPLIT_THRESHOLD_RATIO = 0.6;

export interface GenerationBatch {
  index: number;
  /** 本批负责的块，按骨架顺序。 */
  blocks: SkeletonBlock[];
  /** 本批的正文字数配额合计。 */
  chars: number;
}

/** 一个块自带多少正文字数；图和标题不算。 */
export function blockChars(block: SkeletonBlock) {
  switch (block.kind) {
    case 'paragraph':
    case 'imageText':
      return block.targetChars;
    case 'list':
      return block.items * block.charsPerItem;
    case 'table':
      // 与骨架铺块时的口径一致：每格 12 字。
      return (block.rows + (block.hasHeader ? 1 : 0)) * block.cols * 12;
    default:
      return 0;
  }
}

const isFigureBlock = (block: SkeletonBlock) =>
  block.kind === 'figure' || block.kind === 'figureGroup' || block.kind === 'imageText';

/**
 * 切批：先攒字数，攒够六成之后遇到图块就在它之后断开；
 * 一直没遇到图块就在超出配额时硬切。标题不占字数，跟着第一批走。
 */
export function planBatches(
  blocks: SkeletonBlock[],
  maxCharsPerBatch = DEFAULT_BATCH_CHARS,
): GenerationBatch[] {
  const writable = blocks.filter((block) => block.kind !== 'heading');
  const total = writable.reduce((sum, block) => sum + blockChars(block), 0);
  if (total <= maxCharsPerBatch) {
    return [{ index: 0, blocks: writable, chars: total }];
  }

  const threshold = maxCharsPerBatch * BATCH_SPLIT_THRESHOLD_RATIO;
  const batches: GenerationBatch[] = [];
  let current: SkeletonBlock[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({ index: batches.length, blocks: current, chars });
    current = [];
    chars = 0;
  };

  for (const block of writable) {
    const value = blockChars(block);
    // 还没放就已经超了，说明上一批该结束了。
    if (current.length > 0 && chars + value > maxCharsPerBatch) flush();
    current.push(block);
    chars += value;
    // 攒够了又正好走到图块，这里断开最自然。
    if (chars >= threshold && isFigureBlock(block)) flush();
  }
  flush();

  return batches.map((batch, index) => ({ ...batch, index }));
}

/** 把已经写好的正文压成要点清单，让后面的批次知道哪些话说过了。 */
export function summarizeCovered(html: string, limit = 12) {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const points: string[] = [];
  for (const element of Array.from(document.body.querySelectorAll('p, li, figcaption, caption'))) {
    const text = (element.textContent || '').replace(/\s+/g, '');
    if (text.length < 8) continue;
    points.push(text.slice(0, 24));
    if (points.length >= limit) break;
  }
  return points;
}

/** 取上一批结尾的一段原文，用来承接语气。 */
export function tailOf(html: string, chars = 160) {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const paragraphs = Array.from(document.body.querySelectorAll('p'));
  const last = paragraphs[paragraphs.length - 1];
  const text = (last?.textContent || '').replace(/\s+/g, '');
  return text.length > chars ? text.slice(-chars) : text;
}

/** 非本批的块只报类型和字数量级，让模型知道全局结构就够了。 */
function briefBlock(block: SkeletonBlock) {
  const chars = blockChars(block);
  const scale = chars > 0 ? `约 ${chars} 字` : '无正文';
  switch (block.kind) {
    case 'paragraph':
      return `段落块 ${block.id}（${scale}）`;
    case 'list':
      return `列表块 ${block.id}（${scale}）`;
    case 'figure':
      return `独立配图块 ${block.id}`;
    case 'imageText':
      return `图文混排块 ${block.id}（${scale}）`;
    case 'figureGroup':
      return `并列图组块 ${block.id}（${block.count} 张）`;
    case 'table':
      return `数据表格块 ${block.id}（${scale}）`;
    default:
      return `块 ${block.id}`;
  }
}

export interface BatchPromptInput {
  plan: SkeletonPlan;
  context: SkeletonPromptContext;
  batches: GenerationBatch[];
  batch: GenerationBatch;
  /** 已经生成好的前几批 HTML，用来提取承接信息。 */
  generatedHtml: string;
}

/**
 * 单批的用户提示词。
 *
 * 块清单永远给完整的那份，只把本批要写的标出来——模型知道全局才写得出承上启下的话，
 * 只看见自己那一段就会每批都从头介绍一遍。
 */
export function buildBatchUserPrompt(input: BatchPromptInput) {
  const { plan, context, batches, batch, generatedHtml } = input;
  const ids = new Set(batch.blocks.map((block) => block.id));
  const facts = context.globalFacts.trim();

  // 本批的块给完整规格，其余只留一行骨架：模型需要全局结构感，
  // 但不需要别人那一批的字数区间和画框选项——那些每批重发一遍纯属浪费。
  const detailed = describeSkeleton(plan.blocks, true).split('\n');
  const outline = plan.blocks
    .filter((block) => block.kind !== 'heading')
    .map((block, index) => (ids.has(block.id)
      ? `${detailed[index]}   ← 本批要写`
      : `${index + 1}. ${briefBlock(block)}`))
    .join('\n');

  const covered = generatedHtml ? summarizeCovered(generatedHtml) : [];
  const tail = generatedHtml ? tailOf(generatedHtml) : '';

  return `# 项目信息
项目名称：${context.projectName || '（未填写）'}
${context.projectOverview ? `项目概述：${context.projectOverview}` : ''}

# 本节位置
${context.sectionPath}
本节标题：${context.sectionTitle}
${context.sectionDescription ? `本节说明：${context.sectionDescription}` : ''}

${facts ? `# 本节须遵守的事实设定\n${facts}\n` : ''}
# 本节完整块清单（共 ${batches.length} 批，你现在写第 ${batch.index + 1} 批）
${outline}

${tail ? `# 上一批结尾的原文\n${tail}\n\n从这里自然接下去，不要重新开题。\n` : ''}
${covered.length ? `# 前面已经写过的要点（不要重复论述）\n${covered.map((point) => `- ${point}`).join('\n')}\n` : ''}
# 本批要求
只输出上面标了"← 本批要写"的那些块，一块不多一块不少，顺序照旧。
本批正文合计约 ${batch.chars} 字。${batch.index + 1 === batches.length ? '这是最后一批，收束全节。' : '后面还有内容，不要写总结性的收尾。'}`;
}
