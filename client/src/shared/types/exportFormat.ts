/**
 * 导出格式配置类型、编号格式选项和字号/字体映射表
 */

// ── 编号格式 ─────────────────────────────────────
export const NUMBERING_FORMATS = [
  { value: 'chinese-chapter', label: '第一章', hint: '第{一}章' },
  { value: 'chinese-section', label: '第一节', hint: '第{一}节' },
  { value: 'chinese-dun', label: '一、', hint: '{一}、' },
  { value: 'chinese-paren', label: '（一）', hint: '（{一}）' },
  { value: 'arabic-dun', label: '1、', hint: '{1}、' },
  { value: 'arabic-dot', label: '1.', hint: '{1}.' },
  { value: 'arabic-paren', label: '(1)', hint: '({1})' },
  { value: 'arabic', label: '1', hint: '{1}' },
  { value: 'none', label: '无编号', hint: '无编号前缀' },
] as const;

export type NumberingFormat = (typeof NUMBERING_FORMATS)[number]['value'];

export const HEADING_NUMBERING_STYLE_OPTIONS = [
  { value: 'classic', label: '经典章节' },
  { value: 'chinese', label: '中文序号' },
  { value: 'arabic', label: '阿拉伯数字' },
  { value: 'none', label: '无编号' },
] as const;

export type HeadingNumberingStyle = (typeof HEADING_NUMBERING_STYLE_OPTIONS)[number]['value'];

export const HEADING_NUMBERING_STYLE_PRESETS: Record<HeadingNumberingStyle, NumberingFormat[]> = {
  classic: ['chinese-chapter', 'chinese-section', 'chinese-dun', 'chinese-paren', 'arabic-dun', 'arabic-paren'],
  chinese: ['chinese-dun', 'chinese-paren', 'arabic-dun', 'arabic-paren', 'arabic', 'none'],
  arabic: ['arabic-dot', 'arabic-dot', 'arabic-dot', 'arabic-paren', 'arabic', 'none'],
  none: ['none', 'none', 'none', 'none', 'none', 'none'],
};

export const HEADING_BORDER_STRUCTURE_OPTIONS = [
  { value: '上下结构', label: '上下结构' },
  { value: '左右结构', label: '左右结构' },
] as const;

export type HeadingBorderStructure = (typeof HEADING_BORDER_STRUCTURE_OPTIONS)[number]['value'];

// ── 标题级别样式 ──────────────────────────────────
export interface HeadingStyleConfig {
  font: string;
  size: string;                 // 中文字号名，如 '小二'、'四号'
  alignment: string;            // '居中对齐' | '两端对齐' | '左对齐' | '右对齐'
  bold: boolean;
  text_color: string;
  spacing_before_pt: number;
  spacing_after_pt: number;
  first_line_indent_chars: number;
  line_spacing: number;         // 倍数，如 1、1.2、1.5
  numbering_format: NumberingFormat;
}

export interface HeadingBorderConfig {
  enabled: boolean;
  border_color: string;
  background_color: string;
  structure: HeadingBorderStructure;
}

// ── 正文样式 ──────────────────────────────────────
export interface BodyTextStyleConfig {
  font: string;
  size: string;
  alignment: string;
  spacing_before_pt: number;
  spacing_after_pt: number;
  first_line_indent_chars: number;
  line_spacing_multiple: number;
  list_style: ListStyle;
  list_indent_chars: number;
}

export interface TableCellStyleConfig {
  font: string;
  size: string;
  alignment: string;
  text_color: string;
  background_color: string;
}

export interface TableStyleConfig {
  border_width: number;
  border_color: string;
  cell_padding_pt: number;
  full_width: boolean;
  header_row: TableCellStyleConfig;
  first_column: TableCellStyleConfig;
  body_cell: TableCellStyleConfig;
}

export interface ImageStyleConfig {
  max_width_percent: number;
  alignment: string;
  caption_font: string;
  caption_size: string;
  caption_alignment: string;
}

// ── 纸张类型 ──────────────────────────────────────
export const PAPER_SIZES = [
  { value: 'a4', label: 'A4', detail: '210×297mm 国际标准公文纸' },
  { value: 'a3', label: 'A3', detail: '297×420mm 国际标准大页' },
  { value: 'a5', label: 'A5', detail: '148×210mm 国际标准小册' },
  { value: 'b4', label: 'B4', detail: '250×353mm JIS 标准' },
  { value: 'b5', label: 'B5', detail: '176×250mm JIS 标准' },
  { value: 'letter', label: 'Letter', detail: '215.9×279.4mm 美标信纸' },
  { value: 'legal', label: 'Legal', detail: '215.9×355.6mm 美标法律文书' },
  { value: '16k', label: '16开', detail: '184×260mm 中国常用开本' },
] as const;

