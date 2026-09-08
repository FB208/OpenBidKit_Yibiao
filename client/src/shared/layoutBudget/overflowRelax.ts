/**
 * 组装后的兜底：按模型真正写出来的东西重新装一次箱，还有空洞就调排版。
 *
 * 前面的骨架装箱是在生成之前算的，只能按上界假设。模型仍可能突破——
 * 右栏多写了两行、选了个更高的画框、图组里塞了四张。这一步用真实内容重测，
 * 发现空洞就降级排版：换矮画框、图组减一张、图文混排拆成图加段落。
 *
 * 全程只改结构和属性，一个字都不动，而且发生在渲染之前，所以不是"生成后修内容"。
 */
import type { FigureSize, PageMetrics, TablePreset } from './pageMetrics';
import {
  FIGURE_GEOMETRY,
  FIGURE_SIZES,
  figureGroupHeightCm,
  imageTextCharsPerLine,
} from './pageMetrics';
import type { LayoutSimulation, SkeletonBlock } from './sectionSkeleton';
import { describeGapPosition, imageTextQuota, simulateLayout } from './sectionSkeleton';

/** 图例字号，与骨架规划保持同一个口径。 */
const CAPTION_SIZE_PT = 9;

/** 最多调几轮；每轮只动一个块，调不动就认了，由调用方看诊断。 */
const MAX_ROUNDS = 4;

export interface RelaxResult {
  html: string;
  /** 每一步做了什么，用于在测试页解释算法行为。 */
  actions: string[];
  /** 调整前后的真实装箱结果。 */
  before: LayoutSimulation;
  after: LayoutSimulation;
}

const isFigureSize = (value: string): value is FigureSize => value in FIGURE_GEOMETRY;

const TABLE_PRESETS: TablePreset[] = [
  'plain', 'headerRow', 'headerColumn', 'headerRowAndColumn', 'imageText', 'threeImages', 'fourImages',
];
const isTablePreset = (value: string): value is TablePreset =>
  (TABLE_PRESETS as string[]).includes(value);

function parseBody(html: string) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

function serializeBody(body: HTMLElement) {
  return Array.from(body.children)
    .map((element) => `<!-- yibiao:block -->\n${element.outerHTML}`)
    .join('\n\n');
}

/** 顶层块 id 的合法形状，与 restrictedHtml 的校验保持一致。 */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * 单元格里的段落不带 id 是合法的，一旦被提升成顶层块就必须有 id，
 * 否则 parseRestrictedHtml() 会报"p 缺少合法 id"——等于把合规的模型输出改成不合规。
 */
function assignPromotedIds(elements: Element[], source: Element, prefix: string) {
  const root = source.ownerDocument.body;
  const used = new Set(
    Array.from(root.querySelectorAll('[id]')).map((element) => element.getAttribute('id') || ''),
  );
  const base = ID_PATTERN.test(prefix) ? prefix : `blk${prefix.replace(/[^A-Za-z0-9_-]/g, '')}`;
  let seq = 1;
  for (const element of elements) {
    if (ID_PATTERN.test(element.getAttribute('id') || '')) continue;
    let id = `${base}-p${seq}`;
    while (used.has(id)) {
      seq += 1;
      id = `${base}-p${seq}`;
    }
    element.setAttribute('id', id);
    used.add(id);
    seq += 1;
  }
}

/** 一个元素里的正文字数，图注和配图提示词不算。 */
function textChars(element: Element) {
  const clone = element.cloneNode(true) as Element;
  for (const node of Array.from(clone.querySelectorAll('template, figcaption, caption'))) node.remove();
  return (clone.textContent || '').replace(/\s+/g, '').length;
}

function figureSizeOf(figure: Element | null, fallback: FigureSize = 'wide'): FigureSize {
  const value = (figure?.getAttribute('data-yb-size') || '').trim();
  return isFigureSize(value) ? value : fallback;
}

/**
 * 把组装好的 HTML 逐块翻译成装箱能吃的块，用的全是实际值：
 * 实际字数、模型实际选的画框、图组里实际有几张图。
 */
