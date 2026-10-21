import { FONT_OPTIONS, SIZE_OPTIONS, SIZE_TO_PT } from '../../shared/types/exportFormat';
import type { BlindCheckExtractedField, BlindCheckPresetSource, BlindCheckPresetTab, BlindCheckProfile } from './types';

export type PresetFieldKind = 'switch' | 'select' | 'number' | 'font' | 'size' | 'bold' | 'tristate' | 'words';

export interface PresetFieldOption {
  value: string;
  label: string;
}

export interface PresetField {
  path: string[];
  label: string;
  hint?: string;
  kind: PresetFieldKind;
  options?: PresetFieldOption[];
  unit?: string;
  min?: number;
  max?: number;
  /** 选择框或数字框允许置空时的含义，例如"不检查""同正文"。 */
  nullLabel?: string;
  /** 三选一开关（tristate）里 true、false 的显示文字；null 显示 nullLabel。 */
  trueLabel?: string;
  falseLabel?: string;
  visible?: (profile: BlindCheckProfile) => boolean;
}

export interface PresetSection {
  title: string;
  description?: string;
  fields: PresetField[];
}

export const presetTabs: Array<{ id: BlindCheckPresetTab; label: string }> = [
  { id: 'page', label: '页面' },
  { id: 'body', label: '正文' },
  { id: 'headings', label: '标题与目录' },
  { id: 'table', label: '表格与图片' },
  { id: 'privacy', label: '身份与痕迹' },
  { id: 'source', label: 'AI 提取说明' },
];

export const FONT_CHOICES: readonly string[] = FONT_OPTIONS;

export const SIZE_CHOICES = SIZE_OPTIONS.map((name) => ({ label: name, value: SIZE_TO_PT[name] }));

/** 磅值显示为中文字号，非标准字号显示磅值。 */
export function sizeLabel(pt: number | null | undefined) {
  if (pt === null || pt === undefined) return '不检查';
  const match = SIZE_CHOICES.find((item) => Math.abs(item.value - pt) < 0.01);
  return match ? match.label : `${pt}磅`;
}

const lineRuleOptions: PresetFieldOption[] = [
  { value: 'exact', label: '固定值' },
  { value: 'atLeast', label: '最小值' },
  { value: 'multiple', label: '多倍行距' },
];

