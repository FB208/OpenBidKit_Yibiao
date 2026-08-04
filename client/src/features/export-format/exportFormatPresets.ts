import type {
  BodyTextStyleConfig,
  ExportFormatConfig,
  HeadingStyleConfig,
  ImageStyleConfig,
  PageSetupConfig,
  TableCellStyleConfig,
  TableStyleConfig,
} from '../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../shared/types/exportFormat';

type HeadingLayoutStyle = Omit<HeadingStyleConfig, 'text_color'>;
type TableCellLayoutStyle = Pick<TableCellStyleConfig, 'font' | 'size' | 'alignment'>;

type LayoutPageSettings = Pick<
  PageSetupConfig,
  | 'paper_size'
  | 'orientation'
  | 'first_page_different'
  | 'margin_top_cm'
  | 'margin_bottom_cm'
  | 'margin_left_cm'
  | 'margin_right_cm'
  | 'page_number_enabled'
  | 'page_number_format'
  | 'page_number_start'
>;

interface ExportLayoutPreset {
  id: string;
  label: string;
  description: string;
  page: LayoutPageSettings;
  heading_level1_page_break_before: boolean;
  heading_border_enabled: boolean;
  heading_border_min_heading_left_enabled: boolean;
  headings: HeadingLayoutStyle[];
  body_text: BodyTextStyleConfig;
  table: Pick<TableStyleConfig, 'border_width' | 'cell_padding_pt' | 'full_width'> & {
    header_row: TableCellLayoutStyle;
    first_column: TableCellLayoutStyle;
    body_cell: TableCellLayoutStyle;
  };
  image: ImageStyleConfig;
}

interface ExportThemePreset {
  id: string;
  label: string;
  description: string;
  swatches: string[];
  heading_text_color: string;
  heading_border_color: string;
  heading_border_cell_colors: string[];
  header_footer_color: string;
  table_border_color: string;
  table_header_text_color: string;
  table_header_background_color: string;
  table_first_column_text_color: string;
  table_first_column_background_color: string;
  table_body_text_color: string;
  table_body_background_color: string;
}

const BID_HEADING_NUMBERING: Array<Pick<HeadingStyleConfig, 'numbering_format' | 'numbering_template'>> = [
  { numbering_format: 'custom', numbering_template: '第{zh}章' },
  { numbering_format: 'custom', numbering_template: '第{zh}节' },
  { numbering_format: 'custom', numbering_template: '{tail}' },
  { numbering_format: 'custom', numbering_template: '{tail}' },
  { numbering_format: 'custom', numbering_template: '{tail}' },
  { numbering_format: 'custom', numbering_template: '{tail}' },
];

function heading(
  font: string,
  size: string,
  alignment: string,
  bold: boolean,
  spacingBefore: number,
  spacingAfter: number,
  lineSpacing = 1,
): HeadingLayoutStyle {
  return {
    font,
    size,
    alignment,
    bold,
    spacing_before_pt: spacingBefore,
    spacing_after_pt: spacingAfter,
    first_line_indent_chars: 0,
    line_spacing: lineSpacing,
    numbering_format: 'outline-decimal',
    numbering_template: '',
  };
}

