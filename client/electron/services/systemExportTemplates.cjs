const { cloneDefaultExportFormat } = require('./exportFormatDefaults.cjs');

/**
 * 系统预设导出模板的真源。
 *
 * 这里的定义每次启动都会幂等同步进 export_templates 表（见 templateStore.syncSystemTemplates），
 * 所以改预设样式只要改这个文件，不需要写数据库迁移。
 *
 * template_id 一经发布不可再改：technical_plan_generation_config.export_template_id 会引用它，
 * 改 id 等于让老用户已选的模板失效。数组顺序即"我的模板"里系统分组的展示顺序。
 *
 * 取值参考 src/features/export-format/exportFormatPresets.ts 的版面预设与主题预设，
 * 那两份常量是同一批字段的成熟配比；这里把版面与配色合成完整模板落库。
 *
 * 配色约定（client/开发说明.md）：色带页脚整条铺 chrome_accent_color，页脚文字用 footer_color
 * 且渲染侧不会替我们改，两者必须成对维护；frame 页脚是白底加强调色边框，深色字即可。
 */

/** 六级标题的通用构造，省得每套重复写十二个字段。 */
function heading(font, size, alignment, bold, textColor, spacingBefore, spacingAfter, numberingTemplate) {
  return {
    font,
    size,
    alignment,
    bold,
    text_color: textColor,
    spacing_before_pt: spacingBefore,
    spacing_after_pt: spacingAfter,
    first_line_indent_chars: 0,
    line_spacing: 1,
    numbering_format: 'custom',
    numbering_template: numberingTemplate,
  };
}

/** 投标文件的常规编号：一级"第X章"、二级"第X节"，往下只留末段序号。 */
const BID_NUMBERING = ['第{zh}章', '第{zh}节', '{tail}', '{tail}', '{tail}', '{tail}'];

/** 以默认导出格式为基线逐段浅合并，只写与默认不同的字段。 */
function buildConfig(overrides) {
  const base = cloneDefaultExportFormat();
  return {
    ...base,
    ...overrides,
    page: { ...base.page, ...(overrides.page || {}) },
    heading_border: { ...base.heading_border, ...(overrides.heading_border || {}) },
    headings: overrides.headings || base.headings,
    body_text: { ...base.body_text, ...(overrides.body_text || {}) },
    table: {
      ...base.table,
      ...(overrides.table || {}),
      header_row: { ...base.table.header_row, ...(overrides.table?.header_row || {}) },
      first_column: { ...base.table.first_column, ...(overrides.table?.first_column || {}) },
      body_cell: { ...base.table.body_cell, ...(overrides.table?.body_cell || {}) },
    },
    image: { ...base.image, ...(overrides.image || {}) },
  };
}

