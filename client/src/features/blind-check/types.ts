export type BlindCheckStep = 'upload' | 'preset' | 'results' | 'fix';

export type BlindCheckPresetTab = 'page' | 'body' | 'headings' | 'table' | 'privacy' | 'source';

/** 问题分类；other 放无法归入前几类的问题，如需人工核对的招标条款。 */
export type BlindCheckCategory = 'privacy' | 'structure' | 'page' | 'paragraph' | 'font' | 'text' | 'table' | 'consistency' | 'image' | 'other';

/** 结果页筛选：全部或按问题类别。 */
export type BlindCheckResultTab = 'all' | BlindCheckCategory;

export type BlindCheckSeverity = 'high' | 'medium' | 'low';

export type BlindCheckResultStatus = 'idle' | 'running' | 'success' | 'error';

export type BlindCheckLineRule = 'exact' | 'atLeast' | 'multiple';

export type BlindCheckAlignment = 'left' | 'center' | 'right' | 'both';

export type BlindCheckTocMode = 'ignore' | 'hint' | 'forbid' | 'require';
/** 页码：forbid 不得有页码；footer_only 页脚只准出现页码；null 不限。 */
export type BlindCheckPageNumberMode = 'forbid' | 'footer_only' | null;

export interface BlindCheckHeadingTarget {
  font_cn: string | null;
  size_pt: number | null;
  bold: boolean | null;
}

/** 格式预设：字段沿用检查引擎的档案结构，null 表示该项不检查（招标文件未要求）；表格加粗的 null 表示同正文。 */
export interface BlindCheckProfile {
  page: {
    paper: 'A4' | 'A3' | 'Letter' | null;
    margin_top_cm: number | null;
    margin_bottom_cm: number | null;
    margin_left_cm: number | null;
    margin_right_cm: number | null;
    check_orientation: boolean;
    forbid_columns: boolean;
    check_sections: boolean;
  };
  body: {
    font_cn: string | null;
    font_en: string | null;
    size_pt: number | null;
    line_rule: BlindCheckLineRule;
    line_pt: number | null;
    line_multiple: number | null;
    space_before_pt: number | null;
    space_after_pt: number | null;
    first_line_indent_chars: number | null;
    alignment: BlindCheckAlignment | null;
    allow_bold: boolean | null;
    allow_italic: boolean | null;
    allow_underline: boolean | null;
    allow_color: boolean | null;
    allow_highlight: boolean | null;
    allow_char_spacing: boolean;
    allow_font_scaling: boolean;
    check_latin_size: boolean;
    tolerance_pt: number;
    tolerance_line_pt: number;
    tolerance_indent_chars: number;
    tolerance_margin_cm: number;
    check_snap_to_grid: boolean;
    check_vert_align: boolean;
  };
  headings: Record<'1' | '2' | '3' | '4', BlindCheckHeadingTarget>;
  table: {
    check_font: boolean;
    font_cn: string | null;
    check_size: boolean;
    size_pt: number | null;
    check_first_line_indent: boolean;
    first_line_indent_chars: number | null;
    /** null 同正文。 */
    allow_bold: boolean | null;
    check_tblStyle: boolean;
    check_shading: boolean;
    check_nested: boolean;
    alignment: 'left' | 'center' | 'right' | null;
    check_merge: boolean;
  };
  structure: {
    check_empty_paragraphs: boolean | null;
    check_revisions: boolean;
    check_comments: boolean;
    check_hidden_text: boolean;
    check_header_footer: boolean;
    forbid_header_content: boolean | null;
    forbid_footer_content: boolean | null;
    page_number: BlindCheckPageNumberMode;
    /** 标题序号格式：arabic 阿拉伯数字分级（1、1.1、1.1.1）；null 不检查。 */
    heading_numbering: 'arabic' | null;
    check_toc_present: BlindCheckTocMode;
    check_textbox: boolean;
    check_hyperlink: boolean;
    check_field_codes: boolean;
    check_bookmarks: boolean;
    skip_cover: boolean;
  };
  text: {
    check_english_punct: boolean;
    check_spaces: boolean;
    space_rules: {
      strip_leading_trailing: boolean;
      remove_between_cjk: boolean;
      forbid_fullwidth_space: boolean;
    };
    check_tabs: boolean;
    check_manual_linebreak: boolean;
    check_irregular: boolean;
    check_halfwidth_brackets: boolean;
    check_fullwidth_digits: boolean;
    check_fullwidth_letters: boolean;
  };
  privacy: {
    enable_builtin: boolean;
    keywords: string[];
    regex: string[];
    whitelist: string[];
    ignore_orgs: string[];
    check_company_suffix: boolean;
    check_phone: boolean;
    check_id_card: boolean;
    check_email: boolean;
    check_url: boolean;
    check_credit_code: boolean;
    check_bank_account: boolean;
    check_placeholder: boolean;
    check_toc: boolean;
  };
  props: {
    check_author: boolean;
    check_last_modified_by: boolean;
    check_company: boolean;
    check_template: boolean;
    check_custom_props: boolean;
  };
  consistency: {
    check_heading_format: boolean;
    check_heading_numbering: boolean;
    check_heading_level_jump: boolean;
    check_heading_content: boolean;
    heading_max_chars: number;
    check_body_format: boolean;
    check_mixed_fonts: boolean;
  };
  image: {
    check_color: boolean;
    check_vector: boolean;
    check_metadata: boolean;
  };
  rules: Record<string, { enabled?: boolean; severity?: BlindCheckSeverity }>;
}

