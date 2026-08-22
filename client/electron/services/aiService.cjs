const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getGeneratedImagesDir } = require('../utils/paths.cjs');
const { createDeveloperLogger } = require('../utils/developerLog.cjs');
const { createAiRequestQueue } = require('../utils/aiRequestQueue.cjs');
const {
  copyAiHttpError,
  createAiHttpErrorFromResponse,
  emitAiHttpErrorToWindows,
} = require('../utils/aiHttpError.cjs');
const {
  copyAiRequestErrorMeta,
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
const { normalizeTokenUsage } = textTokenStatsStore;

const AI_REQUEST_TIMEOUT_MS = 600000;

// 金龙中转站废弃模型映射：使用这些模型时自动切换到替代模型
const JINLONG_DEPRECATED_MODEL_MAP = {
  'codex-auto-review': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-terra',
};
const IMAGE_MODEL_TEST_TIMEOUT_MESSAGE = '生图模型测试超时，请检查 Base URL、API Key 或模型名称';
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';
const MODEL_INFO_ENDPOINT = 'https://analytics.agnet.top/model-info';
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

function normalizeOpenAICompatibleImageSize(imageConfig, requestSize) {
  const requested = String(requestSize || '').trim();
  const configured = String(imageConfig?.image_size || '').trim();
  return requested || configured || '1024x1024';
}

function normalizeGoogleImageSize(imageConfig) {
  const size = String(imageConfig?.image_size || '1K').trim();
  return size || '1K';
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

async function runWithOperationTimeout(runner, timeoutMs = AI_REQUEST_TIMEOUT_MS, parentSignal) {
  const timeout = createOperationTimeout(timeoutMs);
  try {
    const signal = parentSignal ? AbortSignal.any([timeout.signal, parentSignal]) : timeout.signal;
    return await timeout.run(runner(signal));
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

  if (imageConfig.provider === 'comfyui') {
    if (!trimBaseUrl(imageConfig.base_url)) {
      return { available: false, status: 'unavailable', message: '请先填写 ComfyUI 服务地址' };
    }
    return { available: true, status: 'available', message: '生图模型可用' };
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
  return copyAiHttpError(source, target);
}

function createAiResponseDataError(message, responseData) {
  const error = new Error(message);
  error.raw_response_data = responseData;
  return error;
}

async function downloadImage(url, options = {}) {
  let response = null;
  try {
    response = await fetch(url, { signal: options.signal });
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

async function ensureOk(response, fallbackMessage, options = {}) {
  if (response.ok) {
    return;
  }

  throw await createAiHttpErrorFromResponse(response, fallbackMessage, { source: options.source || 'ai-service' });
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

  const error = await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: options.source || 'openai-compatible-image-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });

  if (requestBody.response_format && error.responseFormatUnsupported) {
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    const retryResponse = await sendRequest(retryBody);
    await ensureOk(retryResponse, fallbackMessage, { source: options.source || 'openai-compatible-image-model' });
    return retryResponse;
  }

  throw error;
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

async function repairJsonResponse(app, config, invalidContent, issues, responseFormat, progressCallback, progressLabel, repairMessagesBuilder, logTitle, signal) {
  await emitProgress(progressCallback, `${progressLabel}格式校验失败，正在基于当前结果进行修复。`);
  return chatWithConfig(app, config, {
    messages: repairMessagesBuilder
      ? repairMessagesBuilder({ invalidContent, issues, progressLabel })
      : buildJsonRepairMessages(invalidContent, issues, progressLabel),
    response_format: responseFormat,
    logTitle: logTitle ? `${logTitle}修复` : `${progressLabel}修复`,
    signal,
  });
}

async function parseOrRepairJsonResponseWithConfig(app, config, request, content) {
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
        responseFormat,
        request.progressCallback,
        progressLabel,
        request.repairMessagesBuilder,
        logTitle,
        request.signal,
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
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const content = await chatWithConfig(app, config, {
      messages: request.messages,
      response_format: responseFormat,
      timeout_ms: request.timeout_ms,
      timeout_message: request.timeout_message,
      logTitle,
      signal: request.signal,
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
          responseFormat,
          request.progressCallback,
          progressLabel,
          request.repairMessagesBuilder,
          logTitle,
          request.signal,
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
  const modelName = JINLONG_DEPRECATED_MODEL_MAP[config.model_name] || config.model_name;
  const body = {
    model: modelName,
    messages: request.messages,
  };

  if (config.temperature_enabled) {
    body.temperature = config.temperature;
  }

  if (config.reasoning_effort) {
    body.reasoning_effort = config.reasoning_effort;
  }

  if (options.stream) {
    body.stream = true;
  }

  if (request.response_format && !options.omitResponseFormat) {
    body.response_format = request.response_format;
  }

  return body;
}

// 保留 Pi 工具调用协议字段，并统一应用当前文本模型配置。
function createAgentChatRequestBody(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  if (!messages.length) {
    throw new Error('Agent 代理请求缺少 messages');
  }

  const body = {
    ...source,
    model: config.model_name,
    messages,
    stream: normalizeTextRequestMode(config) === 'stream',
  };
  if (!body.stream) delete body.stream_options;
  if (config.temperature_enabled) {
    body.temperature = config.temperature;
  } else {
    delete body.temperature;
  }
  if (config.reasoning_effort) {
    body.reasoning_effort = config.reasoning_effort;
  } else {
    delete body.reasoning_effort;
  }

  // 部分 OpenAI 兼容上游会拒绝 Agent SDK 注入的输出长度参数。
  delete body.max_tokens;
  delete body.max_output_tokens;
  delete body.max_completion_tokens;
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

async function ensureTextAiResponseOk(response, fallbackMessage) {
  if (response.ok) {
    return;
  }

  throw await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: 'text-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });
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

async function createImageFromOpenAICompatibleItem(item, options = {}) {
  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, 'base64'),
      mime_type: item.mime_type || item.mimeType || 'image/png',
    };
  }

  if (item?.url) {
    return downloadImage(item.url, options);
  }

  return null;
}

function getOpenAICompatibleImageFailureMessage(responseData, fallbackMessage) {
  const firstError = Array.isArray(responseData?.errors) ? responseData.errors.find((item) => item?.message) : null;
  return firstError?.message || fallbackMessage;
}

function createGoogleImageRequestBody(prompt, imageSize) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  const normalizedImageSize = String(imageSize || '').trim();
  if (normalizedImageSize) {
    generationConfig.imageConfig = { imageSize: normalizedImageSize };
  }

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig,
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

  await ensureOk(response, fallbackMessage, { source: 'google-image-model' });
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
    result = await runWithAiRetry(() => runWithOperationTimeout(async (signal) => {
      try {
        return await requestTextAi(app, config, requestBody, { signal, requestMode });
      } catch (error) {
        if (!request.response_format || !error.responseFormatUnsupported) {
          throw error;
        }

        requestBody = createChatRequestBody(config, request, { omitResponseFormat: true, stream: requestMode === 'stream' });
        return requestTextAi(app, config, requestBody, { signal, requestMode });
      }
    }, timeoutMs, request.signal));

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
    markAiRequestError(wrappedError, { retryable: false });
    emitAiHttpErrorToWindows(wrappedError);
    throw wrappedError;
  }
}

// 通过统一文本出口执行一次 Agent Chat Completions 请求，响应消费完成后才释放队列槽。
async function runAgentChatCompletionWithConfig(app, config, request) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }
  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }
  requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');
  if (typeof request.consumeResponse !== 'function') {
    throw new Error('Agent 代理请求缺少响应消费函数');
  }

  const requestId = createRequestId();
  const requestBody = createAgentChatRequestBody(config, request.body);
  const requestMode = requestBody.stream ? 'stream' : 'normal';
  const logTitle = resolveAiLogTitle(request, 'Pi Agent');
  let responseData = null;
  let analyticsTracked = false;

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
    await Promise.resolve(request.onRequestStart?.({ config, requestBody, requestId }));
    const response = await fetchChatCompletion(app, config, requestBody, { signal: request.signal });
    await ensureTextAiResponseOk(response, 'AI 请求失败');
    const result = await request.consumeResponse(response, {
      config,
      requestBody,
      requestId,
    });
    responseData = result?.responseData ?? null;
    recordTextTokenStats(config, result?.usage);
    trackAiRequest(app, config, { ai_request_type: 'text', usage: result?.usage });
    analyticsTracked = true;
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      content: result?.content || '',
      created_at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    if (!analyticsTracked) {
      recordTextTokenStats(config, null);
      trackAiRequest(app, config, { ai_request_type: 'text' });
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-error',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, error?.message || 'AI 请求失败'),
      created_at: new Date().toISOString(),
    });
    throw error;
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
    size: normalizeOpenAICompatibleImageSize(imageConfig),
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
    const wrappedError = copyRawAiErrorResponse(error, new Error(errorMessage));
    emitAiHttpErrorToWindows(wrappedError);
    throw wrappedError;
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
  const requestBody = createGoogleImageRequestBody('大字报，内容是“易标AI老好了”', normalizeGoogleImageSize(imageConfig));
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
    const wrappedError = copyRawAiErrorResponse(error, new Error(errorMessage));
    emitAiHttpErrorToWindows(wrappedError);
    throw wrappedError;
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
    size: normalizeOpenAICompatibleImageSize(imageConfig, request.size),
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
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestOpenAICompatibleImageData(
        baseUrl,
        imageConfig.api_key,
        requestBody,
        `${meta.label}生图失败`,
        { signal, source: `${meta.logProvider}-image-model` },
      ),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;

    const item = responseData.data?.[0] || {};
    const image = await runWithOperationTimeout(
      (signal) => createImageFromOpenAICompatibleItem(item, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );

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
    const finalError = markAiRequestError(error, { retryable: false });
    emitAiHttpErrorToWindows(finalError);
    throw finalError;
  }
}

async function generateGoogleImage(app, config, request) {
  const imageConfig = config.image_model || {};
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestBody = createGoogleImageRequestBody(normalizeImagePrompt(request), normalizeGoogleImageSize(imageConfig));
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
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestGoogleImageData(
        baseUrl,
        imageConfig,
        requestBody,
        requestMode,
        'Google AI Studio 生图失败',
        { signal },
      ),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
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
    const finalError = markAiRequestError(error, { retryable: false });
    emitAiHttpErrorToWindows(finalError);
    throw finalError;
  }
}

const COMFYUI_POLL_INTERVAL_MS = 2000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMFYUI_MIN_IMAGE_DIMENSION = 64;
const COMFYUI_MAX_IMAGE_DIMENSION = 8192;

function isValidComfyUIDimension(value) {
  return Number.isInteger(value)
    && value >= COMFYUI_MIN_IMAGE_DIMENSION
    && value <= COMFYUI_MAX_IMAGE_DIMENSION
    && value % 8 === 0;
}

function resolveComfyUIImageSize(imageConfig, requestSize) {
  const fallback = String(imageConfig?.image_size || '').trim() || '1024x1024';
  const requested = String(requestSize || '').trim();
  // 归一化常见写法：中文乘号 × / ✕、大写 X、内部空白
  const raw = (requested || fallback).replace(/[×✕X]/g, 'x').replace(/\s+/g, '');
  const direct = raw.match(/^(\d{1,5})x(\d{1,5})$/i);
  if (direct) {
    const width = Number(direct[1]);
    const height = Number(direct[2]);
    if (isValidComfyUIDimension(width) && isValidComfyUIDimension(height)) {
      return { width, height };
    }
  }
  switch (raw.toLowerCase()) {
    case '512':
      return { width: 512, height: 512 };
    case '2k':
      return { width: 2048, height: 2048 };
    case '4k':
      return { width: 4096, height: 4096 };
    default:
      // 'auto' / '1K' / 无法识别的写法统一回退默认方图
      return { width: 1024, height: 1024 };
  }
}

function parseComfyUIWorkflowJson(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ComfyUI 工作流 JSON 解析失败，请检查设置中粘贴的工作流内容');
  }
  // 兼容带 prompt 外层包装的导出内容
  if (parsed && typeof parsed === 'object' && parsed.prompt && typeof parsed.prompt === 'object') {
    parsed = parsed.prompt;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ComfyUI 工作流格式不正确，请粘贴 API 格式（Save API Format）导出的 JSON');
  }
  const hasNode = Object.values(parsed).some((node) => node && typeof node === 'object' && typeof node.class_type === 'string');
  if (!hasNode) {
    throw new Error('ComfyUI 工作流内容为空或不包含有效节点，请粘贴 API 格式（Save API Format）导出的 JSON');
  }
  return parsed;
}

function isComfyUITextToImageWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
  let hasSampler = false;
  let hasTextEncode = false;
  let hasLatent = false;
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue;
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') hasSampler = true;
    if (node.class_type === 'CLIPTextEncode') hasTextEncode = true;
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') hasLatent = true;
  }
  return hasSampler && hasTextEncode && hasLatent;
}

// 历史条目的 prompt 元组在不同版本里布局不同（[prio, workflow, ...] 或 [prio, id, workflow, ...]），
// 取第一个"值为节点对象"的元素即为工作流
function extractComfyUIHistoryWorkflow(promptTuple) {
  if (!Array.isArray(promptTuple)) return null;
  for (const item of promptTuple) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const values = Object.values(item);
    if (values.length > 0 && values.some((node) => node && typeof node === 'object' && typeof node.class_type === 'string')) {
      return item;
    }
  }
  return null;
}

// 从执行消息中取时间戳（execution_start/execution_success），用于排序
function getComfyUIHistoryEntryTimestamp(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  let timestamp = 0;
  for (const message of messages) {
    if (Array.isArray(message) && (message[0] === 'execution_start' || message[0] === 'execution_success')) {
      const value = Number(message[1]?.timestamp);
      if (Number.isFinite(value) && value > timestamp) timestamp = value;
    }
  }
  return timestamp;
}

