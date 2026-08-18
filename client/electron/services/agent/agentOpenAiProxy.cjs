const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const { enqueueJsonLine } = require('../../utils/silentFileLog.cjs');
const {
  markAiRequestError,
} = require('../../utils/aiRetry.cjs');
const {
  emitAiHttpErrorToWindows,
} = require('../../utils/aiHttpError.cjs');
const { normalizeTokenUsage } = require('../textTokenStatsStore.cjs');

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_NORMAL_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SERVER_TIMEOUT_BUFFER_MS = 10000;
const DEFAULT_LOOPBACK_PROBE_TIMEOUT_MS = 1500;
const QUEUE_WAITING_ACTIVITY_INTERVAL_MS = 15000;
const NORMAL_REQUEST_ACTIVITY_INTERVAL_MS = 15000;

function normalizeTimeoutMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createProxyToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeEndpointHost(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return '';
  const candidates = rawValue.includes('://') ? [rawValue] : [`https://${rawValue}`];

  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {}
  }

  return '';
}

function normalizeEndpointSummary(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return { host: '', pathname: '' };
  const candidate = rawValue.includes('://') ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(candidate);
    return {
      host: url.hostname.toLowerCase(),
      pathname: url.pathname || '/',
      protocol: url.protocol.replace(/:$/, ''),
    };
  } catch {
    return { host: '', pathname: '' };
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'Agent AI proxy failed').slice(0, 1000);
}

function createPromptHash(body) {
  return hashText(JSON.stringify({
    model: body?.model || '',
    messages: Array.isArray(body?.messages)
      ? body.messages.map((item) => ({ role: item?.role || '', content_hash: hashText(item?.content || '') }))
      : [],
    tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    stream: Boolean(body?.stream),
  }));
}

function appendProxyDeveloperLog(app, config, runtimeMeta, payload) {
  if (!config?.developer_mode) return;

  try {
    const logDir = getDeveloperLogsDir(app, runtimeMeta.logModule);
    const fileName = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    enqueueJsonLine(path.join(logDir, fileName), {
      created_at: new Date().toISOString(),
      ...payload,
    });
  } catch {
    // 开发日志不能影响主流程。
  }
}

function appendProxyDiagnostic(diagnostics, event, payload = {}) {
  try {
    diagnostics?.record?.(event, payload);
  } catch {
    // 自检诊断不能影响主流程。
  }
}

function emitProxyActivity(onActivity, activityContext, event = {}) {
  try {
    onActivity?.({
      ...event,
      visible: event.visible === undefined ? false : event.visible,
      activity: event.activity === undefined ? false : event.activity,
      task_token: activityContext?.task_token,
      meta: {
        ...(event.meta || {}),
        task_id: activityContext?.task_id || '',
      },
    });
  } catch {
    // activity 只影响进度和 watchdog，不能影响代理请求。
  }
}

function summarizeProxyConfig(config) {
  return {
    provider: config?.text_model_provider || '',
    model_name: config?.model_name || '',
    endpoint: normalizeEndpointSummary(config?.base_url),
    has_api_key: Boolean(config?.api_key),
    request_mode: config?.request_mode || '',
    context_length_limit: Number(config?.context_length_limit || 0),
    concurrency_limit: Number(config?.concurrency_limit || 0),
  };
}

function summarizeRequestBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model || '',
    stream: Boolean(body?.stream),
    messages_count: messages.length,
    tools_count: tools.length,
    tool_choice: typeof body?.tool_choice === 'string'
      ? body.tool_choice
      : body?.tool_choice && typeof body.tool_choice === 'object'
        ? 'object'
        : body?.tool_choice === undefined ? '' : String(body.tool_choice),
    response_format_type: body?.response_format?.type || '',
    prompt_hash: createPromptHash(body),
  };
}

function summarizeResponseData(responseData, content = '') {
  const choices = Array.isArray(responseData?.choices) ? responseData.choices : [];
  const finishReasons = choices.map((choice) => choice?.finish_reason).filter(Boolean);
  const toolCallsCount = choices.reduce((count, choice) => {
    const calls = choice?.message?.tool_calls || choice?.delta?.tool_calls || [];
    return count + (Array.isArray(calls) ? calls.length : 0);
  }, 0);
  return {
    object: responseData?.object || '',
    choices_count: choices.length,
    finish_reasons: finishReasons,
    tool_calls_count: toolCallsCount,
    content_chars: String(content || '').length,
    usage: normalizeTokenUsage(extractUsageFromPayload(responseData)),
  };
}

function summarizeProxyError(error) {
  const cause = error?.cause || null;
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'Agent AI proxy failed').slice(0, 1000),
    status: error?.status || error?.statusCode || 0,
    code: error?.code || '',
    cause_name: cause?.name || '',
    cause_code: cause?.code || '',
    cause_message: cause?.message || '',
    retryable: error?.aiRequestRetryable,
  };
}

