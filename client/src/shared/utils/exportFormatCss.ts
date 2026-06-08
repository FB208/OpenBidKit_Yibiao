/**
 * 将 ExportFormatConfig 映射为 CSS 自定义属性
 * 注入到正文预览容器的 style 上，实现实时 WYSIWYG 预览
 */

import type { ExportFormatConfig, HeadingStyleConfig, PaperSize } from '../types/exportFormat';
import { SIZE_TO_PT, FONT_TO_CSS, ALIGNMENT_TO_CSS, PAPER_DIMENSIONS } from '../types/exportFormat';

/**
 * 中文字号名 → pt 值
 */
export function chineseSizeToPt(sizeName: string): number {
  return SIZE_TO_PT[sizeName] ?? 12;
}

/**
 * 中文字体名 → CSS font-family
 */
export function chineseFontToCss(fontName: string): string {
  return FONT_TO_CSS[fontName] ?? `'${fontName}', sans-serif`;
}

/**
 * 中文对齐名 → CSS text-align
 */
export function alignmentToCss(align: string): string {
  return ALIGNMENT_TO_CSS[align] ?? 'left';
}

/**
 * 构建标题级别的 CSS 变量集
 */
function buildHeadingVars(level: number, config: HeadingStyleConfig): Record<string, string> {
  const n = level + 1; // CSS 变量用 h1-h6
  const sizePt = chineseSizeToPt(config.size);

  return {
    [`--ef-h${n}-font`]: chineseFontToCss(config.font),
    [`--ef-h${n}-size`]: `${sizePt}pt`,
    [`--ef-h${n}-align`]: alignmentToCss(config.alignment),
    [`--ef-h${n}-spacing-before`]: `${config.spacing_before_pt}pt`,
    [`--ef-h${n}-spacing-after`]: `${config.spacing_after_pt}pt`,
    [`--ef-h${n}-indent`]: config.first_line_indent_chars > 0 ? `${config.first_line_indent_chars}em` : '0',
    [`--ef-h${n}-line-height`]: String(config.line_spacing),
  };
}

/**
 * 将完整的 ExportFormatConfig 转换为 CSS 自定义属性键值对
 * 可直接展开到 React 组件的 style 属性上
 */
export function buildExportFormatCssVars(config: ExportFormatConfig): Record<string, string> {
  const vars: Record<string, string> = {};

  // ── 页面设置 ──
  const dims = PAPER_DIMENSIONS[config.page.paper_size as PaperSize] || PAPER_DIMENSIONS.a4;
  const landscape = config.page.orientation === 'landscape';
  const pageWidth = landscape ? `${dims.height}mm` : `${dims.width}mm`;

  vars['--ef-page-width'] = pageWidth;
  vars['--ef-page-padding-top'] = `${config.page.margin_top_cm}cm`;
  vars['--ef-page-padding-bottom'] = `${config.page.margin_bottom_cm}cm`;
  vars['--ef-page-padding-left'] = `${config.page.margin_left_cm}cm`;
  vars['--ef-page-padding-right'] = `${config.page.margin_right_cm}cm`;

  // ── 正文 ──
  const bodySizePt = chineseSizeToPt(config.body_text.size);
  vars['--ef-body-font'] = chineseFontToCss(config.body_text.font);
  vars['--ef-body-size'] = `${bodySizePt}pt`;
  vars['--ef-body-align'] = alignmentToCss(config.body_text.alignment);
  vars['--ef-body-spacing-before'] = `${config.body_text.spacing_before_pt}pt`;
  vars['--ef-body-spacing-after'] = `${config.body_text.spacing_after_pt}pt`;
  vars['--ef-body-indent'] = config.body_text.first_line_indent_chars > 0
    ? `${config.body_text.first_line_indent_chars}em`
    : '0';
  vars['--ef-body-line-height'] = String(config.body_text.line_spacing_multiple);

  // ── 各级标题 h1-h6 ──
  for (let i = 0; i < 6; i++) {
    const heading = config.headings[i];
    if (heading) {
      Object.assign(vars, buildHeadingVars(i, heading));
    }
  }

  return vars;
}

/**
 * 中文字号 → Word half-points（用于 exportService）
 */
export function chineseSizeToHalfPoints(sizeName: string): number {
  const pt = chineseSizeToPt(sizeName);
  return Math.round(pt * 2);
}

/**
 * 厘米 → twips（用于 exportService 页面设置）
 * 1cm = 567 twips
 */
export function cmToTwips(cm: number): number {
  return Math.round(cm * 567);
}

/**
 * 磅 → twips（用于 exportService 间距）
 * 1pt = 20 twips
 */
export function ptToTwips(pt: number): number {
  return Math.round(pt * 20);
}
