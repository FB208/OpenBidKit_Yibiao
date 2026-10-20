// 暗标合规检查的格式预设：内置预设只读，用户预设以内置预设为底稿复制后修改。
// 预设字段沿用检查引擎的档案结构；这里只认引擎实际使用的字段，用户输入在此统一规范一次。

const DEFAULT_PRESET_ID = 'builtin-general';

const DEFAULT_PROFILE = {
  page: {
    paper: 'A4',
    margin_top_cm: 2.5,
    margin_bottom_cm: 2.5,
    margin_left_cm: 2.5,
    margin_right_cm: 2.5,
    check_orientation: true,
    forbid_columns: true,
    check_sections: false,
  },
  body: {
    font_cn: '宋体',
    font_en: null,
    size_pt: 14,
    line_rule: 'exact',
    line_pt: 25,
    line_multiple: null,
    space_before_pt: 0,
    space_after_pt: 0,
    first_line_indent_chars: 2,
    alignment: null,
    // 文字效果：false 不允许、true 允许、null 招标文件未要求（不检查）。突出显示同时管文字底纹。
    allow_bold: false,
    allow_italic: false,
    allow_underline: false,
    allow_color: false,
    allow_highlight: false,
    allow_char_spacing: true,
    allow_font_scaling: true,
    // 不含中文的文本块（纯数字、西文）是否按字号要求检查；招标文件写"数字、英文字符不做要求"时关闭。
    check_latin_size: true,
    tolerance_pt: 0.5,
    tolerance_line_pt: 0.5,
    tolerance_indent_chars: 0.1,
    tolerance_margin_cm: 0.02,
    check_snap_to_grid: false,
    check_vert_align: false,
  },
  headings: {
    1: { font_cn: null, size_pt: 16, bold: true },
    2: { font_cn: null, size_pt: 14, bold: false },
    3: { font_cn: null, size_pt: 14, bold: false },
    4: { font_cn: null, size_pt: 14, bold: false },
  },
  table: {
    check_font: true,
    font_cn: '宋体',
    check_size: true,
    size_pt: 10.5,
    check_first_line_indent: true,
    first_line_indent_chars: 0,
    // 表格文字加粗：null 同正文；斜体、颜色等其他效果一律同正文。
    allow_bold: null,
    check_tblStyle: true,
    check_shading: true,
    check_nested: true,
    alignment: null,
    check_merge: false,
  },
  structure: {
    // 空段落、页眉内容、页脚内容：true 不允许、false 允许、null 招标文件未要求（不检查）。
    check_empty_paragraphs: true,
    check_revisions: true,
    check_comments: true,
    check_hidden_text: true,
    check_header_footer: true,
    forbid_header_content: true,
    forbid_footer_content: true,
    // 页码：forbid 不得有页码；footer_only 页脚只准出现页码（页脚其他内容一律不允许）；null 不限。
    page_number: 'forbid',
    // 标题序号格式：arabic 阿拉伯数字分级（1、1.1、1.1.1）；null 不检查。
    heading_numbering: null,
    check_toc_present: 'hint',
    check_textbox: true,
    check_hyperlink: true,
    check_field_codes: true,
    check_bookmarks: false,
    // 封面格式由招标文件另行规定：首个分页前的封面不按正文格式检查，身份信息仍检查。
    skip_cover: true,
  },
  text: {
    check_english_punct: true,
    check_spaces: true,
    space_rules: {
      strip_leading_trailing: true,
      remove_between_cjk: true,
      forbid_fullwidth_space: false,
    },
    check_tabs: true,
    check_manual_linebreak: true,
    check_irregular: true,
    check_halfwidth_brackets: false,
    check_fullwidth_digits: false,
    check_fullwidth_letters: false,
  },
  privacy: {
    enable_builtin: true,
    keywords: [],
    regex: [],
    whitelist: [],
    ignore_orgs: [],
    check_company_suffix: true,
    check_phone: true,
    check_id_card: true,
    check_email: true,
    check_url: true,
    check_credit_code: true,
    check_bank_account: true,
    check_placeholder: true,
    check_toc: true,
  },
  props: {
    check_author: true,
    check_last_modified_by: true,
    check_company: true,
    check_template: true,
    check_custom_props: true,
  },
  // 一致性规则只在上面没有固定要求的项上兜底，以全文多数为准。
  consistency: {
    check_heading_format: true,
    check_heading_numbering: true,
    check_heading_level_jump: true,
    check_heading_content: true,
    heading_max_chars: 60,
    check_body_format: true,
    check_mixed_fonts: true,
  },
  // 彩色图片需要逐张解码抽样，较慢，只在招标文件要求黑白或灰度时开启。
  image: {
    check_color: false,
    check_vector: true,
    check_metadata: true,
  },
  rules: {},
};