/** AI 提取的一个字段：值、招标文件原文依据、是否通过核对（依据能在原文找到且与取值一致），不一致时附原因。 */
export interface BlindCheckExtractedField {
  value: string | number | boolean | null;
  evidence: string;
  verified: boolean;
  issue?: string;
}

/** 一条疑似漏提的要求：主题、招标文件原句、可设置的字段路径。 */
export interface BlindCheckOmission {
  topic: string;
  sentence: string;
  fields: string[];
}

/** AI 从招标文件生成的预设所记录的出处。 */
export interface BlindCheckPresetSource {
  version: number;
  tenderName: string;
  extractedAt: string;
  fields: Record<string, BlindCheckExtractedField>;
  unspecified: string[];
  manual: string[];
  /** 与 manual 一一对应：每条人工核对条款关联的检查项路径。 */
  manualFields?: string[][];
  /** 原文提到、但提取结果里没有对应设置的要求（多半是 AI 漏提）。 */
  omissions?: BlindCheckOmission[];
  dropped: string[];
  notes: string;
}

export interface BlindCheckPreset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  profile: BlindCheckProfile;
  source?: BlindCheckPresetSource;
}

export interface BlindCheckTenderSources {
  technicalPlan: {
    available: boolean;
    fileName: string;
  };
}

export interface BlindCheckFile {
  id: string;
  fileName: string;
  size: number;
  modifiedAt: string;
  importedAt: string;
}

export interface BlindCheckSample {
  where: string;
  text: string;
  detail: string;
  origin: string;
  hint: string;
}

/** 带段落编号的定位条目：候选问题逐条显示 AI 复核结论用。 */
export interface BlindCheckFindingItem {
  where: string;
  text: string;
  detail: string;
  locator: string;
}

export interface BlindCheckFindingGroup {
  id?: string;
  ruleId: string;
  ruleTitle: string;
  category: BlindCheckCategory;
  severity: BlindCheckSeverity;
  message: string;
  /** 候选问题：规则只能初筛，是否真的违反要求由 AI 复核判定。 */
  candidate?: boolean;
  count: number;
  samples: BlindCheckSample[];
  items?: BlindCheckFindingItem[];
}

export type BlindCheckClauseStatus = 'pass' | 'fail' | 'unknown';

/** 招标条款对照：一条技术暗标要求、招标原文依据、是否满足和对应的问题编号。 */
export interface BlindCheckClause {
  id: string;
  requirement: string;
  basis: string;
  status: BlindCheckClauseStatus;
  explanation: string;
  issues: string[];
  /** 依据没能在招标原文（或预设出处）里核对到。 */
  basisUnverified?: boolean;
}

export type BlindCheckVerdict = 'problem' | 'not_problem' | 'uncertain';

export interface BlindCheckAiIssue {
  id: string;
  title: string;
  severity: BlindCheckSeverity;
  category: BlindCheckCategory;
  basis: string;
  detail: string;
  suggestion: string;
  /** image_part：图片位置摘录的是名称或替代文字（alt），还是图片画面里的内容（content）；unverified：摘录没能在所写段落里核对到。为空表示全文性质的问题。 */
  locations: Array<{ target: string; text: string; image_part?: 'alt' | 'content'; unverified?: boolean }>;
  /** 依据没能在招标原文（或预设出处）里核对到。 */
  basisUnverified?: boolean;
}

export interface BlindCheckReview {
  summary: string;
  clauses: BlindCheckClause[];
  /** 候选判定：键为组编号（整组）或"组编号#条目序号"（逐条）。 */
  verdicts: Record<string, { verdict: BlindCheckVerdict; reason: string }>;
  issues: BlindCheckAiIssue[];
  hasTender: boolean;
  tenderName: string;
}

export type BlindCheckReviewStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped';

export interface BlindCheckReviewState {
  status: BlindCheckReviewStatus;
  inputSignature?: string;
  tenderName?: string;
  review?: BlindCheckReview | null;
  error?: string | null;
  updatedAt?: string;
}

/** 一处出现位置：位置、原文摘录和附注（补充说明、格式来源、复核理由等）。 */
export interface BlindCheckOccurrence {
  where: string;
  text: string;
  notes: string[];
}

