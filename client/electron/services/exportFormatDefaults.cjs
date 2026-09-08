/**
 * 导出格式（模板 config）的默认值与归一化。
 *
 * 从 configStore.cjs 抽出：user_config.json 里的全局 export_format 和
 * export_templates 表里的系统预设模板共用同一份基线，避免出现多份默认配置副本。
 */

const DEFAULT_HEADING_BORDER_CELL_COLORS = ['#eef5ff', '#f3f7ff', '#f8fbff', '#fbfdff', '#ffffff', '#ffffff'];

const defaultExportFormat = {
  template_name: '默认模版',
  page: {
    paper_size: 'a4',
    orientation: 'portrait',
    two_column: false,
    first_page_different: false,
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
    header_footer_style: 'plain',
    header_badge_text: '',
    chrome_bar_color: '#e8eef5',
    chrome_accent_color: '#536176',
    footer_enabled: false,
    footer_text: '',
    footer_distance_cm: 0,
    footer_font: '宋体',
    footer_size: '小五',
    footer_alignment: '居中对齐',
    footer_color: '#536176',
    page_number_enabled: false,
    page_number_format: '第{page}页',
    page_number_start: 1,
    page_number_pad: 0,
  },
  heading_level1_page_break_before: false,
  heading_border: {
    enabled: false,
    min_heading_left_enabled: false,
    border_color: '#cfd8ee',
    level_cell_colors: [...DEFAULT_HEADING_BORDER_CELL_COLORS],
    structure: '上下结构',
  },
  headings: [
    { font: '黑体', size: '小二', alignment: '居中对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}章' },
    { font: '黑体', size: '四号', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}节' },
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
    { font: '楷体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
    { font: '宋体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
  ],
  body_text: {
    font: '宋体',
    size: '小四',
    alignment: '左对齐',
    spacing_before: 0,
    spacing_before_unit: 'lines',
    spacing_after: 0,
    spacing_after_unit: 'lines',
    first_line_indent_chars: 2,
    line_spacing_mode: 'multiple',
    line_spacing_value: 1.2,
    list_style: 'disc',
    ordered_list_style: 'decimal-dot',
    list_indent_chars: 2,
  },
  table: {
    border_width: 1,
    border_color: '#dcdff6',
    cell_padding_pt: 6,
    full_width: true,
    caption_font: '宋体',
    caption_size: '小四',
    caption_alignment: '居中对齐',
    caption_bold: true,
    caption_italic: false,
    header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#eef5ff' },
    first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
    body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
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
};

const VALID_NUMBERING_FORMATS = ['outline-decimal', 'custom'];
const VALID_HEADING_BORDER_STRUCTURES = ['上下结构', '左右结构'];
const VALID_HEADER_FOOTER_STYLES = ['plain', 'band', 'rules', 'top-bar', 'footer-badge', 'slant', 'letterhead', 'frame'];
const VALID_PAGE_NUMBER_PADS = [0, 2, 3];
const VALID_LIST_STYLES = ['none', 'disc', 'circle', 'square', 'diamond', 'dash', 'check', 'arrow', 'sparkle'];
const VALID_ORDERED_LIST_STYLES = ['decimal-dot', 'decimal-paren', 'decimal-full-paren', 'chinese-dot', 'chinese-paren', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'];

function cloneDefaultExportFormat(def = defaultExportFormat) {
  return {
    template_name: def.template_name,
    page: { ...def.page },
    heading_level1_page_break_before: def.heading_level1_page_break_before,
    heading_border: {
      ...def.heading_border,
      level_cell_colors: [...(def.heading_border.level_cell_colors || DEFAULT_HEADING_BORDER_CELL_COLORS)],
    },
    headings: def.headings.map((heading) => ({ ...heading })),
    body_text: { ...def.body_text },
    table: {
      border_width: def.table.border_width,
      border_color: def.table.border_color,
      cell_padding_pt: def.table.cell_padding_pt,
      full_width: def.table.full_width,
      caption_font: def.table.caption_font,
      caption_size: def.table.caption_size,
      caption_alignment: def.table.caption_alignment,
      caption_bold: def.table.caption_bold,
      caption_italic: def.table.caption_italic,
      header_row: { ...def.table.header_row },
      first_column: { ...def.table.first_column },
      body_cell: { ...def.table.body_cell },
    },
    image: { ...def.image },
  };
}

function normalizeTableCellStyle(source, def) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    font: typeof src.font === 'string' && src.font ? src.font : def.font,
    size: typeof src.size === 'string' && src.size ? src.size : def.size,
    alignment: typeof src.alignment === 'string' && src.alignment ? src.alignment : def.alignment,
    text_color: typeof src.text_color === 'string' && src.text_color ? src.text_color : def.text_color,
    background_color: typeof src.background_color === 'string' && src.background_color ? src.background_color : def.background_color,
  };
}

function normalizeImageStyle(source, def) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    max_width_percent: typeof src.max_width_percent === 'number' ? src.max_width_percent : def.max_width_percent,
    alignment: typeof src.alignment === 'string' && src.alignment ? src.alignment : def.alignment,
    caption_font: typeof src.caption_font === 'string' && src.caption_font ? src.caption_font : def.caption_font,
    caption_size: typeof src.caption_size === 'string' && src.caption_size ? src.caption_size : def.caption_size,
    caption_alignment: typeof src.caption_alignment === 'string' && src.caption_alignment ? src.caption_alignment : def.caption_alignment,
    caption_bold: typeof src.caption_bold === 'boolean' ? src.caption_bold : def.caption_bold,
    caption_italic: typeof src.caption_italic === 'boolean' ? src.caption_italic : def.caption_italic,
  };
}