// 地区参考值整理自公开资料，不是官方要求；页面上统一提示以招标文件为准。
const BUILTIN_PRESETS = [
  {
    id: DEFAULT_PRESET_ID,
    name: '通用',
    description: 'A4，正文宋体四号、固定行距 25 磅、首行缩进 2 字符，表格宋体五号，页边距四边 2.5 cm。',
    profile: {},
  },
  {
    id: 'builtin-neimenggu',
    name: '内蒙古（参考）',
    description: '正文宋体四号、固定行距 28 磅，表格宋体五号，一级标题宋体三号加粗，页边距四边 2.0 cm。',
    profile: {
      page: { margin_top_cm: 2, margin_bottom_cm: 2, margin_left_cm: 2, margin_right_cm: 2 },
      body: { line_pt: 28 },
      text: { check_english_punct: false, check_spaces: false },
    },
  },
  {
    id: 'builtin-hebei',
    name: '河北（参考）',
    description: '正文宋体四号、固定行距 30 磅，表格宋体四号，标题均为四号，页边距上 2.5 下 2.0 左 2.0 右 2.0 cm。',
    profile: {
      page: { margin_top_cm: 2.5, margin_bottom_cm: 2, margin_left_cm: 2, margin_right_cm: 2 },
      body: { line_pt: 30 },
      headings: { 1: { size_pt: 14, bold: true } },
      table: { size_pt: 14 },
    },
  },
  {
    id: 'builtin-sichuan',
    name: '四川（参考）',
    description: '正文宋体四号、固定行距 28 磅，表格宋体四号，一级标题三号不加粗，页边距四边 2.5 cm。',
    profile: {
      body: { line_pt: 28 },
      headings: { 1: { size_pt: 16, bold: false } },
      table: { size_pt: 14 },
    },
  },
];

const RULE_IDS = new Set([
  'privacy.keyword', 'struct.doc_props', 'text.hidden', 'struct.hyperlink', 'struct.field',
  'struct.revision', 'struct.comment', 'struct.header_footer', 'struct.empty_paragraph', 'struct.page_number_text', 'struct.toc', 'struct.heading_number', 'struct.textbox',
  'page.paper_size', 'page.orientation', 'page.margins', 'page.columns',
  'para.alignment', 'para.line_spacing', 'para.first_line_indent', 'para.space_before_after', 'para.page_break_before',
  'font.chinese', 'font.western', 'font.size', 'font.bold', 'font.italic', 'font.underline', 'font.color', 'font.highlight', 'font.effects', 'font.char_spacing', 'font.scaling',
  'text.english_punct', 'text.spaces', 'text.linebreak', 'text.tabs', 'text.irregular',
  'table.font', 'table.size', 'table.indent', 'table.style', 'table.shading', 'table.nested',
  'page.sections', 'para.snap_to_grid', 'font.script', 'table.alignment', 'table.merge', 'struct.bookmark',
  'text.halfwidth_punct', 'text.fullwidth_digit', 'text.fullwidth_latin',
  'consistency.heading_format', 'consistency.heading_numbering', 'consistency.heading_level_jump',
  'consistency.heading_content', 'consistency.body_format', 'consistency.mixed_fonts',
  'image.color', 'image.graphic_color', 'image.vector', 'image.meta', 'page.background',
]);

// 自动修复可处理的规则。默认不勾选：段前分页和对齐到网格需人工确认是否必要；
// 英文标点、多余空格、分栏不是招标文件的格式条款，只是排版建议。
const FIX_RULE_IDS = [
  'struct.doc_props', 'struct.comment', 'struct.revision', 'text.hidden', 'struct.hyperlink', 'struct.field', 'struct.header_footer', 'image.meta', 'struct.bookmark',
  'page.paper_size', 'page.margins', 'page.columns', 'page.background',
  'para.line_spacing', 'para.first_line_indent', 'para.space_before_after', 'para.alignment',
  'font.chinese', 'font.western', 'font.size', 'font.bold', 'font.italic', 'font.underline', 'font.color', 'font.highlight', 'font.effects', 'font.char_spacing', 'font.scaling',
  'table.font', 'table.size', 'table.indent', 'table.shading', 'image.color',
  'text.english_punct', 'text.spaces', 'text.irregular', 'text.linebreak', 'struct.empty_paragraph', 'struct.heading_number', 'struct.toc', 'para.page_break_before', 'para.snap_to_grid',
];
const NOT_DEFAULT_FIX_RULES = ['para.page_break_before', 'para.snap_to_grid', 'text.english_punct', 'text.spaces', 'page.columns'];
const DEFAULT_FIX_RULES = FIX_RULE_IDS.filter((ruleId) => !NOT_DEFAULT_FIX_RULES.includes(ruleId));