const SYSTEM_EXPORT_TEMPLATES = [
  {
    // 黑白无装饰的常规投标版式，评审最不容易挑刺的一套。
    template_id: 'tpl-system-standard-bid',
    config: buildConfig({
      template_name: '标准投标简版',
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
        header_footer_style: 'plain',
        header_color: '#000000',
        footer_enabled: false,
        footer_color: '#000000',
        // 页眉页脚都关着，但页码照出：shouldBuildFooter 只看 page_number_enabled，
        // 所以页脚里只有一个不带任何装饰的页码。
        page_number_enabled: true,
        page_number_format: '第{page}页',
      },
      // 简版走连排：章节另起页是正式装订版的做法，参考 exportFormatPresets.ts 里
      // standard-bid 与 formal-binding 的分工。开着的话正文前只有导出侧那两行标题块，
      // 第一页会近乎空白。
      heading_level1_page_break_before: false,
      heading_border: {
        enabled: false,
        border_color: '#000000',
        level_cell_colors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
      },
      headings: [
        heading('黑体', '小二', '居中对齐', false, '#000000', 12, 12, BID_NUMBERING[0]),
        heading('黑体', '四号', '两端对齐', false, '#000000', 10, 10, BID_NUMBERING[1]),
        heading('黑体', '小四', '两端对齐', false, '#000000', 8, 8, BID_NUMBERING[2]),
        heading('楷体', '小四', '两端对齐', false, '#000000', 6, 6, BID_NUMBERING[3]),
        heading('黑体', '小四', '两端对齐', false, '#000000', 6, 6, BID_NUMBERING[4]),
        heading('宋体', '小四', '两端对齐', false, '#000000', 0, 0, BID_NUMBERING[5]),
      ],
      body_text: {
        font: '宋体',
        size: '小四',
        alignment: '两端对齐',
        first_line_indent_chars: 2,
        line_spacing_mode: 'multiple',
        line_spacing_value: 1.5,
        list_style: 'disc',
        ordered_list_style: 'decimal-dot',
        list_indent_chars: 2,
      },
      table: {
        border_width: 1,
        border_color: '#000000',
        cell_padding_pt: 6,
        full_width: true,
        caption_font: '宋体',
        caption_size: '小四',
        caption_bold: true,
        header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#000000', background_color: '#ffffff' },
        first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#000000', background_color: '#ffffff' },
        body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#000000', background_color: '#ffffff' },
      },
      image: {
        max_width_percent: 90,
        caption_font: '宋体',
        caption_size: '小五',
      },
    }),
  },
  {
    // 蓝色主题 + 通栏色带页眉页脚 + 彩色标题块，用于要求观感的技术方案。
    template_id: 'tpl-system-a4-visual',
    config: buildConfig({
      template_name: 'A4 图文版',
      page: {
        paper_size: 'a4',
        orientation: 'portrait',
        two_column: false,
        first_page_different: true,
        margin_top_cm: 2.2,
        margin_bottom_cm: 2,
        margin_left_cm: 2,
        margin_right_cm: 2,
        header_enabled: true,
        header_footer_style: 'band',
        header_font: '黑体',
        header_size: '小五',
        header_alignment: '左对齐',
        // band 页眉字色由装饰底色算（textLayout 的 colors.onBar），这里的值只在换成
        // plain / rules / footer-badge 时才生效。
        header_color: '#315b9f',
        chrome_bar_color: '#dbeafe',
        chrome_accent_color: '#173f82',
        footer_enabled: true,
        footer_font: '宋体',
        footer_size: '小五',
        footer_alignment: '居中对齐',
        // 色带页脚整条铺 chrome_accent_color，字色必须与之对比。
        // #ffffff = contrastText('#173f82')，改强调色时这里要一起改。
        footer_color: '#ffffff',
        page_number_enabled: true,
        page_number_format: '- {page} -',
        page_number_pad: 2,
      },
      heading_level1_page_break_before: true,
      heading_border: {
        enabled: true,
        structure: '上下结构',
        border_color: '#2174fd',
        level_cell_colors: ['#dbeafe', '#e8f1ff', '#f1f7ff', '#f6faff', '#ffffff', '#ffffff'],
      },
      headings: [
        heading('黑体', '小二', '居中对齐', true, '#173f82', 0, 0, BID_NUMBERING[0]),
        heading('黑体', '四号', '左对齐', true, '#173f82', 0, 0, BID_NUMBERING[1]),
        heading('黑体', '小四', '左对齐', true, '#173f82', 0, 0, BID_NUMBERING[2]),
        heading('楷体', '小四', '左对齐', false, '#173f82', 0, 0, BID_NUMBERING[3]),
        heading('黑体', '小四', '左对齐', false, '#243048', 0, 0, BID_NUMBERING[4]),
        heading('宋体', '小四', '左对齐', false, '#243048', 0, 0, BID_NUMBERING[5]),
      ],
      body_text: {
        font: '宋体',
        size: '小四',
        alignment: '两端对齐',
        spacing_after: 4,
        spacing_after_unit: 'pt',
        first_line_indent_chars: 2,
        line_spacing_mode: 'multiple',
        line_spacing_value: 1.3,
        list_style: 'diamond',
        ordered_list_style: 'decimal-dot',
        list_indent_chars: 2,
      },
      table: {
        border_width: 0.75,
        border_color: '#8db8ff',
        cell_padding_pt: 6,
        full_width: true,
        caption_font: '黑体',
        caption_size: '小四',
        caption_bold: true,
        header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#123a78', background_color: '#dbeafe' },
        first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#173f82', background_color: '#eef5ff' },
        body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
      },
      image: {
        max_width_percent: 92,
        caption_font: '楷体',
        caption_size: '小五',
        caption_bold: true,
      },
    }),
  },
  {
    // A3 横向双列 + 页框页眉页脚；章节页框使用段落边框，业务表格保持顶层。
    template_id: 'tpl-system-a3-landscape-visual',
    config: buildConfig({
      template_name: 'A3 横版图文',
      page: {
        paper_size: 'a3',
        orientation: 'landscape',
        two_column: true,
        first_page_different: true,
        margin_top_cm: 1.6,
        margin_bottom_cm: 1.6,
        margin_left_cm: 1.5,
        margin_right_cm: 1.5,
        header_enabled: true,
        header_footer_style: 'frame',
        header_font: '黑体',
        header_size: '小五',
        header_alignment: '居中对齐',
        // frame 页眉字色取 colors.accent，同样由装饰决定。
        header_color: '#7054aa',
        chrome_bar_color: '#f2edff',
        chrome_accent_color: '#5b3ca6',
        footer_enabled: true,
        footer_font: '宋体',
        footer_size: '小五',
        footer_alignment: '居中对齐',
        // frame 页脚是白底加强调色边框，深紫字在白底上可读，不需要反色。
        footer_color: '#5b3ca6',
        page_number_enabled: true,
        page_number_format: '第{page}页',
      },
      heading_level1_page_break_before: true,
      heading_border: {
        enabled: true,
        structure: '上下结构',
        border_color: '#a78bfa',
        level_cell_colors: ['#f2edff', '#f6f2ff', '#faf7ff', '#fdfbff', '#ffffff', '#ffffff'],
      },
      headings: [
        heading('黑体', '三号', '居中对齐', true, '#5b3ca6', 0, 0, BID_NUMBERING[0]),
        heading('黑体', '小三', '左对齐', true, '#5b3ca6', 0, 0, BID_NUMBERING[1]),
        heading('黑体', '四号', '左对齐', true, '#5b3ca6', 0, 0, BID_NUMBERING[2]),
        heading('楷体', '小四', '左对齐', false, '#5b3ca6', 0, 0, BID_NUMBERING[3]),
        heading('黑体', '小四', '居中对齐', false, '#243048', 0, 0, BID_NUMBERING[4]),
        heading('宋体', '小四', '居中对齐', false, '#243048', 0, 0, BID_NUMBERING[5]),
      ],
      body_text: {
        font: '宋体',
        size: '小四',
        alignment: '两端对齐',
        spacing_after: 3,
        spacing_after_unit: 'pt',
        first_line_indent_chars: 2,
        line_spacing_mode: 'multiple',
        line_spacing_value: 1.25,
        list_style: 'square',
        ordered_list_style: 'decimal-dot',
        list_indent_chars: 2,
      },
      table: {
        border_width: 0.75,
        border_color: '#c9b8ff',
        cell_padding_pt: 5,
        full_width: true,
        caption_font: '黑体',
        caption_size: '小四',
        caption_bold: true,
        header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#553798', background_color: '#f2edff' },
        first_column: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#5b3ca6', background_color: '#f8f5ff' },
        body_cell: { font: '宋体', size: '五号', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
      },
      image: {
        max_width_percent: 88,
        caption_font: '宋体',
        caption_size: '小五',
      },
    }),
  },
];

module.exports = {
  SYSTEM_EXPORT_TEMPLATES,
};
