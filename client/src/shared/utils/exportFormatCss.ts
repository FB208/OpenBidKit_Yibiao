/**
 * 将 ExportFormatConfig 映射为 CSS 自定义属性
 * 注入到正文预览容器的 style 上，实现实时 WYSIWYG 预览
 */

import type { ExportFormatConfig, HeadingStyleConfig, ListStyle, OrderedListStyle, PaperSize } from '../types/exportFormat';
import { SIZE_TO_PT, FONT_TO_CSS, ALIGNMENT_TO_CSS, PAPER_DIMENSIONS, DEFAULT_HEADING_BORDER_CELL_COLORS } from '../types/exportFormat';

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
    [`--ef-h${n}-indent`]: '0',
    [`--ef-h${n}-line-height`]: String(config.line_spacing),
  };
}

function unorderedListStyleToCss(style: ListStyle | string | undefined, listIndent: string) {
  switch (style) {
    case 'none':
      return { marker: '""', font: 'inherit', size: '1em', display: 'none', indent: listIndent };
    case 'circle':
      return { marker: '"○"', font: 'Arial, sans-serif', size: '0.82em', display: 'inline-block', indent: listIndent };
    case 'square':
      return { marker: '"■"', font: 'Arial, sans-serif', size: '0.72em', display: 'inline-block', indent: listIndent };
    case 'diamond':
      return { marker: '"◆"', font: 'Arial, sans-serif', size: '0.72em', display: 'inline-block', indent: listIndent };
    case 'dash':
      return { marker: '"–"', font: 'Arial, sans-serif', size: '0.9em', display: 'inline-block', indent: listIndent };
    case 'check':
      return { marker: '"✓"', font: 'Segoe UI Symbol, Arial, sans-serif', size: '0.85em', display: 'inline-block', indent: listIndent };
    case 'arrow':
      return { marker: '"➢"', font: 'Segoe UI Symbol, Arial, sans-serif', size: '0.88em', display: 'inline-block', indent: listIndent };
    case 'sparkle':
      return { marker: '"✧"', font: 'Segoe UI Symbol, Arial, sans-serif', size: '0.9em', display: 'inline-block', indent: listIndent };
    default:
      return { marker: '"•"', font: 'Arial, sans-serif', size: '0.75em', display: 'inline-block', indent: listIndent };
  }
}

function orderedListStyleToCss(style: OrderedListStyle | string | undefined) {
  switch (style) {
    case 'decimal-paren':
      return { counterStyle: 'decimal', prefix: '""', suffix: '"） "' };
    case 'decimal-full-paren':
      return { counterStyle: 'decimal', prefix: '"（"', suffix: '"） "' };
    case 'chinese-dot':
      return { counterStyle: 'cjk-ideographic', prefix: '""', suffix: '"、 "' };
    case 'chinese-paren':
      return { counterStyle: 'cjk-ideographic', prefix: '"（"', suffix: '"） "' };
    case 'lower-alpha':
      return { counterStyle: 'lower-alpha', prefix: '""', suffix: '". "' };
    case 'upper-alpha':
      return { counterStyle: 'upper-alpha', prefix: '""', suffix: '". "' };
    case 'lower-roman':
      return { counterStyle: 'lower-roman', prefix: '""', suffix: '". "' };
    case 'upper-roman':
      return { counterStyle: 'upper-roman', prefix: '""', suffix: '". "' };
    default:
      return { counterStyle: 'decimal', prefix: '""', suffix: '". "' };
  }
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
  const frameCellColors = DEFAULT_HEADING_BORDER_CELL_COLORS.map((color, index) => headingBorder?.level_cell_colors?.[index] || color);
  vars['--ef-chapter-frame-border'] = frameEnabled ? `0.8pt solid ${frameColor}` : 'none';
  vars['--ef-chapter-frame-color'] = frameEnabled ? frameColor : 'transparent';
  vars['--ef-chapter-row-border'] = frameEnabled ? `0.6pt solid color-mix(in srgb, ${frameColor} 55%, white)` : 'none';
  frameCellColors.forEach((color, index) => {
    vars[`--ef-chapter-row-${index + 1}-background`] = frameEnabled ? color : 'transparent';
  });

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
  const listIndent = `${config.body_text.list_indent_chars ?? 2}em`;
  vars['--ef-list-indent'] = listIndent;
  const unorderedListStyle = unorderedListStyleToCss(config.body_text.list_style, listIndent);
  vars['--ef-unordered-list-marker'] = unorderedListStyle.marker;
  vars['--ef-unordered-list-marker-font'] = unorderedListStyle.font;
  vars['--ef-unordered-list-marker-size'] = unorderedListStyle.size;
  vars['--ef-unordered-list-marker-display'] = unorderedListStyle.display;
  vars['--ef-unordered-list-indent'] = unorderedListStyle.indent;
  const orderedListStyle = orderedListStyleToCss(config.body_text.ordered_list_style);
  vars['--ef-ordered-list-counter-style'] = orderedListStyle.counterStyle;
  vars['--ef-ordered-list-prefix'] = orderedListStyle.prefix;
  vars['--ef-ordered-list-suffix'] = orderedListStyle.suffix;

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
    vars['--ef-image-caption-weight'] = image.caption_bold ? '700' : '400';
    vars['--ef-image-caption-style'] = image.caption_italic ? 'italic' : 'normal';
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