/** 规范修复项：只保留可修复的规则，保持固定顺序；未保存过时用默认勾选。 */
function normalizeFixRules(value) {
  if (!Array.isArray(value)) return [...DEFAULT_FIX_RULES];
  const selected = new Set(value.map(String));
  return FIX_RULE_IDS.filter((ruleId) => selected.has(ruleId));
}

const ENUMS = {
  paper: ['A4', 'A3', 'Letter'],
  line_rule: ['exact', 'atLeast', 'multiple'],
  alignment: ['left', 'center', 'right', 'both'],
  table_alignment: ['left', 'center', 'right'],
  check_toc_present: ['ignore', 'hint', 'forbid', 'require'],
  page_number: ['forbid', 'footer_only'],
  heading_numbering: ['arabic'],
  severity: ['high', 'medium', 'low'],
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

function readNumber(value, fallback, min, max) {
  if (value === null) return null;
  const number = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function readText(value, fallback) {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text || null;
}

function readEnum(value, allowed, fallback) {
  if (value === null) return null;
  return allowed.includes(value) ? value : fallback;
}

function readBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalBool(value, fallback) {
  if (value === null) return null;
  return typeof value === 'boolean' ? value : fallback;
}

function readWords(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean)));
}

/**
 * 把用户输入的预设规范成引擎可用的完整档案：未知字段丢弃，类型不符时回退默认值，
 * 数值按合理范围收紧；null 表示该项不检查。
 */