// 从 /history 中挑出最近一次成功执行的文生图工作流
function pickComfyUIHistoryWorkflow(historyData) {
  if (!historyData || typeof historyData !== 'object') return null;
  let picked = null;
  let pickedRank = -1;
  let index = 0;
  for (const entry of Object.values(historyData)) {
    index += 1;
    if (entry?.status?.status_str !== 'success') continue;
    const workflow = extractComfyUIHistoryWorkflow(entry?.prompt);
    if (!isComfyUITextToImageWorkflow(workflow)) continue;
    // 优先按执行时间戳取最新；时间戳缺失时退化为遍历顺序（>= 保证取到更靠后的条目）
    const rank = getComfyUIHistoryEntryTimestamp(entry) || index;
    if (rank >= pickedRank) {
      picked = workflow;
      pickedRank = rank;
    }
  }
  return picked;
}

async function fetchComfyUIJson(baseUrl, path, options = {}) {
  let response = null;
  try {
    response = await fetch(`${baseUrl}${path}`, { signal: options.signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// 服务器装有 checkpoint 模型时，按标准结构组装一个最简文生图工作流
function buildComfyUICheckpointWorkflow(objectInfo) {
  const checkpoints = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(checkpoints)) return null;
  const checkpointName = checkpoints.find((name) => typeof name === 'string' && name.trim());
  if (!checkpointName) return null;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpointName } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 0, steps: 20, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'yibiao' } },
  };
}

