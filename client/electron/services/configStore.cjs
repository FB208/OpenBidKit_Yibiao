const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfigFilePath } = require('../utils/paths.cjs');

const textModelProviders = ['jinlong', 'volcengine', 'deepseek', 'longcat', 'agnes', 'custom'];
const imageModelProviders = ['jinlong', 'volcengine', 'google-ai-studio', 'agnes', 'custom'];
const aiRequestModes = ['normal', 'stream'];
const updateChannels = ['github', 'cloudflare'];
const DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;
const openAICompatibleImageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'];
const googleImageSizes = ['512', '1K', '2K', '4K'];

const textProviderBaseUrls = {
  jinlong: 'https://jlaudeapi.com/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com',
  longcat: 'https://api.longcat.chat/openai/v1',
  agnes: 'https://apihub.agnes-ai.com/v1',
  custom: '',
};

const defaultTextModelProfiles = {
  jinlong: {
    api_key: '',
    base_url: textProviderBaseUrls.jinlong,
    model_name: 'gpt-3.5-turbo',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
  volcengine: {
    api_key: '',
    base_url: textProviderBaseUrls.volcengine,
    model_name: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
  deepseek: {
    api_key: '',
    base_url: textProviderBaseUrls.deepseek,
    model_name: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
  longcat: {
    api_key: '',
    base_url: textProviderBaseUrls.longcat,
    model_name: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
  agnes: {
    api_key: '',
    base_url: textProviderBaseUrls.agnes,
    model_name: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
  custom: {
    api_key: '',
    base_url: '',
    model_name: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    request_mode: 'stream',
  },
};

const defaultImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://img-api.jlaudeapi.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    image_size: '1K',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  agnes: {
    provider: 'agnes',
    base_url: 'https://apihub.agnes-ai.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const defaultExportFormat = {
  template_name: '默认模版',
  page: {
    paper_size: 'a4',
    orientation: 'portrait',
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
    footer_enabled: false,
    footer_text: '',
    footer_distance_cm: 1.75,
    footer_font: '宋体',
    footer_size: '小五',
    footer_alignment: '居中对齐',
    footer_color: '#536176',
    page_number_enabled: false,
    page_number_format: '第{page}页',
    page_number_start: 1,
  },
  heading_level1_page_break_before: false,
  heading_border: {
    enabled: false,
    border_color: '#2174fd',
    structure: '上下结构',
  },
  headings: [
    { font: '黑体', size: '小二', alignment: '居中对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '第{zh}章' },
    { font: '黑体', size: '四号', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 1.5, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '第{zh}节' },
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '{zh}、' },
    { font: '楷体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '（{zh}）' },
    { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '{num}、' },
    { font: '宋体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 2, line_spacing: 1, numbering_format: 'outline-decimal', numbering_template: '({num})' },
  ],
  body_text: {
    font: '宋体',
    size: '小四',
    alignment: '两端对齐',
    spacing_before_pt: 0,
    spacing_after_pt: 0,
    first_line_indent_chars: 2,
    line_spacing_multiple: 1.2,
    list_style: 'disc',
    list_indent_chars: 2,
  },
  table: {
    border_width: 1,
    border_color: '#dcdff6',
    cell_padding_pt: 6,
    full_width: true,
    header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#eef5ff' },
    first_column: { font: '黑体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#f8fbff' },
    body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
  },
  image: {
    max_width_percent: 90,
    alignment: '居中对齐',
    caption_font: '宋体',
    caption_size: '小五',
    caption_alignment: '居中对齐',
  },
};

const defaultConfig = {
  text_model_provider: 'jinlong',
  text_model_profiles: defaultTextModelProfiles,
  api_key: '',
  base_url: textProviderBaseUrls.jinlong,
  model_name: 'gpt-3.5-turbo',
  context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
  concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
  request_mode: 'stream',
  image_model: {
    ...defaultImageModelProfiles.jinlong,
  },
  image_model_profiles: defaultImageModelProfiles,
  file_parser: {
    provider: 'local',
    mineru_token: '',
  },
  update_channel: 'github',
  gpu_hardware_acceleration_enabled: true,
  gpu_hardware_acceleration_configured: true,
  export_format: defaultExportFormat,
  developer_mode: false,
  developer_token_stats_auto_open: false,
  analytics_client_id: '',
  analytics_created_at: '',
};

function createAnalyticsClientId() {
  return crypto.randomUUID();
}

function createAnalyticsCreatedAt() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isTextModelProvider(value) {
  return textModelProviders.includes(value);
}

function isImageModelProvider(value) {
  return imageModelProviders.includes(value);
}

function normalizeAiRequestMode(value, fallback = 'stream') {
  return aiRequestModes.includes(value) ? value : fallback;
}

function normalizeUpdateChannel(value, fallback = defaultConfig.update_channel) {
  return updateChannels.includes(value) ? value : fallback;
}

function normalizeTextContextLengthLimit(value, fallback = DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeTextConcurrencyLimit(value, fallback = DEFAULT_TEXT_CONCURRENCY_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function normalizeImageConcurrencyLimit(value, fallback = DEFAULT_IMAGE_CONCURRENCY_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function normalizeTextModelProfile(provider, profile) {
  const defaults = defaultTextModelProfiles[provider];
  const source = profile || {};
  const sourceBaseUrl = provider === 'custom'
    ? source.base_url !== undefined ? source.base_url : defaults.base_url
    : defaults.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : defaults.api_key,
    base_url: sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : defaults.model_name,
    context_length_limit: normalizeTextContextLengthLimit(source.context_length_limit, defaults.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(source.concurrency_limit, defaults.concurrency_limit),
    request_mode: normalizeAiRequestMode(source.request_mode, defaults.request_mode),
  };
}

function normalizeTextModelProfiles(sourceProfiles) {
  const profiles = {};
  textModelProviders.forEach((provider) => {
    profiles[provider] = normalizeTextModelProfile(
      provider,
      sourceProfiles && typeof sourceProfiles === 'object' ? sourceProfiles[provider] : null,
    );
  });
  return profiles;
}

function textProfileFromFlatConfig(source, fallback, provider) {
  const sourceBaseUrl = provider === 'custom'
    ? source.base_url !== undefined ? source.base_url : fallback.base_url
    : fallback.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : fallback.api_key,
    base_url: sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : fallback.model_name,
    context_length_limit: normalizeTextContextLengthLimit(source.context_length_limit !== undefined ? source.context_length_limit : fallback.context_length_limit, fallback.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(source.concurrency_limit !== undefined ? source.concurrency_limit : fallback.concurrency_limit, fallback.concurrency_limit),
    request_mode: normalizeAiRequestMode(source.request_mode !== undefined ? source.request_mode : fallback.request_mode, fallback.request_mode),
  };
}

function hasTextModelProfileData(profile) {
  return Boolean(profile && ['api_key', 'base_url', 'model_name'].some((key) => String(profile[key] || '').trim()));
}

function getSourceTextModelProfiles(source) {
  return source.text_model_profiles && typeof source.text_model_profiles === 'object'
    ? source.text_model_profiles
    : {};
}

function pickTextProfileField(primary, secondary, fallback) {
  if (primary !== undefined && String(primary).trim()) return primary;
  if (secondary !== undefined && String(secondary).trim()) return secondary;
  if (primary !== undefined) return primary;
  if (secondary !== undefined) return secondary;
  return fallback;
}

function textProfileFromUnknownProvider(source, sourceProvider, fallback) {
  const sourceProfiles = getSourceTextModelProfiles(source);
  const selectedProfile = sourceProvider ? sourceProfiles[sourceProvider] : null;
  return {
    api_key: pickTextProfileField(source.api_key, selectedProfile?.api_key, fallback.api_key),
    base_url: pickTextProfileField(source.base_url, selectedProfile?.base_url, fallback.base_url),
    model_name: pickTextProfileField(source.model_name, selectedProfile?.model_name, fallback.model_name),
    context_length_limit: normalizeTextContextLengthLimit(pickTextProfileField(source.context_length_limit, selectedProfile?.context_length_limit, fallback.context_length_limit), fallback.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(pickTextProfileField(source.concurrency_limit, selectedProfile?.concurrency_limit, fallback.concurrency_limit), fallback.concurrency_limit),
    request_mode: normalizeAiRequestMode(pickTextProfileField(source.request_mode, selectedProfile?.request_mode, fallback.request_mode), fallback.request_mode),
  };
}

function getImageSizeOptions(provider) {
  return provider === 'google-ai-studio' ? googleImageSizes : openAICompatibleImageSizes;
}

function normalizeImageSize(provider, value, fallback) {
  const options = getImageSizeOptions(provider);
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (options.includes(candidate)) {
    return candidate;
  }

  const fallbackCandidate = typeof fallback === 'string' ? fallback.trim() : '';
  if (options.includes(fallbackCandidate)) {
    return fallbackCandidate;
  }

  return provider === 'google-ai-studio' ? '1K' : '1024x1024';
}

function normalizeImageModelProfile(provider, profile) {
  const defaults = defaultImageModelProfiles[provider];
  const source = profile || {};
  return {
    provider,
    base_url: provider === 'custom'
      ? source.base_url !== undefined ? source.base_url : defaults.base_url
      : defaults.base_url,
    api_key: source.api_key !== undefined ? source.api_key : defaults.api_key,
    model_name: source.model_name !== undefined ? source.model_name : defaults.model_name,
    image_size: normalizeImageSize(provider, source.image_size, defaults.image_size),
    request_mode: normalizeAiRequestMode(source.request_mode, defaults.request_mode),
    concurrency_limit: normalizeImageConcurrencyLimit(source.concurrency_limit, defaults.concurrency_limit),
    status: source.status !== undefined ? source.status : defaults.status,
    tested_at: source.tested_at !== undefined ? source.tested_at : defaults.tested_at,
    last_error: source.last_error !== undefined ? source.last_error : defaults.last_error,
  };
}

function normalizeImageModelProfiles(sourceProfiles) {
  const profiles = {};
  imageModelProviders.forEach((provider) => {
    profiles[provider] = normalizeImageModelProfile(
      provider,
      sourceProfiles && typeof sourceProfiles === 'object' ? sourceProfiles[provider] : null,
    );
  });
  return profiles;
}

const VALID_NUMBERING_FORMATS = ['outline-decimal', 'custom'];
const VALID_HEADING_BORDER_STRUCTURES = ['上下结构', '左右结构'];
const VALID_LIST_STYLES = ['disc', 'dash', 'circle', 'square'];

function cloneDefaultExportFormat(def = defaultExportFormat) {
  return {
    template_name: def.template_name,
    page: { ...def.page },
    heading_level1_page_break_before: def.heading_level1_page_break_before,
    heading_border: { ...def.heading_border },
    headings: def.headings.map((heading) => ({ ...heading })),
    body_text: { ...def.body_text },
    table: {
      border_width: def.table.border_width,
      border_color: def.table.border_color,
      cell_padding_pt: def.table.cell_padding_pt,
      full_width: def.table.full_width,
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
  };
}

function normalizeExportFormat(source) {
  const def = defaultExportFormat;
  if (!source || typeof source !== 'object') return cloneDefaultExportFormat(def);

  const srcPage = source.page && typeof source.page === 'object' ? source.page : {};
  const page = {
    paper_size: ['a4','a3','a5','b4','b5','letter','legal','16k'].includes(srcPage.paper_size) ? srcPage.paper_size : def.page.paper_size,
    orientation: ['portrait', 'landscape'].includes(srcPage.orientation) ? srcPage.orientation : def.page.orientation,
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
  };

  const srcHeadingBorder = source.heading_border && typeof source.heading_border === 'object' ? source.heading_border : {};
  const heading_border = {
    enabled: typeof srcHeadingBorder.enabled === 'boolean' ? srcHeadingBorder.enabled : def.heading_border.enabled,
    border_color: typeof srcHeadingBorder.border_color === 'string' && srcHeadingBorder.border_color ? srcHeadingBorder.border_color : def.heading_border.border_color,
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
    spacing_before_pt: typeof srcBody.spacing_before_pt === 'number' ? srcBody.spacing_before_pt : def.body_text.spacing_before_pt,
    spacing_after_pt: typeof srcBody.spacing_after_pt === 'number' ? srcBody.spacing_after_pt : def.body_text.spacing_after_pt,
    first_line_indent_chars: typeof srcBody.first_line_indent_chars === 'number' ? srcBody.first_line_indent_chars : def.body_text.first_line_indent_chars,
    line_spacing_multiple: typeof srcBody.line_spacing_multiple === 'number' ? srcBody.line_spacing_multiple : def.body_text.line_spacing_multiple,
    list_style: typeof srcBody.list_style === 'string' && VALID_LIST_STYLES.includes(srcBody.list_style) ? srcBody.list_style : def.body_text.list_style,
    list_indent_chars: typeof srcBody.list_indent_chars === 'number' ? srcBody.list_indent_chars : def.body_text.list_indent_chars,
  };

  const srcTable = source.table && typeof source.table === 'object' ? source.table : {};
  const table = {
    border_width: typeof srcTable.border_width === 'number' ? srcTable.border_width : def.table.border_width,
    border_color: typeof srcTable.border_color === 'string' && srcTable.border_color ? srcTable.border_color : def.table.border_color,
    cell_padding_pt: typeof srcTable.cell_padding_pt === 'number' ? srcTable.cell_padding_pt : def.table.cell_padding_pt,
    full_width: typeof srcTable.full_width === 'boolean' ? srcTable.full_width : def.table.full_width,
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

function normalizeConfig(config) {
  const source = config || {};
  const fileParser = source.file_parser ? source.file_parser : {};
  const hasTextProvider = Object.prototype.hasOwnProperty.call(source, 'text_model_provider');
  const rawTextProvider = typeof source.text_model_provider === 'string' ? source.text_model_provider : '';
  const sourceTextProvider = isTextModelProvider(rawTextProvider)
    ? rawTextProvider
    : '';
  const textModelProvider = sourceTextProvider || (hasTextProvider || config ? 'custom' : defaultConfig.text_model_provider);
  const textModelProfiles = normalizeTextModelProfiles(source.text_model_profiles);
  if (sourceTextProvider) {
    textModelProfiles[textModelProvider] = textProfileFromFlatConfig(source, textModelProfiles[textModelProvider], textModelProvider);
  } else if (textModelProvider === 'custom' && !hasTextModelProfileData(textModelProfiles.custom)) {
    textModelProfiles.custom = textProfileFromUnknownProvider(source, rawTextProvider, textModelProfiles.custom);
  }
  const activeTextProfile = textModelProfiles[textModelProvider];
  const sourceImageModel = source.image_model && typeof source.image_model === 'object' ? source.image_model : {};
  const imageModelProvider = isImageModelProvider(sourceImageModel.provider) ? sourceImageModel.provider : defaultConfig.image_model.provider;
  const imageModelProfiles = normalizeImageModelProfiles(source.image_model_profiles);
  imageModelProfiles[imageModelProvider] = normalizeImageModelProfile(imageModelProvider, sourceImageModel);
  const activeImageProfile = imageModelProfiles[imageModelProvider];
  const hasGpuHardwareAccelerationEnabled = typeof source.gpu_hardware_acceleration_enabled === 'boolean';
  const hasGpuHardwareAccelerationConfigured = typeof source.gpu_hardware_acceleration_configured === 'boolean';
  const gpuHardwareAccelerationConfigured = hasGpuHardwareAccelerationConfigured
    ? source.gpu_hardware_acceleration_configured
    : defaultConfig.gpu_hardware_acceleration_configured;
  const gpuHardwareAccelerationEnabled = gpuHardwareAccelerationConfigured === false
    ? defaultConfig.gpu_hardware_acceleration_enabled
    : hasGpuHardwareAccelerationEnabled ? source.gpu_hardware_acceleration_enabled : defaultConfig.gpu_hardware_acceleration_enabled;

  return {
    ...defaultConfig,
    text_model_provider: textModelProvider,
    text_model_profiles: textModelProfiles,
    api_key: activeTextProfile.api_key,
    base_url: activeTextProfile.base_url,
    model_name: activeTextProfile.model_name,
    context_length_limit: activeTextProfile.context_length_limit,
    concurrency_limit: activeTextProfile.concurrency_limit,
    request_mode: activeTextProfile.request_mode,
    image_model: activeImageProfile,
    image_model_profiles: imageModelProfiles,
    file_parser: {
      provider: fileParser.provider || defaultConfig.file_parser.provider,
      mineru_token: fileParser.mineru_token || defaultConfig.file_parser.mineru_token,
    },
    update_channel: normalizeUpdateChannel(source.update_channel),
    gpu_hardware_acceleration_enabled: gpuHardwareAccelerationEnabled,
    gpu_hardware_acceleration_configured: gpuHardwareAccelerationConfigured === false ? true : gpuHardwareAccelerationConfigured,
    export_format: normalizeExportFormat(source.export_format),
    developer_mode: source.developer_mode === undefined ? defaultConfig.developer_mode : Boolean(source.developer_mode),
    developer_token_stats_auto_open: source.developer_token_stats_auto_open === undefined ? defaultConfig.developer_token_stats_auto_open : Boolean(source.developer_token_stats_auto_open),
    analytics_client_id: source.analytics_client_id || defaultConfig.analytics_client_id,
    analytics_created_at: source.analytics_created_at || defaultConfig.analytics_created_at,
  };
}

function createConfigStore(app) {
  const configFile = getConfigFilePath(app);

  function persist(config) {
    let tempFile = '';
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    try {
      tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), 'utf-8');
      fs.renameSync(tempFile, configFile);
    } catch (error) {
      if (tempFile) {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
      throw error;
    }
  }

  function withAnalyticsIdentity(config) {
    if (config.analytics_client_id && config.analytics_created_at) {
      return config;
    }

    return {
      ...config,
      analytics_client_id: config.analytics_client_id || createAnalyticsClientId(),
      analytics_created_at: config.analytics_created_at || createAnalyticsCreatedAt(),
    };
  }

  return {
    getConfigFilePath() {
      return configFile;
    },

    load() {
      if (!fs.existsSync(configFile)) {
        const config = withAnalyticsIdentity(normalizeConfig());
        persist(config);
        return config;
      }

      try {
        const raw = fs.readFileSync(configFile, 'utf-8');
        const parsedConfig = JSON.parse(raw);
        const config = normalizeConfig(parsedConfig);
        const nextConfig = withAnalyticsIdentity(config);
        if (JSON.stringify(parsedConfig) !== JSON.stringify(nextConfig)) {
          persist(nextConfig);
        }
        return nextConfig;
      } catch (error) {
        throw new Error(`配置文件读取失败：${error.message}`);
      }
    },

    save(config) {
      try {
        const currentConfig = fs.existsSync(configFile)
          ? normalizeConfig(JSON.parse(fs.readFileSync(configFile, 'utf-8')))
          : normalizeConfig();
        const nextConfig = withAnalyticsIdentity(normalizeConfig({
          ...currentConfig,
          ...config,
          text_model_profiles: {
            ...currentConfig.text_model_profiles,
            ...(config && config.text_model_profiles ? config.text_model_profiles : {}),
          },
          image_model_profiles: {
            ...currentConfig.image_model_profiles,
            ...(config && config.image_model_profiles ? config.image_model_profiles : {}),
          },
          analytics_client_id: config?.analytics_client_id || currentConfig.analytics_client_id,
          analytics_created_at: config?.analytics_created_at || currentConfig.analytics_created_at,
        }));
        persist(nextConfig);
        return { success: true, message: '配置已保存', config_path: configFile };
      } catch (error) {
        throw new Error(`配置文件保存失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createConfigStore,
};
