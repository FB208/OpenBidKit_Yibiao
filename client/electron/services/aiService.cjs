const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getGeneratedImagesDir } = require('../utils/paths.cjs');
const { createDeveloperLogger } = require('../utils/developerLog.cjs');
const { createAiRequestQueue } = require('../utils/aiRequestQueue.cjs');
const {
  copyAiRequestErrorMeta,
  isRetryableHttpStatus,
  markAiRequestError,
  runWithAiRetry,
} = require('../utils/aiRetry.cjs');
const {
  createAiRequestId: createRequestId,
  getAiErrorLogError,
  getAiErrorLogResponse,
  resolveAiLogTitle,
  writeAiLog,
} = require('../utils/aiLog.cjs');
const textTokenStatsStore = require('./textTokenStatsStore.cjs');

const AI_REQUEST_TIMEOUT_MS = 300000;
const IMAGE_MODEL_TEST_TIMEOUT_MESSAGE = '生图模型测试超时，请检查 Base URL、API Key 或模型名称';
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';
const OPENAI_IMAGE_PROVIDER_META = {
  jinlong: {
    label: '金龙中转站',
    defaultBaseUrl: 'https://img-api.jlaudeapi.com/v1',
    logProvider: 'jinlong',
    modelLabel: '生图模型名称',
  },
  volcengine: {
    label: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    logProvider: 'volcengine',
    modelLabel: '模型名称或推理接入点 ID',
  },
  agnes: {
    label: 'Agnes AI',
    defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',
    logProvider: 'agnes',
    modelLabel: '生图模型名称',
  },
  custom: {
    label: '自定义生图服务',
    defaultBaseUrl: '',
    logProvider: 'custom',
    modelLabel: '生图模型名称',
  },
};

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function requireBaseUrl(baseUrl, message) {
  const trimmed = trimBaseUrl(baseUrl);
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function isResponseFormatUnsupported(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('response_format') && [
    'not supported',
    'does not support',
    'not support',
    'unsupported',
    'unknown parameter',
    'invalid parameter',
    'must be',
  ].some((marker) => normalized.includes(marker));
}

function createModuleDeveloperLogger(app, config, moduleName, request = {}) {
  return createDeveloperLogger({
    app,
    config,
    moduleName,
    name: request.name || request.logTitle || moduleName,
    meta: request.meta || {},
  });
}

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeCachedTokenNumber(source) {
  const promptDetails = source.prompt_tokens_details
    || source.promptTokensDetails
    || source.input_token_details
    || source.inputTokenDetails
    || {};
  return normalizeTokenNumber(
    source.cached_tokens
    ?? source.cachedTokens
    ?? source.prompt_cached_tokens
    ?? source.promptCachedTokens
    ?? source.prompt_cache_hit_tokens
    ?? source.promptCacheHitTokens
    ?? source.cache_read_input_tokens
    ?? source.cacheReadInputTokens
    ?? source.cached_content_token_count
    ?? source.cachedContentTokenCount
    ?? promptDetails.cached_tokens
    ?? promptDetails.cachedTokens
    ?? promptDetails.cache_read
    ?? promptDetails.cacheRead
    ?? promptDetails.cache_read_input_tokens
    ?? promptDetails.cacheReadInputTokens
  );
}

function normalizeTokenUsage(usage) {
  const source = usage || {};
  const promptTokens = normalizeTokenNumber(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = normalizeTokenNumber(
    source.completion_tokens
    ?? source.completionTokens
    ?? source.completionTokenCount
    ?? source.candidatesTokenCount,
  );
  const totalTokens = normalizeTokenNumber(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount)
    || promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: normalizeCachedTokenNumber(source),
  };
}

function getTextTokenStatsSnapshot() {
  return textTokenStatsStore.getTextTokenStatsSnapshot();
}

function recordTextTokenStats(config, usage) {
  if (!config?.developer_mode) {
    return;
  }

  textTokenStatsStore.recordTextTokenStats(usage);
}

function resetTextTokenStats() {
  return textTokenStatsStore.resetTextTokenStats();
}

function onTextTokenStatsChanged(listener) {
  return textTokenStatsStore.onTextTokenStatsChanged(listener);
}

function normalizeAnalyticsEndpointHost(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) {
    return '';
  }

  const candidates = rawValue.includes('://') ? [rawValue] : [`https://${rawValue}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // 尝试下一个候选格式。
    }
  }

  return '';
}

function extractOpenAIUsage(responseData) {
  return normalizeTokenUsage(responseData?.usage);
}

function extractGoogleUsage(responseData) {
  return normalizeTokenUsage(responseData?.usageMetadata || responseData?.usage_metadata);
}

function normalizeRequestTimeoutMs(request) {
  const timeoutMs = Number(request?.timeout_ms);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AI_REQUEST_TIMEOUT_MS;
}

function normalizeTextRequestMode(config) {
  return config?.request_mode === 'normal' ? 'normal' : 'stream';
}

function normalizeImageRequestMode(imageConfig) {
  return imageConfig?.request_mode === 'normal' ? 'normal' : 'stream';
}

function createAbortError() {
  const error = new Error('AI 请求超时');
  error.name = 'AbortError';
  return markAiRequestError(error, { retryable: true });
}

function createOperationTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeoutPromise = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createAbortError());
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });

  return {
    signal: controller.signal,
    run(promise) {
      return Promise.race([promise, timeoutPromise]);
    },
    clear() {
      controller.abort();
    },
  };
}

async function runWithOperationTimeout(runner, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  const timeout = createOperationTimeout(timeoutMs);
  try {
    return await timeout.run(runner(timeout.signal));
  } finally {
    timeout.clear();
  }
}

function createHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function trackAiRequest(app, config, payload) {
  void Promise.resolve()
    .then(() => {
      const imageConfig = config.image_model || {};
      const requestType = payload.ai_request_type || '';
      const tokenUsage = normalizeTokenUsage(payload.usage);
      const modelProvider = requestType === 'image'
        ? imageConfig.provider || ''
        : config.text_model_provider || '';
      const modelBaseUrl = requestType === 'image'
        ? imageConfig.base_url || ''
        : config.base_url || '';
      const modelEndpointHost = normalizeAnalyticsEndpointHost(modelBaseUrl);
      const modelName = requestType === 'image'
        ? imageConfig.model_name || ''
        : config.model_name || '';
      const body = {
        projectName: ANALYTICS_PROJECT_NAME,
        event: 'ai_request',
        version: typeof app?.getVersion === 'function' ? app.getVersion() : '',
        platform: process.platform,
        arch: process.arch,
        client_id: config.analytics_client_id || '',
        client_created_at: config.analytics_created_at || '',
        ai_request_type: requestType,
        ai_model_provider: modelProvider,
        ai_model_base_url: modelEndpointHost,
        ai_model_name: modelName,
        prompt_tokens: tokenUsage.prompt_tokens,
        completion_tokens: tokenUsage.completion_tokens,
        total_tokens: tokenUsage.total_tokens,
        text_model_name: requestType === 'text' ? modelName : '',
        image_model_name: requestType === 'image' ? modelName : '',
      };

      return fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    })
    .catch(() => undefined);
}

function imageExtensionFromMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  return 'png';
}

function getImageModelAvailability(config) {
  const imageConfig = config.image_model || {};
  if (imageConfig.status !== 'available') {
    return { available: false, status: imageConfig.status || 'untested', message: '生图模型未测试可用' };
  }

  if (!imageConfig.api_key) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型 API Key' };
  }

  if (!imageConfig.model_name) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型名称' };
  }

  if (!trimBaseUrl(imageConfig.base_url)) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型 Base URL' };
  }

  return { available: true, status: 'available', message: '生图模型可用' };
}

function normalizeImagePrompt(request) {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) {
    throw new Error('生图提示词为空');
  }

  const styleHint = request.style === 'realistic_photo'
    ? '画面采用专业实景照片风格，真实、克制、适合投标技术方案插图。'
    : '画面采用工程项目图示风格，结构清晰、专业克制、适合投标技术方案插图。';
  return `${prompt}\n\n${styleHint}\n避免出现品牌标识、水印、夸张营销元素和无关文字。`;
}

function safeImageResponse(data) {
  return {
    ...data,
    data: Array.isArray(data?.data)
      ? data.data.map((item) => ({ ...item, b64_json: item.b64_json ? '[base64 omitted]' : item.b64_json }))
      : data?.data,
    candidates: Array.isArray(data?.candidates) ? '[candidates omitted]' : data?.candidates,
  };
}

function copyRawAiErrorResponse(source, target) {
  for (const key of ['raw_response_body', 'raw_response_payload', 'raw_response_data', 'raw_sse_data']) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

function createAiResponseDataError(message, responseData) {
  const error = new Error(message);
  error.raw_response_data = responseData;
  return error;
}

async function downloadImage(url) {
  let response = null;
  try {
    response = await fetch(url);
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  await ensureOk(response, '图片下载失败');
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mime_type: response.headers.get('content-type') || 'image/png',
  };
}

function saveGeneratedImage(app, image) {
  const imagesDir = getGeneratedImagesDir(app);
  fs.mkdirSync(imagesDir, { recursive: true });
  const extension = imageExtensionFromMime(image.mime_type);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.${extension}`;
  const filePath = path.join(imagesDir, fileName);
  fs.writeFileSync(filePath, image.buffer);
  return {
    asset_url: `yibiao-asset://generated-images/${encodeURIComponent(fileName)}`,
    file_path: filePath,
    mime_type: image.mime_type,
  };
}

async function ensureOk(response, fallbackMessage) {
  if (response.ok) {
    return;
  }

  let detail = '';
  const rawText = await response.text().catch(() => '');
  try {
    const body = rawText ? JSON.parse(rawText) : null;
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = rawText;
  }

  const error = new Error(detail || fallbackMessage);
  if (response.status) {
    error.status = response.status;
    error.statusCode = response.status;
  }
  error.raw_response_body = rawText;
  throw markAiRequestError(error, { retryable: isRetryableHttpStatus(response.status) });
}

async function fetchOpenAICompatibleImageResponse(baseUrl, apiKey, requestBody, fallbackMessage, options = {}) {
  const sendRequest = async (body) => {
    try {
      return await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: createHeaders(apiKey),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      throw markAiRequestError(error, { retryable: true });
    }
  };
  const response = await sendRequest(requestBody);
  if (response.ok) {
    return response;
  }

  let detail = '';
  const rawText = await response.text().catch(() => '');
  try {
    const body = rawText ? JSON.parse(rawText) : null;
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = rawText;
  }

  if (requestBody.response_format && isResponseFormatUnsupported(detail)) {
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    const retryResponse = await sendRequest(retryBody);
    await ensureOk(retryResponse, fallbackMessage);
    return retryResponse;
  }

  const error = new Error(detail || fallbackMessage);
  if (response.status) {
    error.status = response.status;
    error.statusCode = response.status;
  }
  error.raw_response_body = rawText;
  throw markAiRequestError(error, { retryable: isRetryableHttpStatus(response.status) });
}

function extractJsonContent(content) {
  const normalized = String(content || '').trim();
  if (!normalized.startsWith('```')) {
    return normalized;
  }

  const lines = normalized.split(/\r?\n/);
  const firstLine = (lines[0] || '').trim().toLowerCase();
  const lastLine = (lines[lines.length - 1] || '').trim();
  if ((firstLine === '```' || firstLine === '```json') && lastLine.startsWith('```')) {
    return lines.slice(1, -1).join('\n').trim();
  }

  return normalized;
}

function extractFencedJsonBlocks(content) {
  const blocks = [];
  const normalized = String(content || '').trim();
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRegex.exec(normalized);

  while (match) {
    const block = String(match[1] || '').trim();
    if (block) {
      blocks.push(block);
    }
    match = fenceRegex.exec(normalized);
  }

  return blocks;
}

function extractBalancedJsonCandidates(content) {
  const text = String(content || '');
  const candidates = [];

  for (let start = 0; start < text.length; start += 1) {
    const firstChar = text[start];
    if (firstChar !== '{' && firstChar !== '[') {
      continue;
    }

    const stack = [firstChar];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char === '}' || char === ']') {
        const expectedOpen = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expectedOpen) {
          break;
        }

        stack.pop();
        if (!stack.length) {
          const candidate = text.slice(start, index + 1).trim();
          if (candidate) {
            candidates.push(candidate);
          }
          start = index;
          break;
        }
      }
    }
  }

  return candidates;
}