// 工作流模板优先级：手动粘贴的 JSON > 服务器最近成功执行的工作流 > 按服务器已装模型自动组装
async function resolveComfyUIWorkflowTemplate(baseUrl, imageConfig, options = {}) {
  const raw = String(imageConfig?.comfyui_workflow || '').trim();
  if (raw) {
    const customWorkflow = parseComfyUIWorkflowJson(raw);
    if (!isComfyUITextToImageWorkflow(customWorkflow)) {
      throw new Error('设置中粘贴的工作流不是完整的文生图工作流：需要包含 KSampler、CLIPTextEncode 与 Empty Latent 节点（当前仅支持文生图，img2img 等工作流暂不支持）');
    }
    return { workflow: customWorkflow, source: 'custom' };
  }
  const historyData = await fetchComfyUIJson(baseUrl, '/history?max_items=50', options);
  const historyWorkflow = pickComfyUIHistoryWorkflow(historyData);
  if (historyWorkflow) {
    return { workflow: historyWorkflow, source: 'history' };
  }
  const objectInfo = await fetchComfyUIJson(baseUrl, '/object_info', options);
  const builtWorkflow = buildComfyUICheckpointWorkflow(objectInfo);
  if (builtWorkflow) {
    return { workflow: builtWorkflow, source: 'auto' };
  }
  throw new Error('未能从 ComfyUI 自动探测到可用的文生图工作流：请先在 ComfyUI 中成功运行一次文生图工作流（软件会自动复用最近一次的工作流），或在设置中粘贴 API 格式的工作流 JSON');
}

