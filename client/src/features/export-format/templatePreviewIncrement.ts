import type { ExportFormatConfig } from '../../shared/types/exportFormat';

/**
 * 模板样张的增量更新计划。
 *
 * 样张的权威渲染在 OpenXmlHelper：一次配置改动重新生成整篇 docx 再交给编辑器打开，
 * 结果一定和导出一致，代价是每次约 140ms。编辑器自带的 automation 接口能就地改样式，
 * 少数段落的改动只要 16–47ms，但它覆盖得了的属性有限，所以这里的职责是判断
 * “这次改动能不能就地做且结果与重新生成完全一致”，只要判不准就一律退回重新生成。
 *
 * 目前只有标题 1–6 的这几项走增量：字号、颜色、加粗、对齐、段前距、段后距、首行缩进。
 * 这一组逐块比对过增量结果与权威样张的渲染位置，完全吻合。
 *
 * 刻意排除的几类，都是实测确认做不到或做不准的：
 *   - 字体：setFont 只写 w:ascii/w:hAnsi，中文 run 的 w:eastAsia 不受影响，改了没效果
 *   - 行距：automation 的 lineSpacing 是固定值语义，与模板配置的“倍数”没有可靠换算
 *   - 版面（纸张、方向、页边距）：setPageSetup 写进去的值与权威逐字段相同，
 *     但增量重排后每页可容纳的高度有微小出入，跨页处会累积偏移（实测第二页起 20px、
 *     到第四页 35px）。预览与导出的分页位置必须一致，所以这一类仍然重新生成
 *   - 标题编号、标题边框、一级标题前分页、分栏、首页不同、页码起始：没有对应写操作
 *   - 表格、图片、页眉页脚：automation 没有相应的写操作
 *
 * 下面的换算必须和 RestrictedHtmlDocumentRenderer.cs 保持一致，改一处就要改两处。
 */

/** 与 C# ChineseFontSizes 对应的字号磅值。 */
const CHINESE_FONT_SIZES: Record<string, number> = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 小六: 6.5,
};

const ALIGNMENTS: Record<string, 'Left' | 'Centered' | 'Right' | 'Justified'> = {
  居中对齐: 'Centered',
  右对齐: 'Right',
  两端对齐: 'Justified',
  左对齐: 'Left',
};

/** 走增量的标题字段；此外的任何字段变化都要重新生成整篇。 */
const HEADING_FIELDS = [
  'size', 'text_color', 'bold', 'alignment',
  'spacing_before_pt', 'spacing_after_pt', 'first_line_indent_chars',
] as const;

export interface PreviewFontPatch {
  size: number;
  color: string;
  bold: boolean;
}

export interface PreviewFormatPatch {
  alignment: 'Left' | 'Centered' | 'Right' | 'Justified';
  spaceBefore: number;
  spaceAfter: number;
  firstLineIndent: number;
}

export interface PreviewHeadingPatch {
  /** 1–6，对应段落角色 heading1…heading6。 */
  level: number;
  font: PreviewFontPatch;
  format: PreviewFormatPatch;
}

export type PreviewPlan =
  | { kind: 'none' }
  | { kind: 'rebuild' }
  | { kind: 'incremental'; headings: PreviewHeadingPatch[] };

function fontPoints(size: string): number {
  return CHINESE_FONT_SIZES[size] ?? 12;
}

/** C# CharsToTwips：chars × halfPoints × 10 twips，换算成磅即 chars × 字号磅值。 */
function firstLineIndentPoints(chars: number, sizePoints: number): number {
  return Math.max(0, chars * sizePoints);
}

function normalizeColor(value: string): string {
  const text = (value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : '#000000';
}

function changedKeys<T extends object>(previous: T, next: T): Set<string> {
  const keys = new Set<string>();
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])) {
    const a = (previous as Record<string, unknown>)?.[key];
    const b = (next as Record<string, unknown>)?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) keys.add(key);
  }
  return keys;
}

function buildHeadingPatch(heading: ExportFormatConfig['headings'][number], level: number): PreviewHeadingPatch {
  const sizePoints = fontPoints(heading.size);
  return {
    level,
    font: {
      size: sizePoints,
      color: normalizeColor(heading.text_color),
      bold: Boolean(heading.bold),
    },
    format: {
      alignment: ALIGNMENTS[heading.alignment] ?? 'Left',
      spaceBefore: Math.max(0, heading.spacing_before_pt),
      spaceAfter: Math.max(0, heading.spacing_after_pt),
      firstLineIndent: firstLineIndentPoints(heading.first_line_indent_chars, sizePoints),
    },
  };
}

/**
 * 比较编辑器当前呈现的配置与目标配置，判断能否就地更新。
 *
 * `applied` 为空（还没有样张）时一律重新生成。任何落在支持集之外的字段变化，
 * 哪怕同时还有支持集内的变化，也整体退回重新生成——否则会出现一半就地改、
 * 一半没改的中间态，比慢一点糟糕得多。
 */
export function planPreviewUpdate(
  applied: ExportFormatConfig | null,
  next: ExportFormatConfig,
  roles: readonly string[],
): PreviewPlan {
  if (!applied || roles.length === 0) return { kind: 'rebuild' };

  const topLevel = changedKeys(applied, next);
  topLevel.delete('template_name');
  const headingsChanged = topLevel.delete('headings');
  if (topLevel.size > 0) return { kind: 'rebuild' };
  if (!headingsChanged) return { kind: 'none' };
  if (applied.headings.length !== next.headings.length) return { kind: 'rebuild' };

  const headings: PreviewHeadingPatch[] = [];
  for (let index = 0; index < next.headings.length; index += 1) {
    const changed = changedKeys(applied.headings[index], next.headings[index]);
    if (changed.size === 0) continue;
    for (const key of changed) {
      if (!(HEADING_FIELDS as readonly string[]).includes(key)) return { kind: 'rebuild' };
    }
    const level = index + 1;
    // 样张里没有出现的标题级别没有段落可改，但配置确实变了，只能重新生成。
    if (!roles.includes(`heading${level}`)) return { kind: 'rebuild' };
    headings.push(buildHeadingPatch(next.headings[index], level));
  }

  return headings.length > 0 ? { kind: 'incremental', headings } : { kind: 'none' };
}