const jsonEscapeChars = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const markdownEscapeChars = new Set(['.', '(', ')', '[', ']', '{', '}', '#', '*', '+', '-', '_', '!', '<', '>', '|', '`']);

function repairInvalidJsonStringEscapes(content) {
  const text = String(content || '');
  let output = '';
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!inString) {
      output += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }

    if (char !== '\\') {
      output += char;
      continue;
    }

    const nextChar = text[index + 1] || '';
    if (!nextChar) {
      output += '\\\\';
      continue;
    }

    if (nextChar === 'u') {
      const unicodeDigits = text.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
        output += text.slice(index, index + 6);
        index += 5;
      } else {
        output += '\\\\';
      }
      continue;
    }

    if (jsonEscapeChars.has(nextChar)) {
      output += char + nextChar;
      index += 1;
      continue;
    }

    if (markdownEscapeChars.has(nextChar)) {
      output += nextChar;
      index += 1;
      continue;
    }

    output += '\\\\';
  }

  return output;
}

function parseJsonContent(content) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').trim();
  const candidates = [
    normalized,
    extractJsonContent(normalized),
    ...extractFencedJsonBlocks(normalized),
  ].filter(Boolean);

  const withBalancedCandidates = [];
  for (const candidate of candidates) {
    withBalancedCandidates.push(candidate);
    withBalancedCandidates.push(...extractBalancedJsonCandidates(candidate));
  }

  const repairedCandidates = [];
  for (const candidate of withBalancedCandidates) {
    const repaired = repairInvalidJsonStringEscapes(candidate);
    if (repaired !== candidate) {
      repairedCandidates.push(repaired);
    }
  }

  const uniqueCandidates = [...new Set([...withBalancedCandidates, ...repairedCandidates].map((item) => item.trim()).filter(Boolean))];
  let lastError = null;

  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('AI 返回内容为空，无法解析 JSON');
}