function normalizeProfile(input) {
  const source = deepMerge(DEFAULT_PROFILE, isPlainObject(input) ? input : {});
  const defaults = DEFAULT_PROFILE;
  const pageSource = source.page || {};
  const bodySource = source.body || {};
  const tableSource = source.table || {};
  const structureSource = source.structure || {};
  const textSource = source.text || {};
  const privacySource = source.privacy || {};
  const propsSource = source.props || {};
  const consistencySource = source.consistency || {};
  const imageSource = source.image || {};

  const page = {
    paper: readEnum(pageSource.paper, ENUMS.paper, defaults.page.paper),
    check_orientation: readBool(pageSource.check_orientation, defaults.page.check_orientation),
    forbid_columns: readBool(pageSource.forbid_columns, defaults.page.forbid_columns),
    check_sections: readBool(pageSource.check_sections, defaults.page.check_sections),
  };
  for (const key of ['margin_top_cm', 'margin_bottom_cm', 'margin_left_cm', 'margin_right_cm']) {
    page[key] = readNumber(pageSource[key], defaults.page[key], 0, 10);
  }

  const body = {
    font_cn: readText(bodySource.font_cn, defaults.body.font_cn),
    font_en: readText(bodySource.font_en, defaults.body.font_en),
    size_pt: readNumber(bodySource.size_pt, defaults.body.size_pt, 5, 72),
    line_rule: readEnum(bodySource.line_rule, ENUMS.line_rule, defaults.body.line_rule) || defaults.body.line_rule,
    line_pt: readNumber(bodySource.line_pt, defaults.body.line_pt, 1, 200),
    line_multiple: readNumber(bodySource.line_multiple, defaults.body.line_multiple, 0.5, 5),
    space_before_pt: readNumber(bodySource.space_before_pt, defaults.body.space_before_pt, 0, 200),
    space_after_pt: readNumber(bodySource.space_after_pt, defaults.body.space_after_pt, 0, 200),
    first_line_indent_chars: readNumber(bodySource.first_line_indent_chars, defaults.body.first_line_indent_chars, 0, 10),
    alignment: readEnum(bodySource.alignment, ENUMS.alignment, defaults.body.alignment),
    tolerance_pt: readNumber(bodySource.tolerance_pt, defaults.body.tolerance_pt, 0, 5) ?? defaults.body.tolerance_pt,
    tolerance_line_pt: readNumber(bodySource.tolerance_line_pt, defaults.body.tolerance_line_pt, 0, 10) ?? defaults.body.tolerance_line_pt,
    tolerance_indent_chars: readNumber(bodySource.tolerance_indent_chars, defaults.body.tolerance_indent_chars, 0, 2) ?? defaults.body.tolerance_indent_chars,
    tolerance_margin_cm: readNumber(bodySource.tolerance_margin_cm, defaults.body.tolerance_margin_cm, 0, 1) ?? defaults.body.tolerance_margin_cm,
  };
  for (const key of ['allow_bold', 'allow_italic', 'allow_underline', 'allow_color', 'allow_highlight']) {
    body[key] = readOptionalBool(bodySource[key], defaults.body[key]);
  }
  for (const key of ['allow_char_spacing', 'allow_font_scaling', 'check_latin_size', 'check_snap_to_grid', 'check_vert_align']) {
    body[key] = readBool(bodySource[key], defaults.body[key]);
  }

  const headings = {};
  for (const level of ['1', '2', '3', '4']) {
    const headingSource = source.headings?.[level] || {};
    const headingDefaults = defaults.headings[level];
    headings[level] = {
      font_cn: readText(headingSource.font_cn, headingDefaults.font_cn),
      size_pt: readNumber(headingSource.size_pt, headingDefaults.size_pt, 5, 72),
      bold: readOptionalBool(headingSource.bold, headingDefaults.bold),
    };
  }

  const table = {
    font_cn: readText(tableSource.font_cn, defaults.table.font_cn),
    size_pt: readNumber(tableSource.size_pt, defaults.table.size_pt, 5, 72),
    first_line_indent_chars: readNumber(tableSource.first_line_indent_chars, defaults.table.first_line_indent_chars, 0, 10),
    alignment: readEnum(tableSource.alignment, ENUMS.table_alignment, defaults.table.alignment),
    allow_bold: readOptionalBool(tableSource.allow_bold, defaults.table.allow_bold),
  };
  for (const key of ['check_font', 'check_size', 'check_first_line_indent', 'check_tblStyle', 'check_shading', 'check_nested', 'check_merge']) {
    table[key] = readBool(tableSource[key], defaults.table[key]);
  }

  const structure = {
    check_toc_present: readEnum(structureSource.check_toc_present === 'warn' ? 'hint' : structureSource.check_toc_present, ENUMS.check_toc_present, defaults.structure.check_toc_present) || defaults.structure.check_toc_present,
    page_number: readEnum(structureSource.page_number, ENUMS.page_number, defaults.structure.page_number),
    heading_numbering: readEnum(structureSource.heading_numbering, ENUMS.heading_numbering, defaults.structure.heading_numbering),
  };
  for (const [key, fallback] of Object.entries(defaults.structure)) {
    if (['check_toc_present', 'page_number', 'heading_numbering'].includes(key)) continue;
    structure[key] = ['check_empty_paragraphs', 'forbid_header_content', 'forbid_footer_content'].includes(key)
      ? readOptionalBool(structureSource[key], fallback)
      : readBool(structureSource[key], fallback);
  }

  const text = { space_rules: {} };
  for (const [key, fallback] of Object.entries(defaults.text)) {
    if (key !== 'space_rules') text[key] = readBool(textSource[key], fallback);
  }
  for (const [key, fallback] of Object.entries(defaults.text.space_rules)) {
    text.space_rules[key] = readBool(textSource.space_rules?.[key], fallback);
  }

  const privacy = {
    keywords: readWords(privacySource.keywords),
    regex: readWords(privacySource.regex),
    whitelist: readWords(privacySource.whitelist),
    ignore_orgs: readWords(privacySource.ignore_orgs),
  };
  for (const [key, fallback] of Object.entries(defaults.privacy)) {
    if (!Array.isArray(fallback)) privacy[key] = readBool(privacySource[key], fallback);
  }

  const props = {};
  for (const [key, fallback] of Object.entries(defaults.props)) props[key] = readBool(propsSource[key], fallback);

  const consistency = {
    heading_max_chars: readNumber(consistencySource.heading_max_chars, defaults.consistency.heading_max_chars, 10, 500) ?? defaults.consistency.heading_max_chars,
  };
  for (const [key, fallback] of Object.entries(defaults.consistency)) {
    if (key !== 'heading_max_chars') consistency[key] = readBool(consistencySource[key], fallback);
  }

  const image = {};
  for (const [key, fallback] of Object.entries(defaults.image)) image[key] = readBool(imageSource[key], fallback);

  const rules = {};
  for (const [ruleId, value] of Object.entries(isPlainObject(source.rules) ? source.rules : {})) {
    if (!RULE_IDS.has(ruleId) || !isPlainObject(value)) continue;
    const rule = {};
    if (typeof value.enabled === 'boolean') rule.enabled = value.enabled;
    if (ENUMS.severity.includes(value.severity)) rule.severity = value.severity;
    if (Object.keys(rule).length) rules[ruleId] = rule;
  }

  return { page, body, headings, table, structure, text, privacy, props, consistency, image, rules };
}

function listBuiltinPresets() {
  return BUILTIN_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    builtin: true,
    profile: normalizeProfile(preset.profile),
  }));
}

function findBuiltinPreset(presetId) {
  return listBuiltinPresets().find((preset) => preset.id === presetId) || null;
}

module.exports = {
  DEFAULT_PRESET_ID,
  FIX_RULE_IDS,
  normalizeFixRules,
  findBuiltinPreset,
  listBuiltinPresets,
  normalizeProfile,
};