function normalizeExportFormat(source) {
  const def = defaultExportFormat;
  if (!source || typeof source !== 'object') return cloneDefaultExportFormat(def);

  const srcPage = source.page && typeof source.page === 'object' ? source.page : {};
  const page = {
    paper_size: ['a4','a3','a5','b4','b5','letter','legal','16k'].includes(srcPage.paper_size) ? srcPage.paper_size : def.page.paper_size,
    orientation: ['portrait', 'landscape'].includes(srcPage.orientation) ? srcPage.orientation : def.page.orientation,
    two_column: typeof srcPage.two_column === 'boolean' ? srcPage.two_column : def.page.two_column,
    first_page_different: typeof srcPage.first_page_different === 'boolean' ? srcPage.first_page_different : def.page.first_page_different,
    margin_top_cm: typeof srcPage.margin_top_cm === 'number' ? srcPage.margin_top_cm : def.page.margin_top_cm,
    margin_bottom_cm: typeof srcPage.margin_bottom_cm === 'number' ? srcPage.margin_bottom_cm : def.page.margin_bottom_cm,
    margin_left_cm: typeof srcPage.margin_left_cm === 'number' ? srcPage.margin_left_cm : def.page.margin_left_cm,
    margin_right_cm: typeof srcPage.margin_right_cm === 'number' ? srcPage.margin_right_cm : def.page.margin_right_cm,
    header_enabled: typeof srcPage.header_enabled === 'boolean' ? srcPage.header_enabled : def.page.header_enabled,
    header_text: typeof srcPage.header_text === 'string' ? srcPage.header_text : def.page.header_text,
    header_font: typeof srcPage.header_font === 'string' && srcPage.header_font ? srcPage.header_font : def.page.header_font,
    header_size: typeof srcPage.header_size === 'string' && srcPage.header_size ? srcPage.header_size : def.page.header_size,
    header_alignment: typeof srcPage.header_alignment === 'string' && srcPage.header_alignment ? srcPage.header_alignment : def.page.header_alignment,
    header_color: typeof srcPage.header_color === 'string' && srcPage.header_color ? srcPage.header_color : def.page.header_color,
    header_footer_style: (() => {
      let style = srcPage.header_footer_style;
      if (style === 'spine') style = 'letterhead';
      if (style === 'seal') style = 'frame';
      return VALID_HEADER_FOOTER_STYLES.includes(style) ? style : def.page.header_footer_style;
    })(),
    header_badge_text: typeof srcPage.header_badge_text === 'string' ? srcPage.header_badge_text.slice(0, 4) : def.page.header_badge_text,
    chrome_bar_color: typeof srcPage.chrome_bar_color === 'string' && srcPage.chrome_bar_color ? srcPage.chrome_bar_color : def.page.chrome_bar_color,
    chrome_accent_color: typeof srcPage.chrome_accent_color === 'string' && srcPage.chrome_accent_color ? srcPage.chrome_accent_color : def.page.chrome_accent_color,
    footer_enabled: typeof srcPage.footer_enabled === 'boolean' ? srcPage.footer_enabled : def.page.footer_enabled,
    footer_text: typeof srcPage.footer_text === 'string' ? srcPage.footer_text : def.page.footer_text,
    footer_distance_cm: typeof srcPage.footer_distance_cm === 'number' ? srcPage.footer_distance_cm : def.page.footer_distance_cm,
    footer_font: typeof srcPage.footer_font === 'string' && srcPage.footer_font ? srcPage.footer_font : def.page.footer_font,
    footer_size: typeof srcPage.footer_size === 'string' && srcPage.footer_size ? srcPage.footer_size : def.page.footer_size,
    footer_alignment: typeof srcPage.footer_alignment === 'string' && srcPage.footer_alignment ? srcPage.footer_alignment : def.page.footer_alignment,
    footer_color: typeof srcPage.footer_color === 'string' && srcPage.footer_color ? srcPage.footer_color : def.page.footer_color,
    page_number_enabled: typeof srcPage.page_number_enabled === 'boolean' ? srcPage.page_number_enabled : def.page.page_number_enabled,
    page_number_format: typeof srcPage.page_number_format === 'string' && srcPage.page_number_format ? srcPage.page_number_format : def.page.page_number_format,
    page_number_start: typeof srcPage.page_number_start === 'number' ? srcPage.page_number_start : def.page.page_number_start,
    page_number_pad: VALID_PAGE_NUMBER_PADS.includes(srcPage.page_number_pad) ? srcPage.page_number_pad : def.page.page_number_pad,
  };

  const srcHeadingBorder = source.heading_border && typeof source.heading_border === 'object' ? source.heading_border : {};
  const defHeadingCellColors = Array.isArray(def.heading_border.level_cell_colors) ? def.heading_border.level_cell_colors : DEFAULT_HEADING_BORDER_CELL_COLORS;
  const srcHeadingCellColors = Array.isArray(srcHeadingBorder.level_cell_colors) ? srcHeadingBorder.level_cell_colors : [];
  const heading_border = {
    enabled: typeof srcHeadingBorder.enabled === 'boolean' ? srcHeadingBorder.enabled : def.heading_border.enabled,
    min_heading_left_enabled: typeof srcHeadingBorder.min_heading_left_enabled === 'boolean' ? srcHeadingBorder.min_heading_left_enabled : def.heading_border.min_heading_left_enabled,
    border_color: typeof srcHeadingBorder.border_color === 'string' && srcHeadingBorder.border_color ? srcHeadingBorder.border_color : def.heading_border.border_color,
    level_cell_colors: defHeadingCellColors.map((color, index) => (typeof srcHeadingCellColors[index] === 'string' && srcHeadingCellColors[index] ? srcHeadingCellColors[index] : color)),
    structure: typeof srcHeadingBorder.structure === 'string' && VALID_HEADING_BORDER_STRUCTURES.includes(srcHeadingBorder.structure) ? srcHeadingBorder.structure : def.heading_border.structure,
  };

  const srcHeadings = Array.isArray(source.headings) ? source.headings : [];
  const headings = def.headings.map((defH, i) => {
    const srcH = srcHeadings[i];
    if (!srcH || typeof srcH !== 'object') return { ...defH };
    return {
      font: typeof srcH.font === 'string' && srcH.font ? srcH.font : defH.font,
      size: typeof srcH.size === 'string' && srcH.size ? srcH.size : defH.size,
      alignment: typeof srcH.alignment === 'string' && srcH.alignment ? srcH.alignment : defH.alignment,
      bold: typeof srcH.bold === 'boolean' ? srcH.bold : defH.bold,
      text_color: typeof srcH.text_color === 'string' && srcH.text_color ? srcH.text_color : defH.text_color,
      spacing_before_pt: typeof srcH.spacing_before_pt === 'number' ? srcH.spacing_before_pt : defH.spacing_before_pt,
      spacing_after_pt: typeof srcH.spacing_after_pt === 'number' ? srcH.spacing_after_pt : defH.spacing_after_pt,
      first_line_indent_chars: typeof srcH.first_line_indent_chars === 'number' ? srcH.first_line_indent_chars : defH.first_line_indent_chars,
      line_spacing: typeof srcH.line_spacing === 'number' ? srcH.line_spacing : defH.line_spacing,
      numbering_format: typeof srcH.numbering_format === 'string' && VALID_NUMBERING_FORMATS.includes(srcH.numbering_format) ? srcH.numbering_format : defH.numbering_format,
      numbering_template: typeof srcH.numbering_template === 'string' ? srcH.numbering_template : defH.numbering_template,
    };
  });

  const srcBody = source.body_text && typeof source.body_text === 'object' ? source.body_text : {};
  const body_text = {
    font: typeof srcBody.font === 'string' && srcBody.font ? srcBody.font : def.body_text.font,
    size: typeof srcBody.size === 'string' && srcBody.size ? srcBody.size : def.body_text.size,
    alignment: typeof srcBody.alignment === 'string' && srcBody.alignment ? srcBody.alignment : def.body_text.alignment,
    spacing_before: srcBody.spacing_before ?? def.body_text.spacing_before,
    spacing_before_unit: srcBody.spacing_before_unit ?? def.body_text.spacing_before_unit,
    spacing_after: srcBody.spacing_after ?? def.body_text.spacing_after,
    spacing_after_unit: srcBody.spacing_after_unit ?? def.body_text.spacing_after_unit,
    first_line_indent_chars: typeof srcBody.first_line_indent_chars === 'number' ? srcBody.first_line_indent_chars : def.body_text.first_line_indent_chars,
    line_spacing_mode: srcBody.line_spacing_mode ?? def.body_text.line_spacing_mode,
    line_spacing_value: srcBody.line_spacing_value ?? def.body_text.line_spacing_value,
    list_style: typeof srcBody.list_style === 'string' && VALID_LIST_STYLES.includes(srcBody.list_style) ? srcBody.list_style : def.body_text.list_style,
    ordered_list_style: typeof srcBody.ordered_list_style === 'string' && VALID_ORDERED_LIST_STYLES.includes(srcBody.ordered_list_style) ? srcBody.ordered_list_style : def.body_text.ordered_list_style,
    list_indent_chars: typeof srcBody.list_indent_chars === 'number' ? srcBody.list_indent_chars : def.body_text.list_indent_chars,
  };

  const srcTable = source.table && typeof source.table === 'object' ? source.table : {};
  const table = {
    border_width: typeof srcTable.border_width === 'number' ? srcTable.border_width : def.table.border_width,
    border_color: typeof srcTable.border_color === 'string' && srcTable.border_color ? srcTable.border_color : def.table.border_color,
    cell_padding_pt: typeof srcTable.cell_padding_pt === 'number' ? srcTable.cell_padding_pt : def.table.cell_padding_pt,
    full_width: typeof srcTable.full_width === 'boolean' ? srcTable.full_width : def.table.full_width,
    caption_font: typeof srcTable.caption_font === 'string' && srcTable.caption_font ? srcTable.caption_font : def.table.caption_font,
    caption_size: typeof srcTable.caption_size === 'string' && srcTable.caption_size ? srcTable.caption_size : def.table.caption_size,
    caption_alignment: typeof srcTable.caption_alignment === 'string' && srcTable.caption_alignment ? srcTable.caption_alignment : def.table.caption_alignment,
    caption_bold: typeof srcTable.caption_bold === 'boolean' ? srcTable.caption_bold : def.table.caption_bold,
    caption_italic: typeof srcTable.caption_italic === 'boolean' ? srcTable.caption_italic : def.table.caption_italic,
    header_row: normalizeTableCellStyle(srcTable.header_row, def.table.header_row),
    first_column: normalizeTableCellStyle(srcTable.first_column, def.table.first_column),
    body_cell: normalizeTableCellStyle(srcTable.body_cell, def.table.body_cell),
  };

  const image = normalizeImageStyle(source.image, def.image);

  return {
    template_name: typeof source.template_name === 'string' && source.template_name ? source.template_name : def.template_name,
    page,
    heading_level1_page_break_before: typeof source.heading_level1_page_break_before === 'boolean' ? source.heading_level1_page_break_before : def.heading_level1_page_break_before,
    heading_border,
    headings,
    body_text,
    table,
    image,
  };
}

module.exports = {
  DEFAULT_HEADING_BORDER_CELL_COLORS,
  defaultExportFormat,
  cloneDefaultExportFormat,
  normalizeExportFormat,
};