function formatJsonIssues(error) {
  if (error instanceof SyntaxError) {
    return [`JSON 语法错误：${error.message}`];
  }

  return [error?.message || String(error || '字段校验失败')];
}

function buildJsonRepairMessages(invalidContent, issues, targetDescription) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'system',
      content: `你是一个严格的 JSON 修复助手。请根据给出的原始内容和校验问题，修复现有结果。

要求：
1. 优先在原结果基础上做最小必要修改，不要整体重写
2. 尽量保留原有结构、字段值、节点顺序和已生成内容
3. 若缺少必填字段，应结合现有上下文补齐合理内容，不要用空字符串敷衍
4. 若存在多余说明、代码块包裹、字段名错误、children 结构不规范或顶层包裹错误，应修正为合法 JSON
5. 必须修复 JSON 字符串中的非法反斜杠转义，例如将 1\\. 改为 1.，或将必须保留的反斜杠写成 \\\\
6. 只返回修复后的完整 JSON，不要输出任何解释`,
    },
    { role: 'user', content: `目标结果类型：${targetDescription}` },
    { role: 'user', content: `当前校验问题：\n${issueLines}` },
    {
      role: 'user',
      content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\``,
    },
    {
      role: 'user',
      content: '请在保留原有正确内容的前提下，仅修复上述问题，并返回完整 JSON。',
    },
  ];
}

async function emitProgress(progressCallback, message) {
  if (!progressCallback) {
    return;
  }

  await Promise.resolve(progressCallback(message));
}

function normalizeJsonPayload(request, parsed) {
  const normalized = request.normalizer ? request.normalizer(parsed) : parsed;
  if (request.validator) {
    request.validator(normalized);
  }
  return normalized;
}

