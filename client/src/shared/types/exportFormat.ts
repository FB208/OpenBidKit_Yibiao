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

// ── 标题级别样式 ──────────────────────────────────
export interface HeadingStyleConfig {
  font: string;
  size: string;                 // 中文字号名，如 '小二'、'四号'
  alignment: string;            // '居中对齐' | '两端对齐' | '左对齐' | '右对齐'
  spacing_before_pt: number;
  spacing_after_pt: number;
  first_line_indent_chars: number;
  line_spacing: number;         // 倍数，如 1、1.2、1.5
  numbering_format: NumberingFormat;
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
  margin_top_cm: number;
  margin_bottom_cm: number;
  margin_left_cm: number;
  margin_right_cm: number;
  footer_enabled: boolean;
  footer_distance_cm: number;
  footer_font: string;
  footer_size: string;
  page_number_enabled: boolean;
  page_number_format: string;   // '第{page}页'
  header_enabled: boolean;
}

// ── 完整导出格式配置 ──────────────────────────────
export interface ExportFormatConfig {
  page: PageSetupConfig;
  headings: HeadingStyleConfig[];  // 索引 0=L1（章），5=L6
  body_text: BodyTextStyleConfig;
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
  margin_top_cm: 2,
  margin_bottom_cm: 2,
  margin_left_cm: 2,
  margin_right_cm: 2,
  footer_enabled: true,
  footer_distance_cm: 1.75,
  footer_font: '宋体',
  footer_size: '小五',
  page_number_enabled: true,
  page_number_format: '第{page}页',
  header_enabled: false,
};

const DEFAULT_BODY_TEXT: BodyTextStyleConfig = {
  font: '宋体',
  size: '小四',
  alignment: '两端对齐',
  spacing_before_pt: 0,
  spacing_after_pt: 0,
  first_line_indent_chars: 2,
  line_spacing_multiple: 1.2,
};

/** 默认导出格式：6 级标题独立编号 */
export const DEFAULT_EXPORT_FORMAT: ExportFormatConfig = {
  page: { ...DEFAULT_PAGE_SETUP },
  headings: [
    // L1: 第一章 — 黑体 小二 居中
    { font: '黑体', size: '小二', alignment: '居中对齐', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'chinese-chapter' },
    // L2: 第一节 — 黑体 四号 两端对齐
    { font: '黑体', size: '四号', alignment: '两端对齐', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 1.5, line_spacing: 1, numbering_format: 'chinese-section' },
    // L3: 一、 — 黑体 小四 两端对齐
    { font: '黑体', size: '小四', alignment: '两端对齐', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'chinese-dun' },
    // L4: （一） — 楷体 小四
    { font: '楷体', size: '小四', alignment: '两端对齐', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'chinese-paren' },
    // L5: 1、 — 黑体 小四
    { font: '黑体', size: '小四', alignment: '两端对齐', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'arabic-dun' },
    // L6: (1) — 宋体 小四
    { font: '宋体', size: '小四', alignment: '两端对齐', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'arabic-paren' },
  ],
  body_text: { ...DEFAULT_BODY_TEXT },
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