export type PaperSize = (typeof PAPER_SIZES)[number]['value'];

/** 纸张尺寸 mm（portrait 模式 width × height） */
export const PAPER_DIMENSIONS: Record<PaperSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  b4: { width: 250, height: 353 },
  b5: { width: 176, height: 250 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  '16k': { width: 184, height: 260 },
};

// ── 页面设置 ──────────────────────────────────────
export interface PageSetupConfig {
  paper_size: PaperSize;
  orientation: 'portrait' | 'landscape';
  first_page_different: boolean;
  margin_top_cm: number;
  margin_bottom_cm: number;
  margin_left_cm: number;
  margin_right_cm: number;
  header_enabled: boolean;
  header_text: string;
  header_font: string;
  header_size: string;
  header_alignment: string;
  header_color: string;
  footer_enabled: boolean;
  footer_text: string;
  footer_distance_cm: number;
  footer_font: string;
  footer_size: string;
  footer_alignment: string;
  footer_color: string;
  page_number_enabled: boolean;
  page_number_format: string;   // '第{page}页'
  page_number_start: number;
}

// ── 完整导出格式配置 ──────────────────────────────
export interface ExportFormatConfig {
  template_name: string;
  page: PageSetupConfig;
  heading_numbering_style: HeadingNumberingStyle;
  heading_level1_page_break_before: boolean;
  heading_border: HeadingBorderConfig;
  headings: HeadingStyleConfig[];  // 索引 0=L1（章），5=L6
  body_text: BodyTextStyleConfig;
  table: TableStyleConfig;
  image: ImageStyleConfig;
}

export interface ExportTemplateRecord {
  template_id: string;
  template_name: string;
  config: ExportFormatConfig;
  created_at: string;
  updated_at: string;
}

// ── 选项常量 ──────────────────────────────────────

export const FONT_OPTIONS = [
  '宋体',
  '黑体',
  '楷体',
  '仿宋',
  '微软雅黑',
] as const;

export type FontOption = (typeof FONT_OPTIONS)[number];

export const SIZE_OPTIONS = [
  '初号',
  '小初',
  '一号',
  '小一',
  '二号',
  '小二',
  '三号',
  '小三',
  '四号',
  '小四',
  '五号',
  '小五',
  '六号',
  '小六',
] as const;

export type SizeOption = (typeof SIZE_OPTIONS)[number];

export const ALIGNMENT_OPTIONS = [
  '居中对齐',
  '两端对齐',
  '左对齐',
  '右对齐',
] as const;

export type AlignmentOption = (typeof ALIGNMENT_OPTIONS)[number];

export const LIST_STYLE_OPTIONS = [
  { value: 'disc', label: '实心圆点' },
  { value: 'dash', label: '短横线' },
  { value: 'circle', label: '空心圆点' },
  { value: 'square', label: '方块' },
] as const;

export type ListStyle = (typeof LIST_STYLE_OPTIONS)[number]['value'];

// ── 中文字号 → pt 映射 ────────────────────────────
export const SIZE_TO_PT: Record<string, number> = {
  '初号': 42,
  '小初': 36,
  '一号': 26,
  '小一': 24,
  '二号': 22,
  '小二': 18,
  '三号': 16,
  '小三': 15,
  '四号': 14,
  '小四': 12,
  '五号': 10.5,
  '小五': 9,
  '六号': 7.5,
  '小六': 6.5,
};

// ── 中文字体 → CSS font-family 映射 ───────────────
export const FONT_TO_CSS: Record<string, string> = {
  '宋体': "'SimSun', 'STSong', serif",
  '黑体': "'SimHei', 'STHeiti', sans-serif",
  '楷体': "'KaiTi', 'STKaiti', 'Kai', serif",
  '仿宋': "'FangSong', 'STFangsong', serif",
  '微软雅黑': "'Microsoft YaHei', sans-serif",
};

// ── 对齐方式 → CSS text-align 映射 ────────────────
export const ALIGNMENT_TO_CSS: Record<string, string> = {
  '居中对齐': 'center',
  '两端对齐': 'justify',
  '左对齐': 'left',
  '右对齐': 'right',
};