async function repairJsonResponse(app, config, invalidContent, issues, temperature, responseFormat, progressCallback, progressLabel, repairMessagesBuilder, logTitle) {
  await emitProgress(progressCallback, `${progressLabel}格式校验失败，正在基于当前结果进行修复。`);
  return chatWithConfig(app, config, {
    messages: repairMessagesBuilder
      ? repairMessagesBuilder({ invalidContent, issues, progressLabel })
      : buildJsonRepairMessages(invalidContent, issues, progressLabel),
    temperature,
    response_format: responseFormat,
    logTitle: logTitle ? `${logTitle}修复` : `${progressLabel}修复`,
  });
}

async function parseOrRepairJsonResponseWithConfig(app, config, request, content) {
  const temperature = request.temperature ?? 0.7;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);

  try {
    return normalizeJsonPayload(request, parseJsonContent(content));
  } catch (error) {
    const issues = formatJsonIssues(error);
    try {
      const repairedContent = await repairJsonResponse(
        app,
        config,
        content,
        issues,
        temperature,
        responseFormat,
        request.progressCallback,
        progressLabel,
        request.repairMessagesBuilder,
        logTitle,
      );
      return normalizeJsonPayload(request, parseJsonContent(repairedContent));
    } catch {
      throw new Error(failureMessage);
    }
  }
}

async function collectJsonResponseWithConfig(app, config, request) {
  const maxRetries = request.max_retries ?? 2;
  const totalAttempts = maxRetries + 1;
  const temperature = request.temperature ?? 0.7;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const content = await chatWithConfig(app, config, {
      messages: request.messages,
      temperature,
      response_format: responseFormat,
      timeout_ms: request.timeout_ms,
      timeout_message: request.timeout_message,
      logTitle,
    });

    try {
      const parsed = parseJsonContent(content);
      return normalizeJsonPayload(request, parsed);
    } catch (error) {
      lastError = error;
      const issues = formatJsonIssues(error);

      try {
        const repairedContent = await repairJsonResponse(
          app,
          config,
          content,
          issues,
          temperature,
          responseFormat,
          request.progressCallback,
          progressLabel,
          request.repairMessagesBuilder,
          logTitle,
        );
        const repairedParsed = parseJsonContent(repairedContent);
        return normalizeJsonPayload(request, repairedParsed);
      } catch (repairError) {
        lastError = repairError;

        if (attempt === maxRetries) {
          await emitProgress(request.progressCallback, `${progressLabel}连续 ${totalAttempts} 次校验失败。`);
          throw new Error(failureMessage);
        }

        await emitProgress(request.progressCallback, `${progressLabel}第 ${attempt + 1}/${totalAttempts} 次校验失败，正在重试。`);
      }
    }
  }

  throw new Error(lastError?.message || failureMessage);
}

function createChatRequestBody(config, request, options = {}) {
  const body = {
    model: config.model_name,
    messages: request.messages,
  };

  if (options.stream) {
    body.stream = true;
  }

  if (request.response_format && !options.omitResponseFormat) {
    body.response_format = request.response_format;
  }

  return body;
}

async function fetchChatCompletion(app, config, body, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS) : null;
  const baseUrl = requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(config.api_key),
      body: JSON.stringify(body),
      signal: options.signal || controller.signal,
    });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createAiHttpError(detail, fallbackMessage, status, rawResponseBody = '') {
  const error = new Error(detail || fallbackMessage);
  if (status) {
    error.status = status;
    error.statusCode = status;
  }
  error.responseFormatUnsupported = isResponseFormatUnsupported(detail);
  error.raw_response_body = rawResponseBody;
  return markAiRequestError(error, { retryable: isRetryableHttpStatus(status) });
}

async function ensureTextAiResponseOk(response, fallbackMessage) {
  if (response.ok) {
    return;
  }

  let detail = '';
  const rawText = await response.text().catch(() => '');
  try {
    const body = rawText ? JSON.parse(rawText) : null;
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = rawText;
  }

  throw createAiHttpError(detail, fallbackMessage, response.status, rawText);
}

function appendStreamChoiceContent(choice, contentParts) {
  const deltaContent = choice?.delta?.content;
  const messageContent = choice?.message?.content;
  const textContent = choice?.text;

  if (typeof deltaContent === 'string') {
    contentParts.push(deltaContent);
    return;
  }

  if (typeof messageContent === 'string') {
    contentParts.push(messageContent);
    return;
  }

  if (typeof textContent === 'string') {
    contentParts.push(textContent);
  }
}

function normalizeStreamPayloadError(error, fallbackMessage) {
  if (!error) {
    return fallbackMessage;
  }

  if (typeof error === 'string') {
    return error;
  }

  return error.message || error.code || fallbackMessage;
}

async function readSseJsonDataLine(line, state, options) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
    return;
  }

  const data = trimmed.slice(5).trim();
  if (!data) {
    return;
  }

  if (data === '[DONE]') {
    state.done = true;
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    const parseError = new Error(`${options.parseErrorMessage || 'AI 流式响应解析失败'}：${error.message}`);
    parseError.raw_response_body = data;
    throw markAiRequestError(parseError, { retryable: true });
  }

  if (payload?.error && options.throwOnPayloadError !== false) {
    const streamError = new Error(normalizeStreamPayloadError(payload.error, options.failureMessage || 'AI 流式请求失败'));
    streamError.raw_response_payload = payload;
    streamError.raw_sse_data = data;
    throw markAiRequestError(streamError, { retryable: true });
  }

  await Promise.resolve(options.onPayload?.(payload));
}