function buildComfyUIImageWorkflow(baseWorkflow, prompt, size) {
  const workflow = JSON.parse(JSON.stringify(baseWorkflow));
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('ComfyUI 工作流格式不正确');
  }
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    throw new Error('生图提示词为空，请检查输入内容');
  }

  const nodes = Object.entries(workflow);
  let samplerNode = null;
  let latentNode = null;
  let saveNode = null;
  for (const [, node] of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') samplerNode = samplerNode || node;
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') latentNode = latentNode || node;
    if (node.class_type === 'SaveImage') saveNode = saveNode || node;
  }

  // 正向提示词写入采样器 positive 指向的文本节点。
  // 兜底时必须排除采样器 negative 指向的节点，否则提示词会被写进负向节点（效果完全相反）
  let promptNode = null;
  const positiveRef = samplerNode?.inputs?.positive;
  if (Array.isArray(positiveRef) && workflow[positiveRef[0]]?.class_type === 'CLIPTextEncode') {
    promptNode = workflow[positiveRef[0]];
  }
  if (!promptNode) {
    const negativeRef = samplerNode?.inputs?.negative;
    const negativeNodeId = Array.isArray(negativeRef) ? String(negativeRef[0]) : null;
    const candidates = [];
    for (const [nodeId, node] of nodes) {
      if (node?.class_type === 'CLIPTextEncode' && nodeId !== negativeNodeId) {
        candidates.push(node);
      }
    }
    // 典型工作流里正向节点留空待注入、负向节点预填词，优先选空文本节点
    promptNode = candidates.find((node) => !String(node.inputs?.text || '').trim()) || candidates[0] || null;
  }
  if (!promptNode) {
    throw new Error('ComfyUI 工作流中没有可用的 CLIPTextEncode 正向提示词节点（positive 连接无效，且负向节点之外没有其他文本节点），请检查工作流连接');
  }
  promptNode.inputs = { ...promptNode.inputs, text: normalizedPrompt };

  if (latentNode) {
    latentNode.inputs = { ...latentNode.inputs, width: size.width, height: size.height };
  }

  // seed 为节点链接（数组）时保持原样，不能用随机数覆盖断链
  if (typeof samplerNode?.inputs?.seed === 'number') {
    samplerNode.inputs = { ...samplerNode.inputs, seed: crypto.randomInt(0, 4294967296) };
  } else if (typeof samplerNode?.inputs?.noise_seed === 'number') {
    samplerNode.inputs = { ...samplerNode.inputs, noise_seed: crypto.randomInt(0, 4294967296) };
  }

  if (saveNode) {
    saveNode.inputs = { ...saveNode.inputs, filename_prefix: 'yibiao' };
  }

  return workflow;
}

async function submitComfyUIPrompt(baseUrl, workflow, options = {}) {
  let response = null;
  try {
    response = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal: options.signal,
    });
  } catch (error) {
    // 提交非幂等：网络错误时任务可能已入队，重试会导致同一提示词重复排队
    throw markAiRequestError(error, { retryable: false });
  }
  await ensureOk(response, 'ComfyUI 任务提交失败', { source: options.source || 'comfyui-image-model' });
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: false });
  }
}

function extractComfyUIImages(entry) {
  const images = [];
  for (const output of Object.values(entry?.outputs || {})) {
    if (Array.isArray(output?.images)) {
      images.push(...output.images.filter((image) => image?.filename));
    }
  }
  return images;
}

function getComfyUIExecutionError(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === 'execution_error') {
      const detail = message[1] || {};
      return detail.exception_message || detail.error || 'ComfyUI 节点执行失败';
    }
  }
  return 'ComfyUI 任务执行失败';
}

async function waitComfyUIImageResult(baseUrl, promptId, options = {}) {
  const deadline = Date.now() + AI_REQUEST_TIMEOUT_MS;
  let lastEntry = null;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    try {
      const response = await fetch(`${baseUrl}/history/${promptId}`, { signal: options.signal });
      if (response.ok) {
        const data = await response.json();
        const entry = data?.[promptId];
        if (entry) {
          lastEntry = entry;
          const statusStr = entry.status?.status_str || '';
          if (statusStr === 'error') {
            throw createAiResponseDataError(getComfyUIExecutionError(entry), entry.status);
          }
          if (entry.status?.completed || statusStr === 'success') {
            const images = extractComfyUIImages(entry);
            if (images.length > 0) {
              return { entry, images };
            }
            // 已到终态但没有图片输出（典型原因：工作流缺少 SaveImage 节点），继续轮询不会有变化
            throw createAiResponseDataError('ComfyUI 任务已完成但没有产出图片，请检查工作流是否包含 SaveImage 等图片输出节点', entry.status);
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      if (error?.raw_response_data) throw error;
      // 轮询期间的瞬时网络错误不致命，继续等待
    }
    await sleepMs(COMFYUI_POLL_INTERVAL_MS);
  }
  throw createAiResponseDataError('ComfyUI 生图等待超时', lastEntry?.status || null);
}

async function fetchComfyUIImage(baseUrl, image, options = {}) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  });
  let response = null;
  try {
    response = await fetch(`${baseUrl}/view?${params.toString()}`, { signal: options.signal });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  await ensureOk(response, 'ComfyUI 图片下载失败', { source: options.source || 'comfyui-image-model' });
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mime_type: response.headers.get('content-type') || 'image/png',
  };
}