/**
 * 最终问题清单的一条（Main 的 buildIssueList 产出）：检查结论以复核后的结果为准，计数单位是"处"。
 * kind 区分程序规则、AI 补充和需人工核对的招标条款，只用于内部对账，界面不区分来源。
 */
export interface BlindCheckIssue {
  id: string;
  kind: 'rule' | 'ai' | 'clause';
  ruleId: string;
  category: BlindCheckCategory;
  severity: BlindCheckSeverity;
  message: string;
  count: number;
  /** 含需人工确认的位置，或本身是需人工核对的条款。 */
  uncertain: boolean;
  requirements: Array<{ text: string; unverified: boolean }>;
  explanation: string;
  hint: string;
  occurrences: BlindCheckOccurrence[];
  /** 未逐一列出的处数。 */
  more: number;
}

export interface BlindCheckFixEdit {
  issue: string;
  op: 'replace' | 'delete_paragraph' | 'clear_image_alt';
  target: string;
  before: string;
  after: string;
}

/** 修复结果的一行：修复范围内的一条问题，或修复后新出现的问题；处理情况以修复后复查为准，count = fixed + pending。 */
export interface BlindCheckFixItem {
  id: string;
  category: BlindCheckCategory;
  severity: BlindCheckSeverity;
  message: string;
  count: number;
  fixed: number;
  pending: number;
  isNew: boolean;
  reason: string;
  suggestion: string;
  pendingOccurrences: BlindCheckOccurrence[];
  edits: BlindCheckFixEdit[];
}

export interface BlindCheckFixAgent {
  status: 'success' | 'error' | 'skipped';
  reason?: string;
  error?: string;
  summary?: string;
  edits?: BlindCheckFixEdit[];
}

export interface BlindCheckSummary {
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface BlindCheckStats {
  paragraphs: number;
  bodyParagraphs: number;
  tableParagraphs: number;
  tables: number;
  sections: number;
  tocEntries: number;
  headings: number;
  headingSources: Record<string, number>;
  coverParagraphs: number;
  images: number;
  imageFormats: Record<string, number>;
  vectorImages: number;
  rulesChecked: number;
  durationMs: number;
}

export interface BlindCheckResultState {
  status: BlindCheckResultStatus;
  inputSignature?: string;
  presetName?: string;
  summary?: BlindCheckSummary | null;
  stats?: BlindCheckStats | null;
  ruleErrors?: string[];
  error?: string | null;
  updatedAt?: string;
  groups: BlindCheckFindingGroup[];
}

export interface BlindCheckFixValidation {
  checked: boolean;
  skippedReason: string;
  originalErrors: number;
  fixedErrors: number;
}

/** 自动修复结果：修复副本在工作区，原文件不改动；groups 是复查后剩余的问题。 */
export interface BlindCheckFixResultState {
  status: BlindCheckResultStatus;
  inputSignature?: string;
  fixRules?: string[];
  outputPath?: string;
  sourceBytes?: number;
  outputBytes?: number;
  fixes?: Record<string, number>;
  notes?: string[];
  validation?: BlindCheckFixValidation;
  /** 修复范围的处数。 */
  beforeSummary?: BlindCheckSummary | null;
  /** 待人工处理的处数（含修复后新出现的）。 */
  afterSummary?: BlindCheckSummary | null;
  afterStats?: BlindCheckStats | null;
  error?: string | null;
  updatedAt?: string;
  groups: BlindCheckFindingGroup[];
  /** 修复范围内逐条的修复结论，以及修复后新出现的问题。 */
  items?: BlindCheckFixItem[];
  agent?: BlindCheckFixAgent | null;
}

export interface BlindCheckTaskState {
  task_id: string;
  type: string;
  status: 'running' | 'success' | 'error';
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: { presetId?: string; presetName?: string; fieldCount?: number; unverified?: number; omissions?: number; fewFields?: boolean };
}

export interface BlindCheckWorkspaceState {
  step: BlindCheckStep;
  presetId: string;
  presetTab: BlindCheckPresetTab;
  resultTab: BlindCheckResultTab;
  useCredentialWords: boolean;
  /** 上次检查是否选了程序检查 + AI 复核，作为检查弹窗的默认选项。 */
  aiReviewEnabled: boolean;
  /** 上次修复是否选了程序修复 + AI 修复，作为修复弹窗的默认选项。 */
  fixAiEnabled: boolean;
  file: BlindCheckFile | null;
  result: BlindCheckResultState;
  review: BlindCheckReviewState;
  /** 最终问题清单：检查成功且复核不在进行时才有，否则为空。 */
  issues: BlindCheckIssue[];
  checkTask?: BlindCheckTaskState;
  fixRules: string[];
  fixResult: BlindCheckFixResultState;
  fixTask?: BlindCheckTaskState;
  extractionTask?: BlindCheckTaskState;
}

export type BlindCheckWorkspacePatch = Partial<BlindCheckWorkspaceState>;

export interface BlindCheckCredentialWord {
  label: string;
  value: string;
}