async function readSseJsonStream(response, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw markAiRequestError(new Error(options.unreadableMessage || 'AI 流式响应不可读'), { retryable: true });
  }

  const decoder = new TextDecoder('utf-8');
  const state = { done: false };
  let buffer = '';

  while (!state.done) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) {
        break;
      }
    }
  }

  buffer += decoder.decode();
  if (!state.done && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) {
        break;
      }
    }
  }
}

async function readOpenAIChatStream(response) {
  const state = { usage: null, contentParts: [] };

  await readSseJsonStream(response, {
    unreadableMessage: 'AI 流式响应不可读',
    parseErrorMessage: 'AI 流式响应解析失败',
    failureMessage: 'AI 流式请求失败',
    onPayload(payload) {
      if (payload?.usage) {
        state.usage = payload.usage;
      }

      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      choices.forEach((choice) => appendStreamChoiceContent(choice, state.contentParts));
    },
  });

  const content = state.contentParts.join('');
  return {
    content,
    usage: state.usage,
    responseData: {
      stream: true,
      choices: [{ message: { content } }],
      usage: state.usage,
    },
  };
}

async function requestTextAiNormal(app, config, requestBody, options = {}) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  let responseData = null;
  try {
    responseData = await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  return {
    content: responseData.choices?.[0]?.message?.content || '',
    usage: extractOpenAIUsage(responseData),
    responseData,
  };
}

async function requestTextAiStream(app, config, requestBody, options = {}) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  return readOpenAIChatStream(response);
}

async function requestTextAi(app, config, requestBody, options = {}) {
  if (options.requestMode === 'stream') {
    return requestTextAiStream(app, config, requestBody, options);
  }

  return requestTextAiNormal(app, config, requestBody, options);
}

function appendOpenAICompatibleImageItem(state, item) {
  const url = String(item?.url || '');
  const b64Json = String(item?.b64_json || '');
  if (!url && !b64Json) {
    return;
  }

  state.images.push({
    ...item,
    url,
    b64_json: b64Json,
    mime_type: item?.mime_type || item?.mimeType || 'image/png',
  });
}

function appendOpenAICompatibleImageError(state, payload) {
  state.errors.push({
    image_index: payload?.image_index,
    code: payload?.error?.code || '',
    message: normalizeStreamPayloadError(payload?.error, '图片生成失败'),
    raw_payload: payload,
  });
}

function appendOpenAICompatibleImagePayload(payload, state) {
  if (payload?.usage) {
    state.usage = payload.usage;
  }

  if (payload?.error && payload?.type !== 'image_generation.completed' && payload?.type !== 'image_generation.partial_failed') {
    appendOpenAICompatibleImageError(state, payload);
    return;
  }

  if (payload?.type === 'image_generation.completed') {
    state.completed = payload;
    if (payload.usage) {
      state.usage = payload.usage;
    }
    if (Array.isArray(payload?.data)) {
      payload.data.forEach((item) => appendOpenAICompatibleImageItem(state, item));
    } else {
      appendOpenAICompatibleImageItem(state, payload);
    }
    if (payload.error) {
      appendOpenAICompatibleImageError(state, payload);
    }
    return;
  }

  if (payload?.type === 'image_generation.partial_failed') {
    appendOpenAICompatibleImageError(state, payload);
    return;
  }

  if (payload?.type === 'image_generation.partial_succeeded') {
    appendOpenAICompatibleImageItem(state, payload);
    return;
  }

  if (Array.isArray(payload?.data)) {
    payload.data.forEach((item) => appendOpenAICompatibleImageItem(state, item));
    return;
  }

  appendOpenAICompatibleImageItem(state, payload);
}

async function readOpenAICompatibleImageStream(response) {
  const state = { images: [], errors: [], completed: null, usage: null };

  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读',
    parseErrorMessage: '生图流式响应解析失败',
    failureMessage: '生图流式请求失败',
    throwOnPayloadError: false,
    onPayload(payload) {
      appendOpenAICompatibleImagePayload(payload, state);
    },
  });

  return {
    stream: true,
    data: state.images,
    errors: state.errors,
    completed: state.completed,
    usage: state.usage,
  };
}

async function requestOpenAICompatibleImageData(baseUrl, apiKey, requestBody, fallbackMessage, options = {}) {
  const response = await fetchOpenAICompatibleImageResponse(baseUrl, apiKey, requestBody, fallbackMessage, options);
  if (requestBody.stream) {
    return readOpenAICompatibleImageStream(response);
  }
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
}

async function createImageFromOpenAICompatibleItem(item) {
  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, 'base64'),
      mime_type: item.mime_type || item.mimeType || 'image/png',
    };
  }

  if (item?.url) {
    return downloadImage(item.url);
  }

  return null;
}

function getOpenAICompatibleImageFailureMessage(responseData, fallbackMessage) {
  const firstError = Array.isArray(responseData?.errors) ? responseData.errors.find((item) => item?.message) : null;
  return firstError?.message || fallbackMessage;
}

function createGoogleImageRequestBody(prompt) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };
}