function createAgentProxyModelInfo() {
  return {
    id: 'default',
    object: 'model',
    created: 0,
    owned_by: 'yibiao',
  };
}

function isAuthorized(req, token) {
  const value = String(req.headers.authorization || '').trim();
  return value === `Bearer ${token}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function createLoopbackBaseUrl(host, port) {
  const urlHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

// 从当前进程实际访问监听地址，避免仅凭 listen 回调误判本地 Proxy 可用。
function probeLoopbackHealth(baseUrl, timeoutMs = DEFAULT_LOOPBACK_PROBE_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (success, message, error = null, status = 0) => {
      if (settled) return;
      settled = true;
      resolve({
        success,
        message,
        status,
        duration_ms: Date.now() - startedAt,
        error: error ? summarizeProxyError(error) : null,
      });
    };
    const request = http.get(`${baseUrl}/health`, (response) => {
      response.resume();
      response.once('end', () => {
        const status = Number(response.statusCode || 0);
        finish(status >= 200 && status < 300, `HTTP ${status}`, null, status);
      });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error('本地 Proxy 回连超时');
      error.code = 'LOOPBACK_PROBE_TIMEOUT';
      request.destroy(error);
    });
    request.once('error', (error) => finish(false, error?.message || '本地 Proxy 回连失败', error));
  });
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`JSON 请求体解析失败：${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function createAbortError() {
  const error = new Error('AI 请求超时');
  error.name = 'AbortError';
  return markAiRequestError(error, { retryable: true });
}

// 排队期间只响应父级取消，拿到并发 slot 后才启动上游响应计时。
function createDeferredUpstreamTimeout(parentSignal, normalRequestTimeoutMs, streamIdleTimeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let started = false;
  let stream = false;

  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = stream
        ? markAiRequestError(new Error('AI 流式响应长时间无数据'), { retryable: true })
        : createAbortError();
      controller.abort(error);
    }, stream ? streamIdleTimeoutMs : normalRequestTimeoutMs);
  }

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    start(isStream) {
      if (started || controller.signal.aborted) return;
      started = true;
      stream = Boolean(isStream);
      reset();
    },
    touch() {
      if (started && stream && !controller.signal.aborted) reset();
    },
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
      }
    },
  };
}

function responseHeadersFromUpstream(response, fallbackContentType) {
  const headers = new Headers();
  const contentType = response.headers.get('content-type') || fallbackContentType;
  if (contentType) headers.set('content-type', contentType);

  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);

  const requestId = response.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);

  return headers;
}

function extractUsageFromPayload(payload) {
  return payload?.usage || payload?.usageMetadata || payload?.usage_metadata || null;
}

function extractUsageFromJsonText(rawText) {
  try {
    const data = rawText ? JSON.parse(rawText) : null;
    return extractUsageFromPayload(data);
  } catch {
    return null;
  }
}

function contentPartToText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentPartToText).join('');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function appendChoiceContent(choice, contentParts) {
  const candidates = [
    choice?.delta?.content,
    choice?.message?.content,
    choice?.text,
  ];

  for (const candidate of candidates) {
    const text = contentPartToText(candidate);
    if (text) {
      contentParts.push(text);
      return;
    }
  }
}

function appendPayloadContent(payload, contentParts) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  choices.forEach((choice) => appendChoiceContent(choice, contentParts));
}

function extractContentFromResponseData(responseData) {
  const choices = Array.isArray(responseData?.choices) ? responseData.choices : [];
  return choices
    .flatMap((choice) => {
      const parts = [];
      appendChoiceContent(choice, parts);
      return parts;
    })
    .join('')
    .trim();
}

function createInvalidNormalCompletionError(message, responseData) {
  const error = markAiRequestError(new Error(`AI 普通响应无法转换为 Pi 流：${message}`), { retryable: true });
  error.raw_response_data = responseData;
  return error;
}

