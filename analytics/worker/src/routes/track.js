import { ALLOWED_EVENTS } from '../constants.js';
import { json, methodNotAllowed } from '../http.js';
import { isValidProjectName, normalizeMetricValue, normalizeText } from '../utils.js';

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  try {
    const body = await request.json();
    const projectName = normalizeText(body.projectName || body.project_name, 80);
    const event = normalizeText(body.event, 50);
    const page = normalizeText(body.page, 120);
    const version = normalizeText(body.version, 50);
    const platform = normalizeText(body.platform, 50);
    const arch = normalizeText(body.arch, 50);
    const clientId = normalizeText(body.client_id || body.clientId, 120);
    const clientCreatedAt = normalizeText(body.client_created_at || body.clientCreatedAt, 20);
    const fileParserProvider = normalizeText(body.file_parser_provider || body.fileParserProvider, 50);
    const realTimeRender = normalizeMetricValue(body.real_time_render ?? body.realTimeRender, 20);
    const imageProvider = normalizeText(body.image_provider || body.imageProvider, 50);
    const imageModelStatus = normalizeText(body.image_model_status || body.imageModelStatus, 50);
    const bidAnalysisMode = normalizeText(body.bid_analysis_mode || body.bidAnalysisMode, 50);
    const outlineMode = normalizeText(body.outline_mode || body.outlineMode, 50);
    const tableRequirement = normalizeText(body.table_requirement || body.tableRequirement, 50);
    const useMermaidImages = normalizeMetricValue(body.use_mermaid_images ?? body.useMermaidImages, 20);
    const useAiImages = normalizeMetricValue(body.use_ai_images ?? body.useAiImages, 20);
    const textModelName = normalizeText(body.text_model_name || body.textModelName, 120);
    const imageModelName = normalizeText(body.image_model_name || body.imageModelName, 120);
    const aiRequestType = normalizeText(body.ai_request_type || body.aiRequestType, 20);
    const aiModelProvider = normalizeText(body.ai_model_provider || body.aiModelProvider, 80);
    const aiModelBaseUrl = normalizeText(body.ai_model_base_url || body.aiModelBaseUrl, 200);
    const aiModelName = normalizeText(body.ai_model_name || body.aiModelName, 160);
    const promptTokens = normalizeTokenNumber(body.prompt_tokens ?? body.promptTokens);
    const completionTokens = normalizeTokenNumber(body.completion_tokens ?? body.completionTokens);
    const totalTokens = normalizeTokenNumber(body.total_tokens ?? body.totalTokens) || promptTokens + completionTokens;
    const normalizedTextModelName = textModelName || (aiRequestType === 'text' ? aiModelName : '');
    const normalizedImageModelName = imageModelName || (aiRequestType === 'image' ? aiModelName : '');
    const modelProviderBlob = event === 'ai_request' ? aiModelProvider : fileParserProvider;
    const modelBaseUrlBlob = event === 'ai_request' ? aiModelBaseUrl : realTimeRender;
    const modelNameBlob = event === 'ai_request' ? aiModelName : imageProvider;
    const requestTypeBlob = event === 'ai_request' ? aiRequestType : imageModelStatus;

    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }

    if (!ALLOWED_EVENTS.has(event)) {
      return json({ code: 400, message: 'invalid event' }, { status: 400 });
    }

    if (event === 'page_view' && !page) {
      return json({ code: 400, message: 'missing page' }, { status: 400 });
    }

    env.ANALYTICS.writeDataPoint({
      blobs: [
        projectName,
        event,
        page,
        version,
        platform,
        arch,
        clientId,
        clientCreatedAt,
        modelProviderBlob,
        modelBaseUrlBlob,
        modelNameBlob,
        requestTypeBlob,
        bidAnalysisMode,
        outlineMode,
        tableRequirement,
        useMermaidImages,
        useAiImages,
        normalizedTextModelName,
        normalizedImageModelName,
        aiRequestType,
      ],
      doubles: [1, promptTokens, completionTokens, totalTokens],
      indexes: [projectName],
    });

    return json({ code: 0 });
  } catch {
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}