async function runComfyUIImageGeneration(app, config, request, options = {}) {
  const imageConfig = config.image_model || {};
  const baseUrl = requireBaseUrl(imageConfig.base_url, 'ComfyUI 服务地址缺失，请在设置中填写后保存配置');
  const overridePrompt = String(options.promptOverride || '').trim();
  const prompt = overridePrompt || normalizeImagePrompt(request);
  const size = options.sizeOverride || resolveComfyUIImageSize(imageConfig, request.size);
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const logExtra = options.logExtra || {};
  let responseData = null;
  let analyticsTracked = false;

  try {
    const template = await resolveComfyUIWorkflowTemplate(baseUrl, imageConfig, { signal: request.signal });
    const workflow = buildComfyUIImageWorkflow(template.workflow, prompt, size);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: logExtra.pendingType || 'image-pending',
      provider: 'comfyui',
      request_mode: 'normal',
      url: `${baseUrl}/prompt`,
      request: { prompt, size: `${size.width}x${size.height}`, workflow_source: template.source, workflow },
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const submitted = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => submitComfyUIPrompt(baseUrl, workflow, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
    const promptId = submitted?.prompt_id;
    if (!promptId) {
      throw createAiResponseDataError('ComfyUI 未返回任务 ID', submitted);
    }

    const { entry, images } = await runWithOperationTimeout(
      (signal) => waitComfyUIImageResult(baseUrl, promptId, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );
    responseData = { prompt_id: promptId, status: entry?.status || null, images };
    trackAiRequest(app, config, { ai_request_type: 'image' });
    analyticsTracked = true;

    const image = await runWithOperationTimeout(
      (signal) => fetchComfyUIImage(baseUrl, images[0], { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );

    if (options.returnRawImage) {
      writeAiLog(app, config, {
        request_id: requestId,
        log_title: logTitle,
        type: logExtra.successType || 'image',
        provider: 'comfyui',
        request_mode: 'normal',
        request: { prompt, size: `${size.width}x${size.height}` },
        response: responseData,
        result: { filename: images[0].filename },
        created_at: new Date().toISOString(),
      });
      return { responseData, image, workflow_source: template.source };
    }

    const saved = saveGeneratedImage(app, image);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: 'comfyui',
      request_mode: 'normal',
      request: { prompt, size: `${size.width}x${size.height}` },
      response: responseData,
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
    }
    const errorMessage = options.isTest && error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || 'ComfyUI 生图失败';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: logExtra.errorType || 'image-error',
      provider: 'comfyui',
      request_mode: 'normal',
      request: { prompt, size: `${size.width}x${size.height}` },
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    const finalError = markAiRequestError(copyRawAiErrorResponse(error, new Error(errorMessage)), { retryable: false });
    emitAiHttpErrorToWindows(finalError);
    throw finalError;
  }
}

async function generateComfyUIImage(app, config, request) {
  return runComfyUIImageGeneration(app, config, request);
}

async function testComfyUIImageModel(app, config) {
  const testRequest = {
    title: '测试',
    prompt: '大字报，内容是"易标AI老好了"',
  };
  const { image, workflow_source: workflowSource } = await runComfyUIImageGeneration(app, config, testRequest, {
    returnRawImage: true,
    isTest: true,
    logExtra: { pendingType: 'image-test-pending', successType: 'image-test', errorType: 'image-test-error' },
  });
  const sourceLabel = workflowSource === 'custom' ? '设置中粘贴的工作流'
    : workflowSource === 'history' ? '服务器最近成功执行的工作流'
      : '按服务器已装模型自动组装的工作流';
  return {
    success: true,
    message: `测试成功：ComfyUI 已返回生成的图片（复用${sourceLabel}）`,
    image_url: '',
    image_data: image.buffer.toString('base64'),
    mime_type: image.mime_type || 'image/png',
  };
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

  if (config.image_model?.provider === 'comfyui') {
    return generateComfyUIImage(app, config, request);
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

  function withQueueScope(request, queueScopeId, signal) {
    const normalizedScopeId = String(queueScopeId || '').trim();
    if (!normalizedScopeId || !request || typeof request !== 'object') {
      return request;
    }

    return {
      ...request,
      queueScopeId: getQueueScopeId(request) || normalizedScopeId,
      ...(signal && !request.signal ? { signal } : {}),
    };
  }

  function enqueueTextRequest(request, runner, options = {}) {
    return textRequestQueue.enqueue(runner, {
      scopeId: getQueueScopeId(request),
      signal: options.signal,
      maxAttempts: options.maxAttempts,
    });
  }

  function enqueueImageRequest(request, runner) {
    return imageRequestQueue.enqueue(runner, { scopeId: getQueueScopeId(request), signal: request?.signal });
  }

  const service = {
    getConfig() {
      return configStore.load();
    },

    async chat(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return chatWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async runAgentChatCompletion(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return runAgentChatCompletionWithConfig(app, config, request);
      }, {
        signal: request?.signal,
        // Pi Session 保留回合级原生重试，本队列只负责统一调度和并发控制。
        maxAttempts: 1,
      });
    },

    async requestJson(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async collectJsonResponse(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async parseJsonResponseContent(request, content) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return parseOrRepairJsonResponseWithConfig(app, config, request, content);
      }, { signal: request?.signal });
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

    withQueueScope(scopeId, signal) {
      return {
        ...service,
        chat(request) {
          return service.chat(withQueueScope(request, scopeId, signal));
        },
        requestJson(request) {
          return service.requestJson(withQueueScope(request, scopeId, signal));
        },
        collectJsonResponse(request) {
          return service.collectJsonResponse(withQueueScope(request, scopeId, signal));
        },
        parseJsonResponseContent(request, content) {
          return service.parseJsonResponseContent(withQueueScope(request, scopeId, signal), content);
        },
        runAgentChatCompletion(request) {
          return service.runAgentChatCompletion(withQueueScope(request, scopeId, signal));
        },
        generateImage(request) {
          return service.generateImage(withQueueScope(request, scopeId, signal));
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

      if (trackedConfig.image_model?.provider === 'comfyui') {
        return testComfyUIImageModel(app, trackedConfig);
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

      let data = null;
      try {
        data = await runWithAiRetry(async () => {
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
      } catch (error) {
        emitAiHttpErrorToWindows(error);
        throw error;
      }

      return {
        success: true,
        message: '模型列表已更新',
        models: Array.isArray(data.data) 
          ? data.data.map((item) => item.id).filter(Boolean).filter(id => !Object.keys(JINLONG_DEPRECATED_MODEL_MAP).includes(id))
          : [],
      };
    },

    async getModelInfo(modelName) {
      const normalizedModelName = String(modelName || '').trim();
      if (!normalizedModelName) {
        return { success: false, message: '请先填写文本模型名称', modelName: '', model: null, syncedAt: '' };
      }

      const response = await fetch(`${MODEL_INFO_ENDPOINT}?modelName=${encodeURIComponent(normalizedModelName)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code !== 0) {
        throw new Error(data?.message || `获取模型信息失败：HTTP ${response.status}`);
      }
      if (!data.model) {
        return {
          success: false,
          message: `模型信息缓存中未找到 ${normalizedModelName}，请手动录入`,
          modelName: normalizedModelName,
          model: null,
          syncedAt: data.syncedAt || '',
        };
      }
      return {
        success: true,
        message: '模型信息已获取',
        modelName: normalizedModelName,
        model: {
          reasoningEfforts: Array.isArray(data.model.reasoningEfforts)
            ? data.model.reasoningEfforts.map((value) => String(value || '').trim()).filter(Boolean)
            : [],
          context: Math.max(0, Math.floor(Number(data.model.context) || 0)),
          output: Math.max(0, Math.floor(Number(data.model.output) || 0)),
        },
        syncedAt: data.syncedAt || '',
      };
    },
  };

  return service;
}

module.exports = {
  createAiService,
};
