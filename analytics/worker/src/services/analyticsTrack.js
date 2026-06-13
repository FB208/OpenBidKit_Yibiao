import { ALLOWED_EVENTS } from '../constants.js';
import { isValidProjectName, normalizeMetricValue, normalizeText } from '../utils.js';

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeNumberMetricValue(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const number = Number(text);
  if (!Number.isFinite(number)) return '';

  return String(Math.max(0, Math.round(number))).slice(0, maxLength);
}

function normalizeBaseUrlHost(value) {
  const text = normalizeText(value, 200);
  if (!text) return '';

  try {
    return normalizeText(new URL(text).hostname.toLowerCase(), 120);
  } catch {
    return normalizeText(text.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase(), 120);
  }
}

function createMetricBlobs(event) {
  const modelProviderBlob = event.event === 'ai_request'
    ? event.aiModelProvider
    : event.event === 'resource_click'
      ? event.resourceKey
      : event.fileParserProvider;
  const modelBaseUrlBlob = event.event === 'ai_request'
    ? event.aiModelEndpointHost
    : event.event === 'config_usage'
      ? event.enableConsistencyAudit
      : '';
  const modelNameBlob = event.event === 'ai_request' ? event.aiModelName : event.imageProvider;
  const requestTypeBlob = event.event === 'ai_request' ? event.aiRequestType : event.imageModelStatus;
  const contentConcurrencyBlob = event.event === 'config_usage' ? event.contentConcurrency : event.textModelName;
  const contentGenerationActionBlob = event.event === 'config_usage' ? event.contentGenerationAction : event.imageModelName;
  const minimumWordsBlob = event.event === 'config_usage' ? event.minimumWords : event.aiRequestType;

  return [
    event.projectName,
    event.event,
    event.page,
    event.version,
    event.platform,
    event.arch,
    event.clientId,
    event.clientCreatedAt,
    modelProviderBlob,
    modelBaseUrlBlob,
    modelNameBlob,
    requestTypeBlob,
    event.bidAnalysisMode,
    event.outlineMode,
    event.tableRequirement,
    event.useMermaidImages,
    event.useAiImages,
    contentConcurrencyBlob,
    contentGenerationActionBlob,
    minimumWordsBlob,
  ];
}

export function normalizeTrackBody(body) {
  const promptTokens = normalizeTokenNumber(body.prompt_tokens ?? body.promptTokens);
  const completionTokens = normalizeTokenNumber(body.completion_tokens ?? body.completionTokens);
  const totalTokens = normalizeTokenNumber(body.total_tokens ?? body.totalTokens) || promptTokens + completionTokens;
  const aiRequestType = normalizeText(body.ai_request_type || body.aiRequestType, 20);
  const aiModelName = normalizeText(body.ai_model_name || body.aiModelName, 160);
  const textModelName = normalizeText(body.text_model_name || body.textModelName, 120) || (aiRequestType === 'text' ? aiModelName : '');
  const imageModelName = normalizeText(body.image_model_name || body.imageModelName, 120) || (aiRequestType === 'image' ? aiModelName : '');

  const event = {
    projectName: normalizeText(body.projectName || body.project_name, 80),
    event: normalizeText(body.event, 50),
    page: normalizeText(body.page, 120),
    version: normalizeText(body.version, 50),
    platform: normalizeText(body.platform, 50),
    arch: normalizeText(body.arch, 50),
    clientId: normalizeText(body.client_id || body.clientId, 120),
    clientCreatedAt: normalizeText(body.client_created_at || body.clientCreatedAt, 20).slice(0, 10),
    fileParserProvider: normalizeText(body.file_parser_provider || body.fileParserProvider, 50),
    imageProvider: normalizeText(body.image_provider || body.imageProvider, 50),
    imageModelStatus: normalizeText(body.image_model_status || body.imageModelStatus, 50),
    bidAnalysisMode: normalizeText(body.bid_analysis_mode || body.bidAnalysisMode, 50),
    outlineMode: normalizeText(body.outline_mode || body.outlineMode, 50),
    tableRequirement: normalizeText(body.table_requirement || body.tableRequirement, 50),
    useMermaidImages: normalizeMetricValue(body.use_mermaid_images ?? body.useMermaidImages, 20),
    useAiImages: normalizeMetricValue(body.use_ai_images ?? body.useAiImages, 20),
    enableConsistencyAudit: normalizeMetricValue(body.enable_consistency_audit ?? body.enableConsistencyAudit, 20),
    contentConcurrency: normalizeNumberMetricValue(body.content_concurrency ?? body.contentConcurrency, 20),
    contentGenerationAction: normalizeText(body.content_generation_action || body.contentGenerationAction, 50),
    minimumWords: normalizeNumberMetricValue(body.minimum_words ?? body.minimumWords, 20),
    textModelName,
    imageModelName,
    aiRequestType,
    aiModelProvider: normalizeText(body.ai_model_provider || body.aiModelProvider, 80),
    aiModelEndpointHost: normalizeBaseUrlHost(body.ai_model_base_url || body.aiModelBaseUrl),
    aiModelName,
    resourceKey: normalizeText(body.resource_key || body.resourceKey, 80),
    promptTokens,
    completionTokens,
    totalTokens,
  };
  event.blobs = createMetricBlobs(event);
  event.doubles = [1, promptTokens, completionTokens, totalTokens];
  return event;
}

export function validateTrackEvent(event) {
  if (!isValidProjectName(event.projectName)) {
    return 'invalid projectName';
  }
  if (!ALLOWED_EVENTS.has(event.event)) {
    return 'invalid event';
  }
  if (event.event === 'page_view' && !event.page) {
    return 'missing page';
  }
  if (event.event === 'resource_click' && !/^[a-zA-Z0-9._:-]{1,80}$/.test(event.resourceKey)) {
    return 'missing resource_key';
  }
  return '';
}

export function writeAnalyticsDataPoint(env, event) {
  env.ANALYTICS.writeDataPoint({
    blobs: event.blobs,
    doubles: event.doubles,
    indexes: [event.projectName],
  });
}