export function measureAssembledBlocks(html: string, metrics: PageMetrics): SkeletonBlock[] {
  const body = parseBody(html);
  return Array.from(body.children).map((element, index): SkeletonBlock => {
    const tag = element.tagName.toLowerCase();
    const id = element.getAttribute('id') || `blk${index}`;

    if (/^h[1-6]$/.test(tag)) {
      return { kind: 'heading', id, level: Number(tag.slice(1)), text: element.textContent || '' };
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = element.querySelectorAll('li').length || 1;
      return {
        kind: 'list',
        id,
        ordered: tag === 'ol',
        items,
        charsPerItem: Math.ceil(textChars(element) / items),
      };
    }

    if (tag === 'figure') {
      const size = figureSizeOf(element);
      return {
        kind: 'figure',
        id,
        // 用 metrics 里算好的画框高度：那份已经把模板的"图片最大宽度"折进去了，
        // 自己按 widthRatio 重算会绕过这个上限，和规划、Word 渲染三边对不上。
        budgetHeightCm: metrics.figureImageHeightCm[size] + captionChromeCm(metrics),
        allowedSizes: [size],
        suggestedGeneration: 'mermaid',
      };
    }

    if (tag === 'table') {
      const preset = element.getAttribute('data-yb-preset') || 'plain';
      const figures = element.querySelectorAll('figure');

      if (preset === 'imageText') {
        const size = figureSizeOf(figures[0] ?? null);
        const bodyCell = element.querySelectorAll('td')[1] ?? null;
        const chars = bodyCell ? textChars(bodyCell) : 0;
        return {
          kind: 'imageText',
          id,
          figureId: figures[0]?.getAttribute('id') || `${id}-fig`,
          size,
          budgetHeightCm: 0,
          suggestedGeneration: 'mermaid',
          targetChars: chars,
          minChars: chars,
          maxChars: chars,
          maxLines: Math.ceil(chars / imageTextCharsPerLine(metrics)),
        };
      }

      if (preset === 'threeImages' || preset === 'fourImages') {
        const count = preset === 'threeImages' ? 3 : 4;
        const size = figureSizeOf(figures[0] ?? null, 'square');
        return {
          kind: 'figureGroup',
          id,
          count,
          figureIds: Array.from(figures).map((figure) => figure.getAttribute('id') || ''),
          budgetHeightCm: figureGroupHeightCm(metrics, count, size, CAPTION_SIZE_PT),
          allowedSizes: [size],
          suggestedGeneration: 'mermaid',
        };
      }

      const rows = element.querySelectorAll('tbody > tr').length;
      const hasHeader = element.querySelector('thead') !== null;
      const cols = element.querySelector('tr')?.querySelectorAll('th, td').length || 1;
      return {
        kind: 'table',
        id,
        preset: isTablePreset(preset) ? preset : 'plain',
        rows,
        cols,
        hasHeader,
      };
    }

    const chars = textChars(element);
    return { kind: 'paragraph', id, role: 'body', targetChars: chars, minChars: chars, maxChars: chars };
  });
}

/** 图注加图片前后间距。 */
function captionChromeCm(metrics: PageMetrics) {
  return metrics.lineHeightCm + metrics.paragraphSpaceBeforeCm + metrics.paragraphSpaceAfterCm;
}

/** 独立图换个更矮的画框还能矮多少；已经是最矮的就返回 null。 */
function shorterSize(metrics: PageMetrics, current: FigureSize): FigureSize | null {
  // 同样走 metrics：受最大宽度限制后，画框之间谁更矮可能和裸比例排出来的顺序不一样。
  const heightOf = (size: FigureSize) => metrics.figureImageHeightCm[size];
  const shorter = FIGURE_SIZES
    .filter((size) => heightOf(size) < heightOf(current))
    .sort((left, right) => heightOf(right) - heightOf(left));
  return shorter[0] ?? null;
}

/** 图组换个更矮的画框。 */
function shorterGroupSize(metrics: PageMetrics, count: 3 | 4, current: FigureSize): FigureSize | null {
  const heightOf = (size: FigureSize) => figureGroupHeightCm(metrics, count, size, CAPTION_SIZE_PT);
  const shorter = FIGURE_SIZES
    .filter((size) => heightOf(size) < heightOf(current))
    .sort((left, right) => heightOf(right) - heightOf(left));
  return shorter[0] ?? null;
}

/**
 * 右栏写超了，就把溢出的整段搬到表格后面去。
 *
 * 这是 imageText 超写时的首选：版式保住了，行高也回到图高这个可预测的值，
 * 搬出去的段落还能跨页流动。按 <p> 边界整段搬，不切句子、不改一个字。
 */