// ── 默认值 ────────────────────────────────────────

const DEFAULT_PAGE_SETUP: PageSetupConfig = {
  paper_size: 'a4',
  orientation: 'portrait',
  first_page_different: true,
  margin_top_cm: 2,
  margin_bottom_cm: 2,
  margin_left_cm: 2,
  margin_right_cm: 2,
  header_enabled: false,
  header_text: '',
  header_font: '宋体',
  header_size: '小五',
  header_alignment: '居中对齐',
  header_color: '#536176',
  footer_enabled: true,
  footer_text: '',
  footer_distance_cm: 1.75,
  footer_font: '宋体',
  footer_size: '小五',
  footer_alignment: '居中对齐',
  footer_color: '#536176',
  page_number_enabled: true,
  page_number_format: '第{page}页',
  page_number_start: 1,
};

const DEFAULT_BODY_TEXT: BodyTextStyleConfig = {
  font: '宋体',
  size: '小四',
  alignment: '两端对齐',
  spacing_before_pt: 0,
  spacing_after_pt: 0,
  first_line_indent_chars: 2,
  line_spacing_multiple: 1.2,
  list_style: 'disc',
  list_indent_chars: 2,
};

const DEFAULT_TABLE_CELL: TableCellStyleConfig = {
  font: '宋体',
  size: '小四',
  alignment: '左对齐',
  text_color: '#243048',
  background_color: '#ffffff',
};

const DEFAULT_TABLE_STYLE: TableStyleConfig = {
  border_width: 1,
  border_color: '#dcdff6',
  cell_padding_pt: 6,
  full_width: true,
  header_row: {
    font: '黑体',
    size: '小四',
    alignment: '居中对齐',
    text_color: '#243048',
    background_color: '#eef5ff',
  },
  first_column: {
    font: '黑体',
    size: '小四',
    alignment: '左对齐',
    text_color: '#243048',
    background_color: '#f8fbff',
  },
  body_cell: { ...DEFAULT_TABLE_CELL },
};

const DEFAULT_IMAGE_STYLE: ImageStyleConfig = {
  max_width_percent: 90,
  alignment: '居中对齐',
  caption_font: '宋体',
  caption_size: '小五',
  caption_alignment: '居中对齐',
};

const DEFAULT_HEADING_BORDER: HeadingBorderConfig = {
  enabled: false,
  border_color: '#2174fd',
  background_color: '#eef5ff',
  structure: '上下结构',
};

/** 默认导出格式：6 级标题独立编号 */
export const DEFAULT_EXPORT_FORMAT: ExportFormatConfig = {
  template_name: '默认模版',
  page: { ...DEFAULT_PAGE_SETUP },
  heading_numbering_style: 'classic',
  heading_level1_page_break_before: false,
  heading_border: { ...DEFAULT_HEADING_BORDER },
  headings: [
    // L1: 第一章 — 黑体 小二 居中
    { font: '黑体', size: '小二', alignment: '居中对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'chinese-chapter' },
    // L2: 第一节 — 黑体 四号 两端对齐
    { font: '黑体', size: '四号', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 1.5, line_spacing: 1, numbering_format: 'chinese-section' },
    // L3: 一、 — 黑体 小四 两端对齐
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'chinese-dun' },
    // L4: （一） — 楷体 小四
    { font: '楷体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'chinese-paren' },
    // L5: 1、 — 黑体 小四
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'arabic-dun' },
    // L6: (1) — 宋体 小四
    { font: '宋体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'arabic-paren' },
  ],
  body_text: { ...DEFAULT_BODY_TEXT },
  table: {
    border_width: DEFAULT_TABLE_STYLE.border_width,
    border_color: DEFAULT_TABLE_STYLE.border_color,
    cell_padding_pt: DEFAULT_TABLE_STYLE.cell_padding_pt,
    full_width: DEFAULT_TABLE_STYLE.full_width,
    header_row: { ...DEFAULT_TABLE_STYLE.header_row },
    first_column: { ...DEFAULT_TABLE_STYLE.first_column },
    body_cell: { ...DEFAULT_TABLE_STYLE.body_cell },
  },
  image: { ...DEFAULT_IMAGE_STYLE },
};

/** 标题级别中文标签 */
export const HEADING_LEVEL_LABELS = [
  '一级标题',
  '二级标题',
  '三级标题',
  '四级标题',
  '五级标题',
  '六级标题',
];