const alignmentOptions: PresetFieldOption[] = [
  { value: 'left', label: '左对齐' },
  { value: 'both', label: '两端对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
];

const tocOptions: PresetFieldOption[] = [
  { value: 'hint', label: '只提示手工目录' },
  { value: 'forbid', label: '不允许有目录' },
  { value: 'require', label: '必须有目录' },
  { value: 'ignore', label: '不检查' },
];

const pageNumberOptions: PresetFieldOption[] = [
  { value: 'forbid', label: '不得有页码' },
  { value: 'footer_only', label: '页脚只准出现页码' },
];

const headingNumberingOptions: PresetFieldOption[] = [
  { value: 'arabic', label: '阿拉伯数字分级（1、1.1、1.1.1）' },
];

const allowLabels = { trueLabel: '允许', falseLabel: '不允许', nullLabel: '招标未要求' };
const headerFooterLabels = { trueLabel: '不得有内容', falseLabel: '允许有内容', nullLabel: '招标未要求' };

const tableAlignmentOptions: PresetFieldOption[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
];

const paperOptions: PresetFieldOption[] = [
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
  { value: 'Letter', label: 'Letter' },
];

function headingFields(level: '1' | '2' | '3' | '4'): PresetField[] {
  return [
    { path: ['headings', level, 'font_cn'], label: '中文字体', kind: 'font', nullLabel: '同正文' },
    { path: ['headings', level, 'size_pt'], label: '字号', kind: 'size', nullLabel: '不检查' },
    { path: ['headings', level, 'bold'], label: '加粗', kind: 'bold' },
  ];
}

export const presetSections: Record<BlindCheckPresetTab, PresetSection[]> = {
  page: [
    {
      title: '纸张与页边距',
      fields: [
        { path: ['page', 'paper'], label: '纸张大小', kind: 'select', options: paperOptions, nullLabel: '招标未要求' },
        { path: ['page', 'margin_top_cm'], label: '上边距', kind: 'number', unit: 'cm', min: 0, max: 10, nullLabel: '不检查' },
        { path: ['page', 'margin_bottom_cm'], label: '下边距', kind: 'number', unit: 'cm', min: 0, max: 10, nullLabel: '不检查' },
        { path: ['page', 'margin_left_cm'], label: '左边距', kind: 'number', unit: 'cm', min: 0, max: 10, nullLabel: '不检查' },
        { path: ['page', 'margin_right_cm'], label: '右边距', kind: 'number', unit: 'cm', min: 0, max: 10, nullLabel: '不检查' },
      ],
    },
    {
      title: '版式',
      fields: [
        { path: ['page', 'check_orientation'], label: '检查横向页面', hint: '暗标正文通常要求纵向排版', kind: 'switch' },
        { path: ['page', 'forbid_columns'], label: '检查分栏', hint: '暗标正文一般要求单栏', kind: 'switch' },
        { path: ['page', 'check_sections'], label: '各节页面设置一致', hint: '某一节的纸张、方向、页边距或分栏与第 1 节不同时提示', kind: 'switch' },
        { path: ['structure', 'skip_cover'], label: '识别封面', hint: '首个分页前的封面不按正文格式检查，身份信息仍会检查', kind: 'switch' },
      ],
    },
    {
      title: '页眉页脚与页码',
      fields: [
        { path: ['structure', 'check_header_footer'], label: '检查页眉页脚', kind: 'switch' },
        { path: ['structure', 'forbid_header_content'], label: '页眉内容', kind: 'tristate', ...headerFooterLabels, visible: (profile) => profile.structure.check_header_footer },
        { path: ['structure', 'forbid_footer_content'], label: '页脚内容', kind: 'tristate', ...headerFooterLabels, visible: (profile) => profile.structure.check_header_footer && profile.structure.page_number !== 'footer_only' },
        { path: ['structure', 'page_number'], label: '页码', hint: '页眉页脚中的页码和正文中的"第 X 页"；选"页脚只准出现页码"时，页脚里页码以外的内容都会报出', kind: 'select', options: pageNumberOptions, nullLabel: '不限' },
      ],
    },
  ],
  body: [
    {
      title: '字体字号',
      fields: [
        { path: ['body', 'font_cn'], label: '中文字体', kind: 'font', nullLabel: '不检查' },
        { path: ['body', 'font_en'], label: '西文字体', hint: '招标文件未规定时保持不检查', kind: 'font', nullLabel: '不检查' },
        { path: ['body', 'size_pt'], label: '字号', kind: 'size', nullLabel: '不检查' },
        { path: ['body', 'check_latin_size'], label: '数字、西文按字号检查', hint: '招标文件写"数字、英文字符不做要求"时关闭', kind: 'switch' },
      ],
    },
    {
      title: '段落',
      fields: [
        { path: ['body', 'line_rule'], label: '行距类型', kind: 'select', options: lineRuleOptions },
        { path: ['body', 'line_pt'], label: '行距值', kind: 'number', unit: '磅', min: 1, max: 200, nullLabel: '不检查', visible: (profile) => profile.body.line_rule !== 'multiple' },
        { path: ['body', 'line_multiple'], label: '行距倍数', kind: 'number', unit: '倍', min: 0.5, max: 5, nullLabel: '不检查', visible: (profile) => profile.body.line_rule === 'multiple' },
        { path: ['body', 'first_line_indent_chars'], label: '首行缩进', kind: 'number', unit: '字符', min: 0, max: 10, nullLabel: '不检查' },
        { path: ['body', 'space_before_pt'], label: '段前间距', kind: 'number', unit: '磅', min: 0, max: 200, nullLabel: '不检查' },
        { path: ['body', 'space_after_pt'], label: '段后间距', kind: 'number', unit: '磅', min: 0, max: 200, nullLabel: '不检查' },
        { path: ['body', 'alignment'], label: '对齐方式', hint: '招标文件明确规定时再设置', kind: 'select', options: alignmentOptions, nullLabel: '不检查' },
      ],
    },
    {
      title: '文字效果',
      description: '选"不允许"的效果在正文和表格中出现时会被报出；"招标未要求"的不检查。',
      fields: [
        { path: ['body', 'allow_bold'], label: '加粗', kind: 'tristate', ...allowLabels },
        { path: ['body', 'allow_italic'], label: '斜体', kind: 'tristate', ...allowLabels },
        { path: ['body', 'allow_underline'], label: '下划线', kind: 'tristate', ...allowLabels },
        { path: ['body', 'allow_color'], label: '彩色文字', hint: '选"不允许"时，表格彩色底纹和页面背景色一并检查', kind: 'tristate', ...allowLabels },
        { path: ['body', 'allow_highlight'], label: '突出显示和文字底纹', kind: 'tristate', ...allowLabels },
        { path: ['body', 'allow_char_spacing'], label: '允许调整字符间距', kind: 'switch' },
        { path: ['body', 'allow_font_scaling'], label: '允许字体缩放', kind: 'switch' },
      ],
    },
    {
      title: '标点与空格',
      fields: [
        { path: ['text', 'check_english_punct'], label: '中文里的英文标点', kind: 'switch' },
        { path: ['text', 'check_spaces'], label: '多余空格', kind: 'switch' },
        { path: ['text', 'space_rules', 'strip_leading_trailing'], label: '行首行尾空格', kind: 'switch', visible: (profile) => profile.text.check_spaces },
        { path: ['text', 'space_rules', 'remove_between_cjk'], label: '中文之间的空格', kind: 'switch', visible: (profile) => profile.text.check_spaces },
        { path: ['text', 'space_rules', 'forbid_fullwidth_space'], label: '全角空格', kind: 'switch', visible: (profile) => profile.text.check_spaces },
        { path: ['text', 'check_manual_linebreak'], label: '手动换行（软回车）', kind: 'switch' },
        { path: ['text', 'check_tabs'], label: '制表符', kind: 'switch' },
        { path: ['text', 'check_irregular'], label: '不可见特殊字符', kind: 'switch' },
        { path: ['text', 'check_halfwidth_brackets'], label: '中文里的半角括号', kind: 'switch' },
        { path: ['text', 'check_fullwidth_digits'], label: '全角数字', kind: 'switch' },
        { path: ['text', 'check_fullwidth_letters'], label: '全角字母', kind: 'switch' },
      ],
    },
    {
      title: '空段落与文本框',
      fields: [
        { path: ['structure', 'check_empty_paragraphs'], label: '空段落', kind: 'tristate', trueLabel: '不允许', falseLabel: '允许', nullLabel: '招标未要求' },
        { path: ['structure', 'check_textbox'], label: '文本框', kind: 'switch' },
      ],
    },
    {
      title: '正文一致性',
      description: '上面选"不检查"的字体、字号和对齐方式，按全文多数找出不一致的段落；已设固定值的项不重复检查。',
      fields: [
        { path: ['consistency', 'check_body_format'], label: '正文格式统一', kind: 'switch' },
        { path: ['consistency', 'check_mixed_fonts'], label: '段内字体混用', hint: '中文字体选"不检查"时，同一段里出现两种以上中文字体', kind: 'switch' },
      ],
    },
    {
      title: '细项检查',
      description: '默认关闭，招标文件有相应要求时再开启。',
      fields: [
        { path: ['body', 'check_snap_to_grid'], label: '对齐到文档网格', hint: '节定义了文档网格且行距不是固定值时，实际行距会被放大', kind: 'switch' },
        { path: ['body', 'check_vert_align'], label: '上标和下标', hint: '技术标里 m³ 等单位很常见，确需检查时开启', kind: 'switch' },
      ],
    },
  ],
  headings: [
    ...(['1', '2', '3', '4'] as const).map((level) => ({
      title: `${['一', '二', '三', '四'][Number(level) - 1]}级标题`,
      description: level === '1' ? '标题优先按文档自带目录识别；字体选"同正文"时按正文字体检查。' : undefined,
      fields: headingFields(level),
    })),
    {
      title: '标题序号',
      fields: [
        { path: ['structure', 'heading_numbering'], label: '序号格式', hint: '招标文件规定标题序号格式时设置，例如"一级为 1、2、3，二级为 1.1、1.2"', kind: 'select', options: headingNumberingOptions, nullLabel: '招标未要求' },
      ],
    },
    {
      title: '标题一致性',
      description: '上面选"不检查"的项，以及对齐方式、首行缩进，按同级标题的多数比较。',
      fields: [
        { path: ['consistency', 'check_heading_format'], label: '同级标题格式一致', kind: 'switch' },
        { path: ['consistency', 'check_heading_numbering'], label: '标题编号连续', hint: '只看手写编号的跳号和重号，Word 自动编号不受影响', kind: 'switch' },
        { path: ['consistency', 'check_heading_level_jump'], label: '标题层级跳跃', hint: '例如一级标题后直接出现三级标题', kind: 'switch' },
        { path: ['consistency', 'check_heading_content'], label: '标题内容异常', hint: '只有编号没有文字，或字数过多', kind: 'switch' },
        { path: ['consistency', 'heading_max_chars'], label: '标题字数上限', kind: 'number', unit: '字', min: 10, max: 500, nullLabel: '60', visible: (profile) => profile.consistency.check_heading_content },
      ],
    },
    {
      title: '目录',
      fields: [
        { path: ['structure', 'check_toc_present'], label: '目录要求', kind: 'select', options: tocOptions },
      ],
    },
  ],
  table: [
    {
      title: '表格文字',
      fields: [
        { path: ['table', 'check_font'], label: '检查表格字体', kind: 'switch' },
        { path: ['table', 'font_cn'], label: '中文字体', kind: 'font', nullLabel: '不检查', visible: (profile) => profile.table.check_font },
        { path: ['table', 'check_size'], label: '检查表格字号', kind: 'switch' },
        { path: ['table', 'size_pt'], label: '字号', kind: 'size', nullLabel: '不检查', visible: (profile) => profile.table.check_size },
        { path: ['table', 'check_first_line_indent'], label: '检查单元格首行缩进', kind: 'switch' },
        { path: ['table', 'first_line_indent_chars'], label: '首行缩进', kind: 'number', unit: '字符', min: 0, max: 10, nullLabel: '不检查', visible: (profile) => profile.table.check_first_line_indent },
        { path: ['table', 'allow_bold'], label: '表格文字加粗', hint: '斜体、下划线、颜色等其他效果都按正文要求', kind: 'tristate', trueLabel: '允许', falseLabel: '不允许', nullLabel: '同正文' },
      ],
    },
    {
      title: '表格样式',
      fields: [
        { path: ['table', 'check_tblStyle'], label: '检查表格样式', hint: '套用带彩色表头或隔行底纹的内置样式时报出', kind: 'switch' },
        { path: ['table', 'check_shading'], label: '检查单元格底纹', hint: '正文彩色文字为"不允许"时检查彩色底纹', kind: 'switch' },
        { path: ['table', 'check_nested'], label: '检查嵌套表格', kind: 'switch' },
        { path: ['table', 'alignment'], label: '表格对齐方式', hint: '表格在页面上的水平位置，招标文件明确规定时再设置', kind: 'select', options: tableAlignmentOptions, nullLabel: '不检查' },
        { path: ['table', 'check_merge'], label: '合并单元格', hint: '统计含合并单元格的表格，供人工确认', kind: 'switch' },
      ],
    },
    {
      title: '图片',
      fields: [
        { path: ['image', 'check_color'], label: '彩色图片', hint: '招标文件要求黑白或灰度图片时开启；只判断 PNG、JPEG，需逐张解码，图片多时较慢', kind: 'switch' },
      ],
    },
  ],
  privacy: [
    {
      title: '自定义敏感词',
      fields: [
        { path: ['privacy', 'keywords'], label: '敏感词', hint: '每行一个。建议填写本单位全称、简称、项目负责人等，出现即报高风险。', kind: 'words' },
        { path: ['privacy', 'whitelist'], label: '白名单', hint: '每行一个。命中白名单的内容不报，例如招标人名称。', kind: 'words' },
      ],
    },
    {
      title: '内置识别',
      fields: [
        { path: ['privacy', 'enable_builtin'], label: '自称与敏感字段', hint: '"我公司""本单位"及"联系电话"等表单字段', kind: 'switch' },
        { path: ['privacy', 'check_company_suffix'], label: '企业名称', hint: '只认"有限公司""设计院"等完整后缀', kind: 'switch' },
        { path: ['privacy', 'check_phone'], label: '电话号码', kind: 'switch' },
        { path: ['privacy', 'check_id_card'], label: '身份证号', kind: 'switch' },
        { path: ['privacy', 'check_credit_code'], label: '统一社会信用代码', kind: 'switch' },
        { path: ['privacy', 'check_email'], label: '邮箱地址', kind: 'switch' },
        { path: ['privacy', 'check_url'], label: '网址', kind: 'switch' },
        { path: ['privacy', 'check_bank_account'], label: '疑似银行账号', kind: 'switch' },
        { path: ['privacy', 'check_placeholder'], label: '未填写的占位符', kind: 'switch' },
        { path: ['privacy', 'check_toc'], label: '同时检查目录文字', kind: 'switch' },
      ],
    },
    {
      title: '编辑痕迹',
      fields: [
        { path: ['structure', 'check_revisions'], label: '未接受的修订', kind: 'switch' },
        { path: ['structure', 'check_comments'], label: '批注', kind: 'switch' },
        { path: ['structure', 'check_hidden_text'], label: '隐藏文字', kind: 'switch' },
      ],
    },
    {
      title: '隐藏信息',
      fields: [
        { path: ['structure', 'check_hyperlink'], label: '外部超链接', kind: 'switch' },
        { path: ['structure', 'check_field_codes'], label: '泄露身份的域代码', hint: '作者、文件名、公司等域', kind: 'switch' },
        { path: ['structure', 'check_bookmarks'], label: '命名书签', hint: '列出手动插入的书签，书签名含敏感词时报高风险', kind: 'switch' },
        { path: ['image', 'check_vector'], label: '矢量图中的文字', hint: '提取 EMF、WMF、SVG 图中的文字，图框里残留单位名称时报高风险', kind: 'switch' },
        { path: ['image', 'check_metadata'], label: '图片元数据', hint: '作者、版权、描述等属性及拍摄位置', kind: 'switch' },
      ],
    },
    {
      title: '文档属性',
      fields: [
        { path: ['props', 'check_author'], label: '作者', kind: 'switch' },
        { path: ['props', 'check_last_modified_by'], label: '最后修改者', kind: 'switch' },
        { path: ['props', 'check_company'], label: '单位', kind: 'switch' },
        { path: ['props', 'check_template'], label: '模板名称', kind: 'switch' },
        { path: ['props', 'check_custom_props'], label: '自定义属性', kind: 'switch' },
      ],
    },
  ],
  // AI 提取说明页签没有可编辑字段，内容由 ExtractionNotice 展示。
  source: [],
};

const fieldLabels = new Map<string, string>();
const fieldDefinitions = new Map<string, PresetField>();
for (const tab of presetTabs) {
  for (const section of presetSections[tab.id]) {
    for (const field of section.fields) {
      fieldLabels.set(field.path.join('.'), `${tab.id === 'headings' ? section.title : tab.label} · ${field.label}`);
      fieldDefinitions.set(field.path.join('.'), field);
    }
  }
}

/** 字段路径的展示名，如"正文 · 中文字体""一级标题 · 字号"。 */
export function presetFieldLabel(path: string) {
  return fieldLabels.get(path) || path;
}

/** 字段当前值的展示文字，按字段类型显示成界面上的选项名，如"页脚只准出现页码""小四""不检查"。 */
export function presetFieldValueText(profile: BlindCheckProfile, path: string) {
  const field = fieldDefinitions.get(path);
  const value = readProfileValue(profile, path.split('.'));
  if (!field) return value === null || value === undefined ? '不检查' : String(value);
  if (value === null || value === undefined) return field.nullLabel || '不检查';
  switch (field.kind) {
    case 'switch':
      return value ? '开启' : '关闭';
    case 'tristate':
      return value ? field.trueLabel || '是' : field.falseLabel || '否';
    case 'bold':
      return value ? '加粗' : '不加粗';
    case 'size':
      return sizeLabel(value as number);
    case 'number':
      return `${value}${field.unit || ''}`;
    case 'select':
      return field.options?.find((option) => option.value === value)?.label || String(value);
    default:
      return String(value);
  }
}

export function readProfileValue(profile: BlindCheckProfile, path: string[]): unknown {
  let current: unknown = profile;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 按路径不可变地写入一个字段，返回新的预设档案。 */
export function writeProfileValue(profile: BlindCheckProfile, path: string[], value: unknown): BlindCheckProfile {
  const write = (target: Record<string, unknown>, index: number): Record<string, unknown> => {
    const key = path[index];
    if (index === path.length - 1) return { ...target, [key]: value };
    return { ...target, [key]: write((target[key] as Record<string, unknown>) || {}, index + 1) };
  };
  return write(profile as unknown as Record<string, unknown>, 0) as unknown as BlindCheckProfile;
}

/**
 * 字段下方的 AI 出处提示：evidence 是值未被改动的提取结果，related 是原文有相关要求（疑似漏提或人工核对条款）但字段没有设置，
 * unspecified 是招标文件未要求、设为不检查。
 */
export type FieldSourceNote =
  | { kind: 'evidence'; extracted: BlindCheckExtractedField }
  | { kind: 'related'; sentence: string }
  | { kind: 'unspecified' };

export function fieldSourceNote(profile: BlindCheckProfile, source: BlindCheckPresetSource, path: string[]): FieldSourceNote | null {
  const key = path.join('.');
  const value = readProfileValue(profile, path);
  const extracted = source.fields[key];
  if (extracted && extracted.value === value) return { kind: 'evidence', extracted };
  if (value !== null && value !== undefined) return null;
  const omission = source.omissions?.find((item) => item.fields.includes(key));
  const manualIndex = source.manualFields?.findIndex((paths) => paths.includes(key)) ?? -1;
  const sentence = omission?.sentence || (manualIndex >= 0 ? source.manual[manualIndex] : '');
  if (sentence) return { kind: 'related', sentence };
  if (source.unspecified.includes(key)) return { kind: 'unspecified' };
  return null;
}

/** 页签里待核对的字段数，与字段下的警示提示一致：未通过核对的提取值，以及原文有相关要求但没有设置的字段。 */
export function presetTabPending(tab: BlindCheckPresetTab, profile: BlindCheckProfile, source?: BlindCheckPresetSource) {
  if (!source) return 0;
  return presetSections[tab]
    .flatMap((section) => section.fields)
    .filter((field) => field.kind !== 'words' && (!field.visible || field.visible(profile)))
    .filter((field) => {
      const note = fieldSourceNote(profile, source, field.path);
      return note?.kind === 'related' || (note?.kind === 'evidence' && !note.extracted.verified);
    }).length;
}

/** 页签第二行的摘要，只读取已保存的预设；有待核对的 AI 提取项时排在最前，摘要过长被截断时也能看到。 */
export function presetTabSummary(tab: BlindCheckPresetTab, profile: BlindCheckProfile, source?: BlindCheckPresetSource) {
  const pending = presetTabPending(tab, profile, source);
  const summary = baseTabSummary(tab, profile, source);
  return pending ? `${pending} 项待核对 · ${summary}` : summary;
}

function baseTabSummary(tab: BlindCheckPresetTab, profile: BlindCheckProfile, source?: BlindCheckPresetSource) {
  if (tab === 'page') {
    const margins = [profile.page.margin_top_cm, profile.page.margin_bottom_cm, profile.page.margin_left_cm, profile.page.margin_right_cm]
      .map((value) => (value === null ? '-' : String(value)));
    return `${profile.page.paper || '纸张不限'} · 边距 ${margins.join('/')}`;
  }
  if (tab === 'body') {
    const line = profile.body.line_rule === 'multiple'
      ? `${profile.body.line_multiple ?? '-'} 倍`
      : `${profile.body.line_rule === 'exact' ? '固定' : '最小'} ${profile.body.line_pt ?? '-'} 磅`;
    return `${profile.body.font_cn || '字体不限'} ${sizeLabel(profile.body.size_pt)} · ${line}`;
  }
  if (tab === 'headings') {
    const first = profile.headings['1'];
    const toc = profile.structure.check_toc_present === 'require' ? ' · 需要目录' : profile.structure.check_toc_present === 'forbid' ? ' · 不得有目录' : '';
    return `一级 ${sizeLabel(first.size_pt)}${first.bold === true ? '加粗' : ''}${toc}`;
  }
  if (tab === 'table') {
    return `${profile.table.check_font ? profile.table.font_cn || '字体不限' : '字体不查'} ${profile.table.check_size ? sizeLabel(profile.table.size_pt) : '字号不查'}`;
  }
  if (tab === 'source') {
    return source?.manual.length ? `人工核对 ${source.manual.length} 条` : '无需人工核对';
  }
  return `敏感词 ${profile.privacy.keywords.length} 个 · 白名单 ${profile.privacy.whitelist.length} 个`;
}