function trimImageTextOverflow(table: Element, metrics: PageMetrics): boolean {
  const cells = table.querySelectorAll('td');
  const bodyCell = cells[1];
  if (!bodyCell) return false;
  const quota = imageTextQuota(metrics, figureSizeOf(cells[0]?.querySelector('figure'))).maxChars;

  const paragraphs = Array.from(bodyCell.children);
  let used = 0;
  let keep = 0;
  for (const paragraph of paragraphs) {
    const chars = textChars(paragraph);
    // 至少留一段在右栏，否则这个版式就没意义了。
    if (keep > 0 && used + chars > quota) break;
    used += chars;
    keep += 1;
  }
  if (keep >= paragraphs.length) return false;

  const moved = paragraphs.slice(keep);
  assignPromotedIds(moved, table, table.getAttribute('id') || 'blk');

  let anchor: Node = table;
  for (const paragraph of moved) {
    table.parentElement?.insertBefore(paragraph, anchor.nextSibling);
    anchor = paragraph;
  }
  return true;
}

/**
 * 把图文混排拆成"独立图 + 普通段落"。
 *
 * 这是最有效的一招：段落能跨页流动，拆开之后这块内容就再也不会整体被顶下去。
 * 代价是失去左图右文的版式，所以放在最后才用。
 */
function splitImageText(table: Element, metrics: PageMetrics): Element[] {
  const document = table.ownerDocument;
  const cells = table.querySelectorAll('td');
  const figure = cells[0]?.querySelector('figure');
  const caption = table.querySelector('caption')?.textContent?.trim() || '';

  const results: Element[] = [];
  if (figure) {
    // 单元格里图宽只有内容宽的 0.44，独立出来最窄也有 0.5，图必然变大。
    // 所以顺手换成最矮的画框，把这个副作用压到最小。
    const shortest = [...FIGURE_SIZES].sort(
      (left, right) => metrics.figureImageHeightCm[left] - metrics.figureImageHeightCm[right],
    )[0];
    figure.setAttribute('data-yb-size', shortest);
    // 表格里的图本来不需要图注，独立出来就得补一个，否则读者不知道这是什么。
    if (caption && !figure.querySelector('figcaption')) {
      const figcaption = document.createElement('figcaption');
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }
    results.push(figure);
  }
  for (const node of Array.from(cells[1]?.children || [])) {
    if (node.tagName.toLowerCase() === 'figure') continue;
    results.push(node);
  }
  // 右栏段落原来在单元格里，提升到顶层前补齐 id。
  assignPromotedIds(
    results.filter((element) => element.tagName.toLowerCase() !== 'figure'),
    table,
    table.getAttribute('id') || 'blk',
  );
  return results;
}

/** 图组去掉最后一张，四宫格降成三列。 */
function shrinkGroup(table: Element) {
  const figures = table.querySelectorAll('figure');
  if (figures.length <= 3) return false;
  const rows = Array.from(table.querySelectorAll('tbody > tr'));
  // 四宫格是两行两列，砍掉整个第二行只留两张就太少了，改成一行三列。
  const kept = Array.from(figures).slice(0, 3);
  const tbody = table.querySelector('tbody');
  if (!tbody) return false;
  for (const row of rows) row.remove();
  const document = table.ownerDocument;
  const row = document.createElement('tr');
  for (const figure of kept) {
    const cell = document.createElement('td');
    cell.appendChild(figure);
    row.appendChild(cell);
  }
  tbody.appendChild(row);
  table.setAttribute('data-yb-preset', 'threeImages');
  return true;
}

/** 空洞的总高度，是评判一次降级有没有真正改善的唯一标准。 */
function gapScore(simulation: LayoutSimulation) {
  return simulation.gaps.reduce((total, gap) => total + gap.heightCm, 0);
}

/** 一个候选降级动作：就地改 body，返回是否真的改动了。 */
type Candidate = { label: string; apply: (element: Element) => boolean };

