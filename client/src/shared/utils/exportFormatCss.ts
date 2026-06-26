/**
 * 将 ExportFormatConfig 映射为 CSS 自定义属性
 * 注入到正文预览容器的 style 上，实现实时 WYSIWYG 预览
 */

import type { ExportFormatConfig, HeadingStyleConfig, ListStyle, PaperSize } from '../types/exportFormat';
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
    [`--ef-h${n}-weight`]: config.bold ? '700' : '400',
    [`--ef-h${n}-color`]: config.text_color || '#243048',
    [`--ef-h${n}-spacing-before`]: `${config.spacing_before_pt}pt`,
    [`--ef-h${n}-spacing-after`]: `${config.spacing_after_pt}pt`,
    [`--ef-h${n}-indent`]: config.first_line_indent_chars > 0 ? `${config.first_line_indent_chars}em` : '0',
    [`--ef-h${n}-line-height`]: String(config.line_spacing),
  };
}

function listStyleToCss(style: ListStyle | string | undefined): string {
  if (style === 'dash') return '"- "';
  if (style === 'circle') return 'circle';
  if (style === 'square') return 'square';
  return 'disc';
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
  const pageWidth = landscape ? dims.height : dims.width;
  const pageHeight = landscape ? dims.width : dims.height;

  vars['--ef-page-width'] = `${pageWidth}mm`;
  vars['--ef-page-height'] = `${pageHeight}mm`;
  vars['--ef-page-aspect'] = `${pageWidth} / ${pageHeight}`;
  vars['--ef-page-padding-top'] = `${config.page.margin_top_cm}cm`;
  vars['--ef-page-padding-bottom'] = `${config.page.margin_bottom_cm}cm`;
  vars['--ef-page-padding-left'] = `${config.page.margin_left_cm}cm`;
  vars['--ef-page-padding-right'] = `${config.page.margin_right_cm}cm`;
  vars['--ef-header-font'] = chineseFontToCss(config.page.header_font || '宋体');
  vars['--ef-header-size'] = `${chineseSizeToPt(config.page.header_size || '小五')}pt`;
  vars['--ef-header-align'] = alignmentToCss(config.page.header_alignment || '居中对齐');
  vars['--ef-header-color'] = config.page.header_color || '#536176';
  vars['--ef-footer-font'] = chineseFontToCss(config.page.footer_font || '宋体');
  vars['--ef-footer-size'] = `${chineseSizeToPt(config.page.footer_size || '小五')}pt`;
  vars['--ef-footer-align'] = alignmentToCss(config.page.footer_alignment || '居中对齐');
  vars['--ef-footer-color'] = config.page.footer_color || '#536176';

  // ── 章节页框 ──
  const headingBorder = config.heading_border;
  const frameEnabled = headingBorder?.enabled === true;
  const frameColor = headingBorder?.border_color || '#2174fd';
  vars['--ef-chapter-frame-border'] = frameEnabled ? `0.8pt solid ${frameColor}` : 'none';
  vars['--ef-chapter-frame-color'] = frameEnabled ? frameColor : 'transparent';
  vars['--ef-chapter-row-border'] = frameEnabled ? `0.6pt solid color-mix(in srgb, ${frameColor} 55%, white)` : 'none';
  vars['--ef-chapter-row-1-background'] = frameEnabled ? `color-mix(in srgb, ${frameColor} 15%, white)` : 'transparent';
  vars['--ef-chapter-row-2-background'] = frameEnabled ? `color-mix(in srgb, ${frameColor} 10%, white)` : 'transparent';
  vars['--ef-chapter-row-3-background'] = frameEnabled ? `color-mix(in srgb, ${frameColor} 6%, white)` : 'transparent';
  vars['--ef-chapter-row-4-background'] = frameEnabled ? `color-mix(in srgb, ${frameColor} 3%, white)` : 'transparent';
  vars['--ef-chapter-row-5-background'] = '#ffffff';
  vars['--ef-chapter-row-6-background'] = '#ffffff';

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
  vars['--ef-list-style-type'] = listStyleToCss(config.body_text.list_style);
  vars['--ef-list-indent'] = `${config.body_text.list_indent_chars ?? 2}em`;

  // ── 各级标题 h1-h6 ──
  for (let i = 0; i < 6; i++) {
    const heading = config.headings[i];
    if (heading) {
      Object.assign(vars, buildHeadingVars(i, heading));
    }
  }

  // ── 表格 ──
  const table = config.table;
  if (table) {
    vars['--ef-table-border-width'] = `${table.border_width ?? 1}px`;
    vars['--ef-table-border-color'] = table.border_color || '#dcdff6';
    vars['--ef-table-cell-padding'] = `${table.cell_padding_pt ?? 6}pt`;
    vars['--ef-table-width'] = table.full_width ? '100%' : 'auto';
    const tableAreas = [
      ['header', table.header_row],
      ['first-column', table.first_column],
      ['body-cell', table.body_cell],
    ] as const;
    tableAreas.forEach(([key, cell]) => {
      if (!cell) return;
      vars[`--ef-table-${key}-font`] = chineseFontToCss(cell.font);
      vars[`--ef-table-${key}-size`] = `${chineseSizeToPt(cell.size)}pt`;
      vars[`--ef-table-${key}-align`] = alignmentToCss(cell.alignment);
      vars[`--ef-table-${key}-color`] = cell.text_color || '#243048';
      vars[`--ef-table-${key}-background`] = cell.background_color || '#ffffff';
    });
  }

  // ── 图片 ──
  const image = config.image;
  if (image) {
    vars['--ef-image-max-width'] = `${image.max_width_percent ?? 90}%`;
    vars['--ef-image-align'] = alignmentToCss(image.alignment || '居中对齐');
    vars['--ef-image-caption-font'] = chineseFontToCss(image.caption_font || '宋体');
    vars['--ef-image-caption-size'] = `${chineseSizeToPt(image.caption_size || '小五')}pt`;
    vars['--ef-image-caption-align'] = alignmentToCss(image.caption_alignment || '居中对齐');
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