export const EXPORT_LAYOUT_PRESETS: ExportLayoutPreset[] = [
  {
    id: 'standard-bid',
    label: '标准投标版',
    description: 'A4 纵向、常规边距、小四正文，适合大多数技术方案。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: false,
      margin_top_cm: 2,
      margin_bottom_cm: 2,
      margin_left_cm: 2,
      margin_right_cm: 2,
      page_number_enabled: false,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: false,
    heading_border_enabled: false,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('黑体', '小二', '居中对齐', false, 10, 10),
      heading('黑体', '四号', '两端对齐', false, 10, 10),
      heading('黑体', '小四', '两端对齐', false, 10, 10),
      heading('楷体', '小四', '两端对齐', false, 5, 5),
      heading('黑体', '小四', '两端对齐', false, 5, 5),
      heading('宋体', '小四', '两端对齐', false, 0, 0),
    ],
    body_text: {
      font: '宋体',
      size: '小四',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 0,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.2,
      list_style: 'disc',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 2,
    },
    table: {
      border_width: 1,
      cell_padding_pt: 6,
      full_width: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 90,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
  {
    id: 'formal-binding',
    label: '正式装订版',
    description: '左侧留装订空间、一级标题另起页，适合打印装订文档。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: true,
      margin_top_cm: 2.4,
      margin_bottom_cm: 2.2,
      margin_left_cm: 2.8,
      margin_right_cm: 2,
      page_number_enabled: true,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: true,
    heading_border_enabled: false,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('黑体', '二号', '居中对齐', true, 18, 14, 1.1),
      heading('黑体', '三号', '左对齐', true, 14, 10, 1.1),
      heading('黑体', '小三', '左对齐', true, 12, 8, 1.1),
      heading('楷体', '四号', '左对齐', false, 8, 6, 1.15),
      heading('黑体', '小四', '左对齐', false, 6, 4, 1.15),
      heading('宋体', '小四', '左对齐', false, 4, 2, 1.15),
    ],
    body_text: {
      font: '仿宋',
      size: '小四',
      alignment: '两端对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 6,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.5,
      list_style: 'disc',
      ordered_list_style: 'chinese-dot',
      list_indent_chars: 2.5,
    },
    table: {
      border_width: 1,
      cell_padding_pt: 7,
      full_width: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐' },
      first_column: { font: '黑体', size: '小四', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 88,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
  {
    id: 'compact-review',
    label: '紧凑评审版',
    description: '更小边距和字号，适合内容较多、需要控制页数的文档。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: false,
      margin_top_cm: 1.5,
      margin_bottom_cm: 1.5,
      margin_left_cm: 1.6,
      margin_right_cm: 1.6,
      page_number_enabled: true,
      page_number_format: '{page}',
      page_number_start: 1,
    },
    heading_level1_page_break_before: false,
    heading_border_enabled: false,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('黑体', '三号', '左对齐', true, 8, 6, 1),
      heading('黑体', '小三', '左对齐', true, 7, 5, 1),
      heading('黑体', '四号', '左对齐', false, 6, 4, 1),
      heading('楷体', '小四', '左对齐', false, 4, 3, 1),
      heading('黑体', '小四', '左对齐', false, 3, 2, 1),
      heading('宋体', '五号', '左对齐', false, 2, 1, 1),
    ],
    body_text: {
      font: '宋体',
      size: '五号',
      alignment: '两端对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 2,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.15,
      list_style: 'dash',
      ordered_list_style: 'decimal-paren',
      list_indent_chars: 1.5,
    },
    table: {
      border_width: 0.75,
      cell_padding_pt: 4,
      full_width: true,
      header_row: { font: '黑体', size: '五号', alignment: '居中对齐' },
      first_column: { font: '宋体', size: '五号', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '五号', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 82,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '六号',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
  {
    id: 'wide-table-landscape',
    label: '宽表格横版',
    description: 'A4 横向、紧凑表格，适合设备清单、进度表等宽表内容。',
    page: {
      paper_size: 'a4',
      orientation: 'landscape',
      first_page_different: false,
      margin_top_cm: 1.4,
      margin_bottom_cm: 1.4,
      margin_left_cm: 1.5,
      margin_right_cm: 1.5,
      page_number_enabled: true,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: false,
    heading_border_enabled: false,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('黑体', '三号', '居中对齐', true, 8, 6, 1),
      heading('黑体', '小三', '左对齐', true, 6, 4, 1),
      heading('黑体', '四号', '左对齐', false, 5, 3, 1),
      heading('楷体', '小四', '左对齐', false, 4, 2, 1),
      heading('黑体', '小四', '左对齐', false, 3, 2, 1),
      heading('宋体', '五号', '左对齐', false, 2, 1, 1),
    ],
    body_text: {
      font: '宋体',
      size: '五号',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 2,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.15,
      list_style: 'square',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 1.5,
    },
    table: {
      border_width: 0.75,
      cell_padding_pt: 4,
      full_width: true,
      header_row: { font: '黑体', size: '五号', alignment: '居中对齐' },
      first_column: { font: '黑体', size: '五号', alignment: '居中对齐' },
      body_cell: { font: '宋体', size: '五号', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 76,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '六号',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
  {
    id: 'visual-report',
    label: '图文展示版',
    description: '图片占比更高、标题更清晰，适合流程图和架构图较多的方案。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: true,
      margin_top_cm: 1.8,
      margin_bottom_cm: 1.8,
      margin_left_cm: 1.8,
      margin_right_cm: 1.8,
      page_number_enabled: true,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: true,
    heading_border_enabled: false,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('微软雅黑', '小二', '居中对齐', true, 14, 12, 1.1),
      heading('微软雅黑', '三号', '左对齐', true, 12, 8, 1.1),
      heading('微软雅黑', '小三', '左对齐', true, 10, 6, 1.1),
      heading('楷体', '四号', '左对齐', false, 8, 5, 1.15),
      heading('黑体', '小四', '左对齐', false, 6, 4, 1.15),
      heading('宋体', '小四', '左对齐', false, 4, 2, 1.15),
    ],
    body_text: {
      font: '宋体',
      size: '小四',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 6,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.35,
      list_style: 'arrow',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 2,
    },
    table: {
      border_width: 1,
      cell_padding_pt: 7,
      full_width: true,
      header_row: { font: '微软雅黑', size: '小四', alignment: '居中对齐' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 100,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: true,
      caption_italic: false,
    },
  },
  {
    id: 'chapter-frame',
    label: '章节页框版',
    description: '启用章节页框，适合强调章节结构的正式方案。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: true,
      margin_top_cm: 2,
      margin_bottom_cm: 2,
      margin_left_cm: 2,
      margin_right_cm: 2,
      page_number_enabled: true,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: true,
    heading_border_enabled: true,
    heading_border_min_heading_left_enabled: false,
    headings: [
      heading('黑体', '小二', '居中对齐', true, 0, 0, 1),
      heading('黑体', '四号', '左对齐', true, 0, 0, 1),
      heading('黑体', '小四', '左对齐', false, 0, 0, 1),
      heading('楷体', '小四', '左对齐', false, 0, 0, 1),
      heading('黑体', '小四', '左对齐', false, 0, 0, 1),
      heading('宋体', '小四', '左对齐', false, 0, 0, 1),
    ],
    body_text: {
      font: '宋体',
      size: '小四',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 4,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.25,
      list_style: 'disc',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 2,
    },
    table: {
      border_width: 1,
      cell_padding_pt: 6,
      full_width: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 90,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
  {
    id: 'left-title-frame',
    label: '左题栏页框版',
    description: '启用章节页框，最小标题固定在正文左侧，适合条目化响应内容。',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: true,
      margin_top_cm: 2,
      margin_bottom_cm: 2,
      margin_left_cm: 2,
      margin_right_cm: 2,
      page_number_enabled: true,
      page_number_format: '第{page}页',
      page_number_start: 1,
    },
    heading_level1_page_break_before: true,
    heading_border_enabled: true,
    heading_border_min_heading_left_enabled: true,
    headings: [
      heading('黑体', '小二', '居中对齐', true, 0, 0, 1),
      heading('黑体', '四号', '左对齐', true, 0, 0, 1),
      heading('黑体', '小四', '左对齐', false, 0, 0, 1),
      heading('楷体', '小四', '左对齐', false, 0, 0, 1),
      heading('黑体', '小四', '左对齐', false, 0, 0, 1),
      heading('宋体', '小四', '左对齐', false, 0, 0, 1),
    ],
    body_text: {
      font: '宋体',
      size: '小四',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 4,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.25,
      list_style: 'disc',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 2,
    },
    table: {
      border_width: 1,
      cell_padding_pt: 6,
      full_width: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐' },
    },
    image: {
      max_width_percent: 90,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  },
];

export const EXPORT_THEME_PRESETS: ExportThemePreset[] = [
  {
    id: 'none',
    label: '无',
    description: '黑字、黑边框、白底，无额外主题背景色。',
    swatches: ['#000000', '#ffffff'],
    heading_text_color: '#000000',
    heading_border_color: '#000000',
    heading_border_cell_colors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    header_footer_color: '#000000',
    table_border_color: '#000000',
    table_header_text_color: '#000000',
    table_header_background_color: '#ffffff',
    table_first_column_text_color: '#000000',
    table_first_column_background_color: '#ffffff',
    table_body_text_color: '#000000',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'blue',
    label: '蓝色',
    description: '深蓝标题与蓝色表头，适合正式科技类方案。',
    swatches: ['#173f82', '#2174fd', '#dbeafe'],
    heading_text_color: '#173f82',
    heading_border_color: '#2174fd',
    heading_border_cell_colors: ['#dbeafe', '#e8f1ff', '#f1f7ff', '#f6faff', '#ffffff', '#ffffff'],
    header_footer_color: '#315b9f',
    table_border_color: '#8db8ff',
    table_header_text_color: '#123a78',
    table_header_background_color: '#dbeafe',
    table_first_column_text_color: '#173f82',
    table_first_column_background_color: '#eef5ff',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'light-blue',
    label: '淡蓝',
    description: '低饱和蓝灰色，适合长文档和轻量商务风。',
    swatches: ['#2f6f92', '#a9d7f2', '#f3fbff'],
    heading_text_color: '#2f6f92',
    heading_border_color: '#a9d7f2',
    heading_border_cell_colors: ['#eaf7ff', '#f2fbff', '#f7fdff', '#fbfeff', '#ffffff', '#ffffff'],
    header_footer_color: '#55798f',
    table_border_color: '#bddded',
    table_header_text_color: '#245f82',
    table_header_background_color: '#eaf7ff',
    table_first_column_text_color: '#2f6f92',
    table_first_column_background_color: '#f4fbff',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'green',
    label: '绿色',
    description: '稳重绿色，适合运维、环保、政企服务类方案。',
    swatches: ['#116a3a', '#22a05a', '#dcfce7'],
    heading_text_color: '#116a3a',
    heading_border_color: '#22a05a',
    heading_border_cell_colors: ['#dcfce7', '#e9fbed', '#f1fcf4', '#f7fdf8', '#ffffff', '#ffffff'],
    header_footer_color: '#2e7449',
    table_border_color: '#8fd3a6',
    table_header_text_color: '#0f5a32',
    table_header_background_color: '#dcfce7',
    table_first_column_text_color: '#116a3a',
    table_first_column_background_color: '#effaf2',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'light-green',
    label: '淡绿',
    description: '清爽淡绿，适合报告型和服务保障型文档。',
    swatches: ['#3d764b', '#a7dcb3', '#f2fbf4'],
    heading_text_color: '#3d764b',
    heading_border_color: '#a7dcb3',
    heading_border_cell_colors: ['#eaf8ee', '#f2fbf4', '#f7fdf8', '#fbfefc', '#ffffff', '#ffffff'],
    header_footer_color: '#5f8468',
    table_border_color: '#bfdfc5',
    table_header_text_color: '#356a43',
    table_header_background_color: '#eaf8ee',
    table_first_column_text_color: '#3d764b',
    table_first_column_background_color: '#f5fbf6',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'orange',
    label: '橙色',
    description: '暖橙强调重点，适合交付计划和服务承诺类内容。',
    swatches: ['#8a4b10', '#f59e0b', '#fff3d6'],
    heading_text_color: '#8a4b10',
    heading_border_color: '#f59e0b',
    heading_border_cell_colors: ['#fff3d6', '#fff7e6', '#fffaf0', '#fffdf8', '#ffffff', '#ffffff'],
    header_footer_color: '#9b6123',
    table_border_color: '#f2c46f',
    table_header_text_color: '#79420e',
    table_header_background_color: '#fff3d6',
    table_first_column_text_color: '#8a4b10',
    table_first_column_background_color: '#fff8e8',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
  {
    id: 'light-purple',
    label: '淡紫',
    description: '柔和紫色，适合创新、平台、数据治理类方案。',
    swatches: ['#5b3ca6', '#a78bfa', '#f2edff'],
    heading_text_color: '#5b3ca6',
    heading_border_color: '#a78bfa',
    heading_border_cell_colors: ['#f2edff', '#f6f2ff', '#faf7ff', '#fdfbff', '#ffffff', '#ffffff'],
    header_footer_color: '#7054aa',
    table_border_color: '#c9b8ff',
    table_header_text_color: '#553798',
    table_header_background_color: '#f2edff',
    table_first_column_text_color: '#5b3ca6',
    table_first_column_background_color: '#f8f5ff',
    table_body_text_color: '#243048',
    table_body_background_color: '#ffffff',
  },
];

function mergeLayoutTableCell(current: TableCellStyleConfig, preset: TableCellLayoutStyle): TableCellStyleConfig {
  return {
    ...current,
    ...preset,
    text_color: current.text_color,
    background_color: current.background_color,
  };
}

function normalizeColor(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isThemeColor(value: string | undefined, colors: Array<string | undefined>): boolean {
  const normalized = normalizeColor(value);
  return normalized ? colors.some((color) => normalizeColor(color) === normalized) : false;
}

function clearDisabledFrameThemeColors(config: ExportFormatConfig): ExportFormatConfig {
  const headingThemeColors = EXPORT_THEME_PRESETS.map((preset) => preset.heading_text_color);
  const headerFooterThemeColors = EXPORT_THEME_PRESETS.map((preset) => preset.header_footer_color);
  const frameBorderThemeColors = EXPORT_THEME_PRESETS.map((preset) => preset.heading_border_color);

  return {
    ...config,
    page: {
      ...config.page,
      header_color: isThemeColor(config.page.header_color, headerFooterThemeColors) ? DEFAULT_EXPORT_FORMAT.page.header_color : config.page.header_color,
      footer_color: isThemeColor(config.page.footer_color, headerFooterThemeColors) ? DEFAULT_EXPORT_FORMAT.page.footer_color : config.page.footer_color,
    },
    heading_border: {
      ...config.heading_border,
      border_color: isThemeColor(config.heading_border.border_color, frameBorderThemeColors) ? DEFAULT_EXPORT_FORMAT.heading_border.border_color : config.heading_border.border_color,
      level_cell_colors: DEFAULT_EXPORT_FORMAT.heading_border.level_cell_colors.map((defaultColor, index) => {
        const currentColor = config.heading_border.level_cell_colors[index] || defaultColor;
        const themeColors = EXPORT_THEME_PRESETS.map((preset) => preset.heading_border_cell_colors[index]);
        return isThemeColor(currentColor, themeColors) ? defaultColor : currentColor;
      }),
    },
    headings: config.headings.map((headingConfig, index) => {
      const defaultHeading = DEFAULT_EXPORT_FORMAT.headings[index];
      return {
        ...headingConfig,
        text_color: isThemeColor(headingConfig.text_color, headingThemeColors) ? (defaultHeading?.text_color || headingConfig.text_color) : headingConfig.text_color,
      };
    }),
  };
}

export function applyExportLayoutPreset(config: ExportFormatConfig, presetId: string): ExportFormatConfig {
  const preset = EXPORT_LAYOUT_PRESETS.find((item) => item.id === presetId);
  if (!preset) return config;

  return {
    ...config,
    page: {
      ...config.page,
      ...preset.page,
    },
    heading_level1_page_break_before: preset.heading_level1_page_break_before,
    heading_border: {
      ...config.heading_border,
      enabled: preset.heading_border_enabled,
      min_heading_left_enabled: preset.heading_border_min_heading_left_enabled,
    },
    headings: config.headings.map((current, index) => ({
      ...current,
      ...(preset.headings[index] || {}),
      ...(BID_HEADING_NUMBERING[index] || BID_HEADING_NUMBERING[BID_HEADING_NUMBERING.length - 1]),
      text_color: current.text_color,
    })),
    body_text: {
      ...config.body_text,
      ...preset.body_text,
    },
    table: {
      ...config.table,
      border_width: preset.table.border_width,
      cell_padding_pt: preset.table.cell_padding_pt,
      full_width: preset.table.full_width,
      header_row: mergeLayoutTableCell(config.table.header_row, preset.table.header_row),
      first_column: mergeLayoutTableCell(config.table.first_column, preset.table.first_column),
      body_cell: mergeLayoutTableCell(config.table.body_cell, preset.table.body_cell),
    },
    image: {
      ...config.image,
      ...preset.image,
    },
  };
}

export function applyExportThemePreset(config: ExportFormatConfig, presetId: string): ExportFormatConfig {
  const preset = EXPORT_THEME_PRESETS.find((item) => item.id === presetId);
  if (!preset) return config;
  const table = {
    ...config.table,
    border_color: preset.table_border_color,
    header_row: {
      ...config.table.header_row,
      text_color: preset.table_header_text_color,
      background_color: preset.table_header_background_color,
    },
    first_column: {
      ...config.table.first_column,
      text_color: preset.table_first_column_text_color,
      background_color: preset.table_first_column_background_color,
    },
    body_cell: {
      ...config.table.body_cell,
      text_color: preset.table_body_text_color,
      background_color: preset.table_body_background_color,
    },
  };

  if (!config.heading_border.enabled) {
    const withoutGlobalThemeColors = clearDisabledFrameThemeColors(config);
    return {
      ...withoutGlobalThemeColors,
      table,
    };
  }

  return {
    ...config,
    page: {
      ...config.page,
      header_color: preset.header_footer_color,
      footer_color: preset.header_footer_color,
    },
    heading_border: {
      ...config.heading_border,
      border_color: preset.heading_border_color,
      level_cell_colors: config.heading_border.level_cell_colors.map((color, index) => preset.heading_border_cell_colors[index] || color),
    },
    headings: config.headings.map((headingConfig) => ({
      ...headingConfig,
      text_color: preset.heading_text_color,
    })),
    table,
  };
}