/** 针对某个块能试的降级手段，按代价从低到高排列。 */
function candidatesFor(element: Element, metrics: PageMetrics): Candidate[] {
  const tag = element.tagName.toLowerCase();
  const preset = element.getAttribute('data-yb-preset') || '';
  const id = element.getAttribute('id') || '';

  if (tag === 'figure') {
    const current = figureSizeOf(element);
    const next = shorterSize(metrics, current);
    return next
      ? [{
        label: `${id} 画框 ${current} → ${next}`,
        apply: (target) => { target.setAttribute('data-yb-size', next); return true; },
      }]
      : [];
  }

  if (preset === 'threeImages' || preset === 'fourImages') {
    const count = preset === 'threeImages' ? 3 : 4;
    const current = figureSizeOf(element.querySelector('figure'), 'square');
    const next = shorterGroupSize(metrics, count, current);
    const list: Candidate[] = [];
    if (next) {
      list.push({
        label: `图组 ${id} 画框 ${current} → ${next}`,
        apply: (target) => {
          for (const figure of Array.from(target.querySelectorAll('figure'))) {
            figure.setAttribute('data-yb-size', next);
          }
          return true;
        },
      });
    }
    if (preset === 'fourImages') {
      list.push({ label: `四宫格 ${id} 降为一行三列`, apply: (target) => shrinkGroup(target) });
    }
    return list;
  }

  if (preset === 'imageText') {
    return [
      {
        label: `图文混排 ${id} 右栏溢出的段落移到表格后面`,
        apply: (target) => trimImageTextOverflow(target, metrics),
      },
      {
        label: `图文混排 ${id} 拆成独立图加段落`,
        apply: (target) => {
          const replacements = splitImageText(target, metrics);
          if (replacements.length === 0) return false;
          for (const node of replacements) target.parentElement?.insertBefore(node, target);
          target.remove();
          return true;
        },
      },
    ];
  }

  // 数据表格没有可降级的排版。
  return [];
}

/**
 * 用真实内容重新装箱，还有空洞就试着降级排版。
 *
 * 每个候选动作都要先试、再量、不划算就回滚：把图降小却依然放不下，
 * 或者把图文混排拆开反而多出一页，都是纯亏损。只有空洞总高度真的减少了
 * 才把这次改动留下。所有手段都试过仍无改善就停手，保留原样并如实上报——
 * 有些空洞是内容本身决定的，硬调只会既丢版式又不解决问题。
 */
export function relaxOverflow(html: string, metrics: PageMetrics, startOffsetCm = 0): RelaxResult {
  const actions: string[] = [];
  const measure = (source: string) => simulateLayout(metrics, measureAssembledBlocks(source, metrics), startOffsetCm);
  const before = measure(html);

  let current = html;
  let simulation = before;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (simulation.gaps.length === 0) break;
    const baseline = gapScore(simulation);

    const gap = simulation.gaps[0];
    // 被顶下去的是下一栏的第一块；双栏模板下"下一栏"未必是"下一页"。
    const offenderIndex = simulation.placed.findIndex((item) => item.column === gap.column + 1);
    if (offenderIndex < 0) break;

    const probe = parseBody(current);
    const offender = probe.children[offenderIndex];
    if (!offender) break;

    let improved = false;
    for (const candidate of candidatesFor(offender, metrics)) {
      // 每个候选都在一份独立的副本上试，失败了原件不受影响。
      const trialBody = parseBody(current);
      const target = trialBody.children[offenderIndex];
      if (!target || !candidate.apply(target)) continue;

      const trialHtml = serializeBody(trialBody);
      const trialSimulation = measure(trialHtml);
      // 留一点余量，避免为了几毫米的改善牺牲版式。
      if (gapScore(trialSimulation) >= baseline - metrics.lineHeightCm) continue;

      actions.push(
        `${describeGapPosition(gap, simulation.columnsPerPage)}尾剩 ${gap.lines} 行：${candidate.label}，`
        + `空洞从 ${(baseline / metrics.lineHeightCm).toFixed(0)} 行降到 `
        + `${(gapScore(trialSimulation) / metrics.lineHeightCm).toFixed(0)} 行。`,
      );
      current = trialHtml;
      simulation = trialSimulation;
      improved = true;
      break;
    }

    if (!improved) {
      const id = offender.getAttribute('id') || offender.tagName.toLowerCase();
      actions.push(
        `${describeGapPosition(gap, simulation.columnsPerPage)}尾剩 ${gap.lines} 行：`
        + `${id} 没有能真正改善的降级手段，保留原样。`,
      );
      break;
    }
  }

  return { html: current, actions, before, after: simulation };
}