function createGoogleImageUrl(baseUrl, modelName, requestMode) {
  const action = requestMode === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${baseUrl}/models/${encodeURIComponent(modelName)}:${action}`;
}

function createGoogleHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function extractGoogleCandidateParts(responseData) {
  const candidates = Array.isArray(responseData?.candidates) ? responseData.candidates : [];
  return candidates.flatMap((candidate) => (
    Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  ));
}

function appendGoogleImagePayload(payload, state) {
  if (payload?.usageMetadata || payload?.usage_metadata) {
    state.usageMetadata = payload.usageMetadata || payload.usage_metadata;
  }

  state.parts.push(...extractGoogleCandidateParts(payload));
}

async function readGoogleImageStream(response) {
  const state = { parts: [], usageMetadata: null };

  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读',
    parseErrorMessage: '生图流式响应解析失败',
    failureMessage: 'Google AI Studio 生图流式请求失败',
    onPayload(payload) {
      appendGoogleImagePayload(payload, state);
    },
  });

  return {
    stream: true,
    candidates: [{ content: { parts: state.parts } }],
    usageMetadata: state.usageMetadata,
  };
}

async function requestGoogleImageData(baseUrl, imageConfig, requestBody, requestMode, fallbackMessage, options = {}) {
  let response = null;
  try {
    response = await fetch(createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode), {
      method: 'POST',
      headers: createGoogleHeaders(imageConfig.api_key),
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }

  await ensureOk(response, fallbackMessage);
  if (requestMode === 'stream') {
    return readGoogleImageStream(response);
  }
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
}

function getGoogleImageInlineData(responseData) {
  const imagePart = extractGoogleCandidateParts(responseData).find((part) => part.inlineData?.data || part.inline_data?.data);
  return imagePart?.inlineData || imagePart?.inline_data || null;
}

function getGoogleText(responseData) {
  return extractGoogleCandidateParts(responseData)
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('')
    .trim();
}

async function chatWithConfig(app, config, request) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }

  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }

  requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');

  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, '文本请求');
  const requestMode = normalizeTextRequestMode(config);
  let requestBody = createChatRequestBody(config, request, { stream: requestMode === 'stream' });
  let responseData = null;
  let errorMessage = '';
  let analyticsTracked = false;
  const timeoutMs = normalizeRequestTimeoutMs(request);
  const timeout = createOperationTimeout(timeoutMs);

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-pending',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    let result = null;
    try {
      result = await timeout.run(requestTextAi(app, config, requestBody, { signal: timeout.signal, requestMode }));
    } catch (error) {
      if (!request.response_format || !error.responseFormatUnsupported) {
        throw error;
      }

      requestBody = createChatRequestBody(config, request, { omitResponseFormat: true, stream: requestMode === 'stream' });
      result = await timeout.run(requestTextAi(app, config, requestBody, { signal: timeout.signal, requestMode }));
    }

    responseData = result.responseData;
    recordTextTokenStats(config, result.usage);
    trackAiRequest(app, config, { ai_request_type: 'text', usage: result.usage });
    analyticsTracked = true;
    const content = result.content || '';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      content,
      created_at: new Date().toISOString(),
    });
    return content;
  } catch (error) {
    errorMessage = error.name === 'AbortError'
      ? request.timeout_message || `AI 请求超时（${timeoutMs / 1000} 秒）`
      : error.message;
    if (!analyticsTracked) {
      recordTextTokenStats(config, null);
      trackAiRequest(app, config, { ai_request_type: 'text' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-error',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    const wrappedError = new Error(errorMessage || 'AI 请求失败');
    if (error.status || error.statusCode) {
      wrappedError.status = error.status || error.statusCode;
      wrappedError.statusCode = error.status || error.statusCode;
    }
    copyRawAiErrorResponse(error, wrappedError);
    copyAiRequestErrorMeta(error, wrappedError);
    throw wrappedError;
  } finally {
    timeout.clear();
  }
}

async function testOpenAICompatibleImageModel(app, config, provider) {
  const imageConfig = config.image_model || {};
  const meta = OPENAI_IMAGE_PROVIDER_META[provider] || OPENAI_IMAGE_PROVIDER_META.volcengine;
  let responseData = null;
  let analyticsTracked = false;

  if (!imageConfig.api_key) {
    throw new Error(`请先填写${meta.label} API Key`);
  }

  if (!imageConfig.model_name) {
    throw new Error(`请先填写${meta.label}${meta.modelLabel}`);
  }

  const baseUrl = requireBaseUrl(imageConfig.base_url, `${meta.label} Base URL 缺失，请重新选择服务商后保存配置`);
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createRequestId();
  const logTitle = `AI生图测试-${meta.label}`;
  const requestBody = {
    model: imageConfig.model_name,
    prompt: '大字报，内容是“易标AI老好了”',
    size: '2048x2048',
    response_format: 'url',
    ...(requestMode === 'stream' ? { stream: true } : {}),
  };

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-pending',
      provider: meta.logProvider,
      request_mode: requestMode,
      url: `${baseUrl}/images/generations`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    try {
      responseData = await runWithAiRetry(() => runWithOperationTimeout(
        (signal) => requestOpenAICompatibleImageData(
          baseUrl,
          imageConfig.api_key,
          requestBody,
          `${meta.label}生图测试失败`,
          { signal },
        ),
        AI_REQUEST_TIMEOUT_MS,
      ));
    } catch (error) {
      const message = error.message || '';
      if (message.includes('does not exist') || message.includes('do not have access')) {
        throw copyRawAiErrorResponse(
          error,
          new Error(`${meta.label}生图模型不可用，请确认${meta.modelLabel}已开通并可访问。原始错误：${message}`),
        );
      }

      throw error;
    }

    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;
    const firstImage = responseData.data?.[0] || {};
    const imageUrl = firstImage.url || '';
    const imageData = firstImage.b64_json || '';

    if (!imageUrl && !imageData) {
      throw createAiResponseDataError(getOpenAICompatibleImageFailureMessage(responseData, `${meta.label}生图测试未返回图片数据`), responseData);
    }

    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test',
      provider: meta.logProvider,
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: {
        image_url: imageUrl,
        image_data: imageData ? '[base64 omitted]' : '',
        mime_type: 'image/png',
      },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: imageUrl ? `测试成功：已生成图片 ${imageUrl}` : '测试成功：已返回生图结果',
      image_url: imageUrl,
      image_data: imageData,
      mime_type: 'image/png',
    };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
    }
    const errorMessage = error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || '生图模型测试失败';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-error',
      provider: meta.logProvider,
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    throw new Error(errorMessage);
  }
}

async function testGoogleImageModel(app, config) {
  const imageConfig = config.image_model || {};
  let analyticsTracked = false;

  if (!imageConfig.api_key) {
    throw new Error('请先填写 Google AI Studio API Key');
  }

  if (!imageConfig.model_name) {
    throw new Error('请先填写 Google 生图模型名称');
  }

  const baseUrl = requireBaseUrl(imageConfig.base_url, 'Google AI Studio Base URL 缺失，请重新选择服务商后保存配置');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createRequestId();
  const logTitle = 'AI生图测试-Google AI Studio';
  const requestBody = createGoogleImageRequestBody('大字报，内容是“易标AI老好了”');
  const url = createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode);
  let responseData = null;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-pending',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      url,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestGoogleImageData(
        baseUrl,
        imageConfig,
        requestBody,
        requestMode,
        'Google AI Studio 生图测试失败',
        { signal },
      ),
      AI_REQUEST_TIMEOUT_MS,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractGoogleUsage(responseData) });
    analyticsTracked = true;
    const text = getGoogleText(responseData);
    const inlineData = getGoogleImageInlineData(responseData);

    if (!inlineData?.data) {
      throw createAiResponseDataError('Google AI Studio 生图测试未返回图片数据', responseData);
    }

    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: {
        image_data: '[base64 omitted]',
        mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png',
      },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: `测试成功：已返回图片${text ? `，${text}` : ''}`,
      image_data: inlineData.data,
      mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png',
    };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
    }
    const errorMessage = error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || '生图模型测试失败';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-error',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    throw new Error(errorMessage);
  }
}

async function generateOpenAICompatibleImage(app, config, request, provider) {
  const imageConfig = config.image_model || {};
  const meta = OPENAI_IMAGE_PROVIDER_META[provider] || OPENAI_IMAGE_PROVIDER_META.volcengine;
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestBody = {
    model: imageConfig.model_name,
    prompt: normalizeImagePrompt(request),
    size: request.size || '2048x2048',
    response_format: 'url',
    ...(requestMode === 'stream' ? { stream: true } : {}),
  };
  const baseUrl = requireBaseUrl(imageConfig.base_url, `${meta.label} Base URL 缺失，请重新选择服务商后保存配置`);
  let responseData = null;
  let analyticsTracked = false;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-pending',
      provider: meta.logProvider,
      request_mode: requestMode,
      url: `${baseUrl}/images/generations`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await requestOpenAICompatibleImageData(baseUrl, imageConfig.api_key, requestBody, `${meta.label}生图失败`);
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;

    const item = responseData.data?.[0] || {};
    const image = await createImageFromOpenAICompatibleItem(item);

    if (!image) {
      throw createAiResponseDataError(getOpenAICompatibleImageFailureMessage(responseData, `${meta.label}生图未返回图片数据`), responseData);
    }

    const saved = saveGeneratedImage(app, image);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: meta.logProvider,
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-error',
      provider: meta.logProvider,
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, error.message),
      created_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function generateGoogleImage(app, config, request) {
  const imageConfig = config.image_model || {};
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestBody = createGoogleImageRequestBody(normalizeImagePrompt(request));
  const baseUrl = requireBaseUrl(imageConfig.base_url, 'Google AI Studio Base URL 缺失，请重新选择服务商后保存配置');
  const url = createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode);
  let responseData = null;
  let analyticsTracked = false;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-pending',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      url,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await requestGoogleImageData(baseUrl, imageConfig, requestBody, requestMode, 'Google AI Studio 生图失败');
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractGoogleUsage(responseData) });
    analyticsTracked = true;
    const inlineData = getGoogleImageInlineData(responseData);

    if (!inlineData?.data) {
      throw createAiResponseDataError('Google AI Studio 生图未返回图片数据', responseData);
    }

    const saved = saveGeneratedImage(app, {
      buffer: Buffer.from(inlineData.data, 'base64'),
      mime_type: inlineData.mimeType || inlineData.mime_type || 'image/png',
    });
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-error',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, error.message),
      created_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function generateImageWithConfig(app, config, request) {
  const availability = getImageModelAvailability(config);
  if (!availability.available) {
    throw new Error(availability.message);
  }

  if (config.image_model?.provider === 'jinlong' || config.image_model?.provider === 'volcengine' || config.image_model?.provider === 'agnes' || config.image_model?.provider === 'custom') {
    return generateOpenAICompatibleImage(app, config, request, config.image_model.provider);
  }

  if (config.image_model?.provider === 'google-ai-studio') {
    return generateGoogleImage(app, config, request);
  }

  throw new Error('当前生图服务商暂不支持正文配图');
}

function createAiService({ app, configStore }) {
  const textRequestQueue = createAiRequestQueue({
    defaultLimit: 10,
    getLimit() {
      return configStore.load()?.concurrency_limit;
    },
  });
  const imageRequestQueue = createAiRequestQueue({
    defaultLimit: 2,
    getLimit() {
      return configStore.load()?.image_model?.concurrency_limit;
    },
  });

  function getQueueScopeId(request) {
    return String(request?.queueScopeId || request?.queue_scope_id || '').trim();
  }

  function withQueueScope(request, queueScopeId) {
    const normalizedScopeId = String(queueScopeId || '').trim();
    if (!normalizedScopeId || !request || typeof request !== 'object') {
      return request;
    }

    return {
      ...request,
      queueScopeId: getQueueScopeId(request) || normalizedScopeId,
    };
  }

  function enqueueTextRequest(request, runner) {
    return textRequestQueue.enqueue(runner, { scopeId: getQueueScopeId(request) });
  }

  function enqueueImageRequest(request, runner) {
    return imageRequestQueue.enqueue(runner, { scopeId: getQueueScopeId(request) });
  }

  const service = {
    getConfig() {
      return configStore.load();
    },

    async chat(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return chatWithConfig(app, config, request);
      });
    },

    async requestJson(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      });
    },

    async collectJsonResponse(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      });
    },

    async parseJsonResponseContent(request, content) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return parseOrRepairJsonResponseWithConfig(app, config, request, content);
      });
    },

    pauseQueueScope(scopeId) {
      return textRequestQueue.pauseScope(scopeId) + imageRequestQueue.pauseScope(scopeId);
    },

    resumeQueueScope(scopeId) {
      textRequestQueue.resumeScope(scopeId);
      imageRequestQueue.resumeScope(scopeId);
    },

    getTextQueueStatus() {
      return textRequestQueue.getStatus();
    },

    getImageQueueStatus() {
      return imageRequestQueue.getStatus();
    },

    getTextTokenStats() {
      return getTextTokenStatsSnapshot();
    },

    resetTextTokenStats() {
      return resetTextTokenStats();
    },

    onTextTokenStatsChanged(listener) {
      return onTextTokenStatsChanged(listener);
    },

    withQueueScope(scopeId) {
      return {
        ...service,
        chat(request) {
          return service.chat(withQueueScope(request, scopeId));
        },
        requestJson(request) {
          return service.requestJson(withQueueScope(request, scopeId));
        },
        collectJsonResponse(request) {
          return service.collectJsonResponse(withQueueScope(request, scopeId));
        },
        parseJsonResponseContent(request, content) {
          return service.parseJsonResponseContent(withQueueScope(request, scopeId), content);
        },
        generateImage(request) {
          return service.generateImage(withQueueScope(request, scopeId));
        },
      };
    },

    async testImageModel(config) {
      const currentConfig = configStore.load();
      const trackedConfig = {
        ...config,
        analytics_client_id: config.analytics_client_id || currentConfig.analytics_client_id,
        analytics_created_at: config.analytics_created_at || currentConfig.analytics_created_at,
      };

      if (trackedConfig.image_model?.provider === 'jinlong' || trackedConfig.image_model?.provider === 'volcengine' || trackedConfig.image_model?.provider === 'agnes' || trackedConfig.image_model?.provider === 'custom') {
        return testOpenAICompatibleImageModel(app, trackedConfig, trackedConfig.image_model.provider);
      }

      if (trackedConfig.image_model?.provider === 'google-ai-studio') {
        return testGoogleImageModel(app, trackedConfig);
      }

      throw new Error('当前服务商暂不支持测试');
    },

    getImageModelAvailability() {
      return getImageModelAvailability(configStore.load());
    },

    isDeveloperMode() {
      return Boolean(configStore.load()?.developer_mode);
    },

    createTechnicalPlanDeveloperLogger(request) {
      const config = configStore.load();
      return createModuleDeveloperLogger(app, config, 'technical-plan', request);
    },

    createDeveloperLogger(moduleName, request) {
      const config = configStore.load();
      return createModuleDeveloperLogger(app, config, moduleName, request);
    },

    async generateImage(request) {
      return enqueueImageRequest(request, () => {
        const config = configStore.load();
        return generateImageWithConfig(app, config, request);
      });
    },

    async listModels(configOverride) {
      const config = configOverride || configStore.load();

      if (!config.api_key) {
        return { success: false, message: '请先填写文本模型 API Key', models: [] };
      }

      if (!trimBaseUrl(config.base_url)) {
        return { success: false, message: '请先填写文本模型 Base URL', models: [] };
      }

      const data = await runWithAiRetry(async () => {
        let response = null;
        try {
          response = await fetch(`${trimBaseUrl(config.base_url)}/models`, {
            method: 'GET',
            headers: createHeaders(config.api_key),
          });
        } catch (error) {
          throw markAiRequestError(error, { retryable: true });
        }

        await ensureOk(response, '获取模型列表失败');
        try {
          return await response.json();
        } catch (error) {
          throw markAiRequestError(error, { retryable: true });
        }
      });

      return {
        success: true,
        message: '模型列表已更新',
        models: Array.isArray(data.data) ? data.data.map((item) => item.id).filter(Boolean) : [],
      };
    },
  };

  return service;
}

module.exports = {
  createAiService,
};