// 将普通响应中的完整工具调用转换为 Pi 可消费的单次流式增量。
function normalizeNormalToolCalls(toolCalls, responseData) {
  if (toolCalls === undefined) return undefined;
  if (!Array.isArray(toolCalls)) {
    throw createInvalidNormalCompletionError('tool_calls 不是数组', responseData);
  }
  return toolCalls.map((toolCall, index) => {
    if (!toolCall || typeof toolCall !== 'object') {
      throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用不是对象`, responseData);
    }
    if (typeof toolCall.id !== 'string' || !toolCall.id) {
      throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用缺少 id`, responseData);
    }
    if (toolCall.type === 'function') {
      if (typeof toolCall.function?.name !== 'string' || !toolCall.function.name) {
        throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用缺少函数名称`, responseData);
      }
      if (typeof toolCall.function?.arguments !== 'string') {
        throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用参数不是 JSON 字符串`, responseData);
      }
      try {
        const parsedArguments = JSON.parse(toolCall.function.arguments);
        if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
          throw new Error('工具参数根节点不是对象');
        }
      } catch (error) {
        throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用参数不是合法 JSON 对象：${error.message}`, responseData);
      }
      return {
        index,
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      };
    }
    if (toolCall.type === 'custom') {
      if (typeof toolCall.custom?.name !== 'string' || !toolCall.custom.name || typeof toolCall.custom?.input !== 'string') {
        throw createInvalidNormalCompletionError(`第 ${index + 1} 个自定义工具调用格式无效`, responseData);
      }
      return {
        index,
        id: toolCall.id,
        type: 'custom',
        custom: {
          name: toolCall.custom.name,
          input: toolCall.custom.input,
        },
      };
    }
    throw createInvalidNormalCompletionError(`第 ${index + 1} 个工具调用类型无效`, responseData);
  });
}

// 将普通响应的兼容用量字段统一转换为 Pi 可识别的 OpenAI usage。
function createPiSseUsage(responseData) {
  const rawUsage = extractUsageFromPayload(responseData);
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return null;

  const normalized = normalizeTokenUsage(rawUsage);
  const promptDetailsSource = rawUsage.prompt_tokens_details || rawUsage.promptTokensDetails;
  const completionDetailsSource = rawUsage.completion_tokens_details || rawUsage.completionTokensDetails;
  const promptDetails = promptDetailsSource && typeof promptDetailsSource === 'object' && !Array.isArray(promptDetailsSource)
    ? promptDetailsSource
    : null;
  const completionDetails = completionDetailsSource && typeof completionDetailsSource === 'object' && !Array.isArray(completionDetailsSource)
    ? completionDetailsSource
    : null;

  return {
    ...rawUsage,
    prompt_tokens: normalized.prompt_tokens,
    completion_tokens: normalized.completion_tokens,
    total_tokens: normalized.total_tokens,
    ...(promptDetails || normalized.cached_tokens > 0 ? {
      prompt_tokens_details: {
        ...(promptDetails || {}),
        cached_tokens: normalized.cached_tokens,
      },
    } : {}),
    ...(completionDetails || normalized.reasoning_tokens > 0 ? {
      completion_tokens_details: {
        ...(completionDetails || {}),
        reasoning_tokens: normalized.reasoning_tokens,
      },
    } : {}),
  };
}

// 将标准非流式 Chat Completion 确定性编码为 OpenAI SSE Chunk。
function createPiSseFromNormalCompletion(responseData) {
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    throw createInvalidNormalCompletionError('响应根节点不是对象', responseData);
  }
  const choice = Array.isArray(responseData.choices) ? responseData.choices[0] : null;
  if (!choice || typeof choice !== 'object') {
    throw createInvalidNormalCompletionError('缺少 choices[0]', responseData);
  }
  const message = choice.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw createInvalidNormalCompletionError('缺少 choices[0].message', responseData);
  }
  if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) {
    throw createInvalidNormalCompletionError('缺少 finish_reason', responseData);
  }
  if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') {
    throw createInvalidNormalCompletionError('message.content 不是字符串', responseData);
  }
  if (message.function_call !== undefined) {
    throw createInvalidNormalCompletionError('响应使用旧版 function_call，缺少标准 tool_calls', responseData);
  }

  const delta = { role: typeof message.role === 'string' && message.role ? message.role : 'assistant' };
  if (typeof message.content === 'string' && message.content) delta.content = message.content;
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = message[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw createInvalidNormalCompletionError(`message.${field} 不是字符串`, responseData);
    }
    if (typeof value === 'string' && value) delta[field] = value;
  }
  if (message.reasoning_details !== undefined) delta.reasoning_details = message.reasoning_details;
  const toolCalls = normalizeNormalToolCalls(message.tool_calls, responseData);
  if (toolCalls?.length) delta.tool_calls = toolCalls;
  const toolFinish = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call';
  if (toolFinish !== Boolean(toolCalls?.length)) {
    throw createInvalidNormalCompletionError('finish_reason 与 tool_calls 不一致', responseData);
  }
  if (responseData.usage !== undefined && responseData.usage !== null && (typeof responseData.usage !== 'object' || Array.isArray(responseData.usage))) {
    throw createInvalidNormalCompletionError('usage 不是对象', responseData);
  }

  const base = {
    id: typeof responseData.id === 'string' ? responseData.id : '',
    object: 'chat.completion.chunk',
    created: Number.isFinite(Number(responseData.created)) ? Number(responseData.created) : 0,
    model: typeof responseData.model === 'string' ? responseData.model : '',
  };
  if (responseData.system_fingerprint !== undefined) base.system_fingerprint = responseData.system_fingerprint;
  if (responseData.service_tier !== undefined) base.service_tier = responseData.service_tier;
  const usage = createPiSseUsage(responseData);

  const chunks = [
    {
      ...base,
      choices: [{ index: Number.isFinite(Number(choice.index)) ? Number(choice.index) : 0, delta, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: Number.isFinite(Number(choice.index)) ? Number(choice.index) : 0, delta: {}, finish_reason: choice.finish_reason }],
    },
  ];
  if (usage) {
    chunks.push({ ...base, choices: [], usage });
  }

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

function createStreamResponseData(content, usage, streamMeta) {
  return {
    stream: true,
    choices: [{
      finish_reason: streamMeta.finish_reasons[streamMeta.finish_reasons.length - 1] || null,
      message: { content },
    }],
    usage,
    stream_meta: streamMeta,
  };
}

function createSseResponseCollector() {
  let buffer = '';
  let usage = null;
  let parsedEventCount = 0;
  let sawDone = false;
  let streamError = null;
  const contentParts = [];
  const finishReasons = [];

  function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;

    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

    try {
      const payload = JSON.parse(data);
      parsedEventCount += 1;
      const nextUsage = extractUsageFromPayload(payload);
      if (nextUsage) usage = nextUsage;
      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      choices.forEach((choice) => {
        if (choice?.finish_reason) finishReasons.push(String(choice.finish_reason));
      });
      if (payload?.error) {
        const source = payload.error;
        streamError = {
          type: String(source?.type || source?.code || payload?.type || 'stream_error'),
          message: String(source?.message || payload?.message || (typeof source === 'string' ? source : JSON.stringify(source))),
        };
      }
      appendPayloadContent(payload, contentParts);
    } catch {
      // 单行解析失败不影响流式转发。
    }
  }

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    },
    flush() {
      if (buffer.trim()) {
        buffer.split(/\r?\n/).forEach(processLine);
      }
      buffer = '';
      const content = contentParts.join('').trim();
      const streamMeta = {
        parsed_event_count: parsedEventCount,
        saw_done: sawDone,
        finish_reasons: [...finishReasons],
        error: streamError,
      };
      return {
        content,
        responseData: createStreamResponseData(content, usage, streamMeta),
        usage,
        streamError,
        streamMeta,
      };
    },
  };
}

function createUsageCapturingStream(source, onDone, options = {}) {
  if (!source?.getReader) return source;

  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const collector = createSseResponseCollector();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          collector.push(decoder.decode());
          await Promise.resolve(onDone(collector.flush()));
          options.onDone?.();
          controller.close();
          return;
        }

        if (value) {
          options.onChunk?.(value);
          options.onActivity?.({
            stage: 'model_stream',
            message: '',
            source: 'proxy.stream.chunk',
            visible: false,
            activity: true,
            meta: { bytes: value.byteLength || value.length || 0 },
          });
          collector.push(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (error) {
        collector.push(decoder.decode());
        options.onError?.(error, collector.flush());
        throw error;
      }
    },
    async cancel(reason) {
      collector.push(decoder.decode());
      options.onCancel?.(reason, collector.flush());
      try { await reader.cancel(reason); } catch {}
    },
  });
}

function recordAgentAiSuccess({ app, config, runtimeMeta, requestId, requestBody, response, responseData, content, usage, startedAt, stream, attempt, diagnostics }) {
  const normalizedUsage = normalizeTokenUsage(usage);

  appendProxyDeveloperLog(app, config, runtimeMeta, {
    request_id: requestId,
    type: 'chat',
    stream: Boolean(stream),
    attempt,
    duration_ms: Date.now() - startedAt,
    status: response.status,
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint_host: normalizeEndpointHost(config.base_url),
    request_hash: createPromptHash(requestBody),
    messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
    usage: normalizedUsage,
  });

  appendProxyDiagnostic(diagnostics, 'proxy.upstream.completed', {
    request_id: requestId,
    attempt,
    duration_ms: Date.now() - startedAt,
    status: response.status,
    content_type: response.headers.get('content-type') || '',
    upstream_request_id: response.headers.get('x-request-id') || '',
    stream: Boolean(stream),
    request: summarizeRequestBody(requestBody),
    response: summarizeResponseData(responseData, content),
  });
}

function recordAgentAiFailure({ app, config, runtimeMeta, requestId, requestBody, error, response, responseData, usage, startedAt, attempt, diagnostics }) {
  const errorMessage = safeErrorMessage(error);
  appendProxyDeveloperLog(app, config, runtimeMeta, {
    request_id: requestId,
    type: 'chat-error',
    attempt,
    duration_ms: Date.now() - startedAt,
    status: error?.status || error?.statusCode || 0,
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint_host: normalizeEndpointHost(config.base_url),
    request_hash: createPromptHash(requestBody),
    messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
    upstream_status: Number(response?.status || 0),
    upstream_request_id: response?.headers?.get?.('x-request-id') || '',
    error: errorMessage,
  });

  appendProxyDiagnostic(diagnostics, 'proxy.upstream.failed', {
    request_id: requestId,
    attempt,
    duration_ms: Date.now() - startedAt,
    upstream_status: Number(response?.status || 0),
    upstream_request_id: response?.headers?.get?.('x-request-id') || '',
    request: summarizeRequestBody(requestBody),
    error: summarizeProxyError(error),
    response_excerpt: String(responseData || error?.raw_response_body || '').slice(0, 2000),
  });
}

async function prepareProxyResponse({ app, config, runtimeMeta, requestId, requestBody, downstreamWantsStream, response, startedAt, attempt, diagnostics, onActivity, activityContext, streamTimeout }) {
  const stream = Boolean(requestBody.stream);

  if (stream) {
    if (!response.body?.getReader) {
      const error = markAiRequestError(new Error('AI 流式响应缺少可读取的响应体'), { retryable: true });
      error.code = 'AI_STREAM_BODY_MISSING';
      throw error;
    }

    let streamFinalized = false;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const finalizeStreamFailure = (error, capture) => {
      if (streamFinalized) return;
      streamFinalized = true;
      streamTimeout?.clear?.();
      recordAgentAiFailure({
        app,
        config,
        runtimeMeta,
        requestId,
        requestBody,
        response,
        error,
        responseData: capture?.responseData || null,
        usage: capture?.usage || null,
        startedAt,
        attempt,
        diagnostics,
      });
      if (error && typeof error === 'object') error.agentProxyFailureRecorded = true;
      emitProxyActivity(onActivity, activityContext, {
        stage: 'model_request',
        message: safeErrorMessage(error),
        source: 'proxy.upstream.failed',
        activity: true,
        meta: { request_id: requestId, attempt, error: safeErrorMessage(error), stream: true },
      });
      rejectCompletion(error);
    };
    const createStreamFailure = (capture, fallbackMessage) => {
      const error = markAiRequestError(new Error(capture?.streamError?.message || fallbackMessage), { retryable: true });
      error.code = capture?.streamError?.type || 'AI_STREAM_INCOMPLETE';
      return error;
    };
    const body = createUsageCapturingStream(response.body, (capture) => {
      if (capture.streamError) {
        finalizeStreamFailure(createStreamFailure(capture, 'AI 流式响应返回错误'), capture);
        return;
      }
      if (streamFinalized) return;
      streamFinalized = true;
      recordAgentAiSuccess({
        app,
        config,
        runtimeMeta,
        requestId,
        requestBody,
        response,
        responseData: capture.responseData,
        content: capture.content,
        usage: capture.usage,
        startedAt,
        stream: true,
        attempt,
        diagnostics,
      });
      emitProxyActivity(onActivity, activityContext, {
        stage: 'model_stream',
        message: '',
        source: 'proxy.upstream.completed',
        activity: true,
        meta: { request_id: requestId, attempt, stream: true },
      });
      streamTimeout?.clear?.();
      resolveCompletion(capture);
    }, {
      onChunk: () => streamTimeout?.touch?.(),
      onActivity: (event) => emitProxyActivity(onActivity, activityContext, {
        ...event,
        meta: { ...(event.meta || {}), request_id: requestId, attempt, stream: true },
      }),
      onDone: () => streamTimeout?.clear?.(),
      onCancel: (reason, capture) => finalizeStreamFailure(
        createStreamFailure(capture, safeErrorMessage(reason || 'AI 流式响应在完成前被取消')),
        capture,
      ),
      onError: (error, capture) => finalizeStreamFailure(error, capture),
    });

    return {
      response: new Response(body, {
        status: response.status,
        headers: responseHeadersFromUpstream(response, 'text/event-stream; charset=utf-8'),
      }),
      completion,
    };
  }

  const rawText = await response.text();
  let responseData = null;
  try {
    responseData = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    if (downstreamWantsStream) {
      throw createInvalidNormalCompletionError(`响应不是合法 JSON：${error.message}`, rawText);
    }
    responseData = rawText;
  }
  const usage = extractUsageFromPayload(responseData) || extractUsageFromJsonText(rawText);
  const content = responseData && typeof responseData === 'object' ? extractContentFromResponseData(responseData) : '';
  const downstreamBody = downstreamWantsStream ? createPiSseFromNormalCompletion(responseData) : rawText;
  recordAgentAiSuccess({
    app,
    config,
    runtimeMeta,
    requestId,
    requestBody,
    response,
    responseData,
    content,
    usage,
    startedAt,
    stream: false,
    attempt,
    diagnostics,
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.upstream.completed',
    activity: true,
    meta: { request_id: requestId, attempt, stream: false, adapted_to_sse: Boolean(downstreamWantsStream) },
  });

  const downstreamHeaders = responseHeadersFromUpstream(
    response,
    downstreamWantsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
  );
  if (downstreamWantsStream) downstreamHeaders.set('content-type', 'text/event-stream; charset=utf-8');

  return {
    response: new Response(downstreamBody, {
      status: response.status,
      headers: downstreamHeaders,
    }),
    completion: Promise.resolve({ responseData, content, usage }),
  };
}

async function requestAgentChatCompletion({ app, aiService, runtimeMeta, openAiBody, signal, normalRequestTimeoutMs, streamIdleTimeoutMs, diagnostics, onActivity, activityContext, consumeResponse }) {
  const proxyRequestId = crypto.randomUUID();
  let queuedConfig = null;
  try { queuedConfig = aiService.getConfig(); } catch {}
  appendProxyDiagnostic(diagnostics, 'proxy.chat.queued', {
    request_id: proxyRequestId,
    config: summarizeProxyConfig(queuedConfig || {}),
    request: summarizeRequestBody(openAiBody),
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.chat.queued',
    activity: true,
    meta: { request_id: proxyRequestId },
  });

  const runSingleAttempt = async (attempt) => {
    const queuedAt = Date.now();
    let startedAt = queuedAt;
    const timeout = createDeferredUpstreamTimeout(signal, normalRequestTimeoutMs, streamIdleTimeoutMs);
    let requestContext = null;
    let upstreamResponse = null;
    let queueWaitingActivityTimer = null;
    let normalRequestActivityTimer = null;
    const stopQueueWaitingActivity = () => {
      if (queueWaitingActivityTimer) clearInterval(queueWaitingActivityTimer);
      queueWaitingActivityTimer = null;
    };
    const stopNormalRequestActivity = () => {
      if (normalRequestActivityTimer) clearInterval(normalRequestActivityTimer);
      normalRequestActivityTimer = null;
    };
    queueWaitingActivityTimer = setInterval(() => {
      emitProxyActivity(onActivity, activityContext, {
        stage: 'model_request',
        message: '',
        source: 'proxy.queue.waiting',
        visible: false,
        activity: true,
        meta: { request_id: proxyRequestId, attempt, queue_wait_ms: Date.now() - queuedAt },
      });
    }, QUEUE_WAITING_ACTIVITY_INTERVAL_MS);

    try {
      return await aiService.runAgentChatCompletion({
        body: openAiBody,
        signal: timeout.signal,
        queueScopeId: activityContext?.queue_scope_id || '',
        logTitle: runtimeMeta.displayName,
        onRequestStart(context) {
          stopQueueWaitingActivity();
          startedAt = Date.now();
          requestContext = context;
          const { config, requestBody, requestId } = context;
          const queueWaitMs = startedAt - queuedAt;
          const stream = Boolean(requestBody.stream);
          timeout.start(stream);
          appendProxyDiagnostic(diagnostics, 'proxy.upstream.started', {
            request_id: requestId,
            attempt,
            queue_wait_ms: queueWaitMs,
            timeout_ms: stream ? streamIdleTimeoutMs : normalRequestTimeoutMs,
            timeout_type: stream ? 'stream_idle' : 'normal_request',
            config: summarizeProxyConfig(config),
            request: summarizeRequestBody(requestBody),
          });
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: '',
            source: 'proxy.upstream.started',
            activity: true,
            meta: { request_id: requestId, attempt, queue_wait_ms: queueWaitMs },
          });
          appendProxyDeveloperLog(app, config, runtimeMeta, {
            request_id: requestId,
            type: 'chat-pending',
            stream: Boolean(requestBody.stream),
            attempt,
            queue_wait_ms: queueWaitMs,
            provider: config.text_model_provider || '',
            model_name: config.model_name || '',
            endpoint_host: normalizeEndpointHost(config.base_url),
            request_hash: createPromptHash(requestBody),
            messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
          });
          if (!requestBody.stream) {
            normalRequestActivityTimer = setInterval(() => {
              emitProxyActivity(onActivity, activityContext, {
                stage: 'model_request',
                message: '',
                source: 'proxy.normal.waiting',
                visible: false,
                activity: true,
                meta: { request_id: requestId, attempt, stream: false },
              });
            }, NORMAL_REQUEST_ACTIVITY_INTERVAL_MS);
          }
        },
        async consumeResponse(response, context) {
          stopNormalRequestActivity();
          requestContext = context;
          upstreamResponse = response;
          const { config, requestBody, requestId } = context;
          appendProxyDiagnostic(diagnostics, 'proxy.upstream.headers', {
            request_id: requestId,
            attempt,
            duration_ms: Date.now() - startedAt,
            status: response.status,
            ok: response.ok,
            content_type: response.headers.get('content-type') || '',
            upstream_request_id: response.headers.get('x-request-id') || '',
          });
          timeout.touch?.();
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: '',
            source: 'proxy.upstream.headers',
            activity: true,
            meta: { request_id: requestId, attempt, status: response.status },
          });

          const prepared = await prepareProxyResponse({
            app,
            config,
            runtimeMeta,
            requestId,
            requestBody,
            downstreamWantsStream: Boolean(openAiBody.stream),
            response,
            startedAt,
            attempt,
            diagnostics,
            onActivity,
            activityContext,
            streamTimeout: requestBody.stream ? timeout : null,
          });
          const [, capture] = await Promise.all([
            consumeResponse(prepared.response),
            prepared.completion,
          ]);
          return capture;
        },
      });
    } catch (error) {
      if (!error?.agentProxyFailureRecorded) {
        const config = requestContext?.config || queuedConfig || {};
        const requestBody = requestContext?.requestBody || openAiBody;
        const requestId = requestContext?.requestId || proxyRequestId;
        recordAgentAiFailure({
          app,
          config,
          runtimeMeta,
          requestId,
          requestBody,
          response: upstreamResponse,
          error,
          startedAt,
          attempt,
          diagnostics,
        });
        emitProxyActivity(onActivity, activityContext, {
          stage: 'model_request',
          message: safeErrorMessage(error),
          source: 'proxy.upstream.failed',
          activity: true,
          meta: { request_id: requestId, attempt, error: safeErrorMessage(error) },
        });
      }
      throw error;
    } finally {
      stopQueueWaitingActivity();
      stopNormalRequestActivity();
      timeout.clear();
    }
  };
  return runSingleAttempt(1);
}

function copyUpstreamHeaders(upstream, res) {
  const passHeaders = [
    'content-type',
    'cache-control',
    'x-request-id',
  ];

  for (const name of passHeaders) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

async function pipeWebStreamToNode(webStream, res, options = {}) {
  if (!webStream?.getReader) {
    res.end();
    return;
  }

  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        options.onChunk?.(value);
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function bindAbortToRequestLifecycle({ req, res, controller, diagnostics, onActivity, activityContext }) {
  req.on('aborted', () => {
    appendProxyDiagnostic(diagnostics, 'proxy.client.aborted', { path: req.url || '' });
    emitProxyActivity(onActivity, activityContext, {
      stage: 'model_request',
      message: 'Agent 模型请求已中止',
      source: 'proxy.client.aborted',
      activity: true,
      meta: { path: req.url || '' },
    });
    controller.abort(new Error('客户端请求已中止'));
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      appendProxyDiagnostic(diagnostics, 'proxy.client.closed', { path: req.url || '' });
      emitProxyActivity(onActivity, activityContext, {
        stage: 'model_request',
        message: 'Agent 模型连接已关闭',
        source: 'proxy.client.closed',
        activity: true,
        meta: { path: req.url || '' },
      });
      controller.abort(new Error('客户端连接已关闭'));
    }
  });
}

async function handleChatCompletions({ req, res, app, aiService, runtimeMeta, normalRequestTimeoutMs, streamIdleTimeoutMs, diagnostics, onActivity, getActivityContext }) {
  const controller = new AbortController();
  const requestBody = await readJson(req);
  const activityContext = getActivityContext?.() || null;
  bindAbortToRequestLifecycle({ req, res, controller, diagnostics, onActivity, activityContext });
  appendProxyDiagnostic(diagnostics, 'proxy.chat.received', {
    request: summarizeRequestBody(requestBody),
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.chat.received',
    activity: true,
    meta: { request: summarizeRequestBody(requestBody) },
  });
  await requestAgentChatCompletion({
    app,
    aiService,
    runtimeMeta,
    openAiBody: requestBody,
    signal: controller.signal,
    normalRequestTimeoutMs,
    streamIdleTimeoutMs,
    diagnostics,
    onActivity,
    activityContext,
    async consumeResponse(upstream) {
      res.statusCode = upstream.status;
      copyUpstreamHeaders(upstream, res);
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', requestBody.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
      }
      await pipeWebStreamToNode(upstream.body, res);
    },
  });
}

function handleModels({ res }) {
  sendJson(res, 200, {
    object: 'list',
    data: [createAgentProxyModelInfo()],
  });
}

function createAgentOpenAiProxy({
  app,
  aiService,
  runtime,
  normalRequestTimeoutMs,
  streamIdleTimeoutMs,
  diagnostics,
  onActivity,
  getActivityContext,
  verifyLoopback = false,
  loopbackHosts = ['127.0.0.1'],
}) {
  const runtimeMeta = {
    id: runtime.id,
    displayName: runtime.displayName,
    logModule: `${runtime.id}-ai-proxy`,
  };
  const token = createProxyToken();
  const normalizedNormalRequestTimeoutMs = normalizeTimeoutMs(normalRequestTimeoutMs, DEFAULT_NORMAL_REQUEST_TIMEOUT_MS);
  const normalizedStreamIdleTimeoutMs = normalizeTimeoutMs(streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const serverTimeoutMs = Math.max(normalizedNormalRequestTimeoutMs, normalizedStreamIdleTimeoutMs);
  const sockets = new Set();
  let closing = false;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      appendProxyDiagnostic(diagnostics, 'proxy.http.received', {
        method: req.method || '',
        path: url.pathname,
        authorized: url.pathname === '/health' ? true : isAuthorized(req, token),
      });

      if (url.pathname === '/health') {
        sendJson(res, closing ? 503 : 200, { ok: !closing });
        return;
      }

      if (closing) {
        sendJson(res, 503, {
          error: {
            message: 'Agent proxy 正在关闭',
            type: 'closing',
          },
        });
        return;
      }

      if (!isAuthorized(req, token)) {
        sendJson(res, 401, {
          error: {
            message: 'Unauthorized',
            type: 'unauthorized',
          },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        appendProxyDiagnostic(diagnostics, 'proxy.models.returned', {});
        handleModels({ res });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChatCompletions({
          req,
          res,
          app,
          aiService,
          runtimeMeta,
          normalRequestTimeoutMs: normalizedNormalRequestTimeoutMs,
          streamIdleTimeoutMs: normalizedStreamIdleTimeoutMs,
          diagnostics,
          onActivity,
          getActivityContext,
        });
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Not found: ${req.method} ${url.pathname}`,
          type: 'not_found',
        },
      });
    } catch (error) {
      emitAiHttpErrorToWindows(error);
      appendProxyDiagnostic(diagnostics, 'proxy.http.failed', {
        method: req.method || '',
        path: req.url || '',
        error: summarizeProxyError(error),
      });
      const statusCode = error.statusCode || error.status || 500;
      if (!res.headersSent) {
        sendJson(res, statusCode, {
          error: {
            message: error.message || `${runtimeMeta.displayName} AI proxy failed`,
            type: 'proxy_error',
          },
        });
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  server.headersTimeout = serverTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.requestTimeout = serverTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function closeListeningServer({ forceAfterMs = 2000, destroySockets = false } = {}) {
    if (destroySockets) {
      for (const socket of sockets) {
        try { socket.destroy(); } catch {}
      }
    }
    if (!server.listening) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) {
          try { socket.destroy(); } catch {}
        }
        resolve();
      }, forceAfterMs);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function listenOnHost(host) {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(0, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(`${runtimeMeta.displayName} AI proxy 启动失败：无法获取监听端口`);
    }
    return address;
  }

  return {
    token,
    server,
    async start() {
      const candidates = verifyLoopback
        ? [...new Set((loopbackHosts || []).map((item) => String(item || '').trim()).filter(Boolean))]
        : ['127.0.0.1'];
      const attempts = [];
      let selected = null;

      for (const host of candidates.length ? candidates : ['127.0.0.1']) {
        let address = null;
        try {
          address = await listenOnHost(host);
          const baseUrl = createLoopbackBaseUrl(host, address.port);
          const probe = verifyLoopback
            ? await probeLoopbackHealth(baseUrl)
            : { success: true, message: '未启用启动回连检测', status: 0, duration_ms: 0, error: null };
          const attempt = {
            host,
            family: address.family || '',
            port: address.port,
            base_url: baseUrl,
            listen_success: true,
            probe,
          };
          attempts.push(attempt);
          appendProxyDiagnostic(diagnostics, 'proxy.loopback.probed', attempt);
          if (probe.success) {
            selected = { host, address, baseUrl };
            break;
          }
        } catch (error) {
          const attempt = {
            host,
            family: address?.family || '',
            port: Number(address?.port || 0),
            base_url: address ? createLoopbackBaseUrl(host, address.port) : '',
            listen_success: false,
            probe: null,
            error: summarizeProxyError(error),
          };
          attempts.push(attempt);
          appendProxyDiagnostic(diagnostics, 'proxy.loopback.probed', attempt);
        }

        await closeListeningServer({ forceAfterMs: 500, destroySockets: true });
      }

      if (!selected) {
        const error = new Error('本地 AI Proxy 已依次尝试 IPv4、IPv6 和 localhost，但均未形成可用回连；可能被本机安全软件、企业终端管控、VPN/网络过滤驱动或 Windows TCP/IP loopback 异常阻断');
        error.code = 'AGENT_PROXY_LOOPBACK_BLOCKED';
        error.loopbackAttempts = attempts;
        appendProxyDiagnostic(diagnostics, 'proxy.loopback.blocked', { attempts });
        throw error;
      }

      const { host, address, baseUrl } = selected;
      appendProxyDiagnostic(diagnostics, 'proxy.started', {
        host,
        family: address.family || '',
        port: address.port,
        base_url: baseUrl,
        normal_request_timeout_ms: normalizedNormalRequestTimeoutMs,
        stream_idle_timeout_ms: normalizedStreamIdleTimeoutMs,
        loopback_attempts: attempts,
      });

      return {
        token,
        host,
        family: address.family || '',
        port: address.port,
        baseUrl,
        loopbackAttempts: attempts,
      };
    },
    getStatus() {
      return aiService.getTextQueueStatus();
    },
    async close({ forceAfterMs = 2000 } = {}) {
      closing = true;
      await closeListeningServer({ forceAfterMs });
    },
  };
}

module.exports = {
  createAgentOpenAiProxy,
};
