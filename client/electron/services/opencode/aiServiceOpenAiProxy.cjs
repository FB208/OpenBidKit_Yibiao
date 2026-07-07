const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const {
  createAiRequestId,
  getAiErrorLogError,
  getAiErrorLogResponse,
  writeAiLog,
} = require('../../utils/aiLog.cjs');
const {
  markAiRequestError,
  runWithAiRetry,
} = require('../../utils/aiRetry.cjs');
const {
  createAiHttpErrorFromResponse,
  emitAiHttpErrorToWindows,
} = require('../../utils/aiHttpError.cjs');
const {
  normalizeTokenUsage,
  recordTextTokenStats,
} = require('../textTokenStatsStore.cjs');

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600000;
const SERVER_TIMEOUT_BUFFER_MS = 10000;

function normalizeTimeoutMs(value, fallback = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createProxyToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
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

function normalizeConcurrencyLimit(value, fallback = 10) {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? Math.round(number) : fallback);
}

function createOpenCodeTextQueue(options = {}) {
  let activeCount = 0;
  const queue = [];
  const getLimit = typeof options.getLimit === 'function'
    ? options.getLimit
    : () => options.limit || 10;
  const fallbackLimit = normalizeConcurrencyLimit(options.defaultLimit, 10);

  function currentLimit() {
    try {
      return normalizeConcurrencyLimit(getLimit(), fallbackLimit);
    } catch {
      return fallbackLimit;
    }
  }

  function removeQueuedJob(job) {
    const index = queue.indexOf(job);
    if (index >= 0) {
      queue.splice(index, 1);
      return true;
    }
    return false;
  }

  function getAbortReason(signal) {
    return signal?.reason || new Error('OpenCode AI proxy 请求已取消');
  }

  function pump() {
    while (activeCount < currentLimit() && queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted) {
        job.cleanup?.();
        job.reject(getAbortReason(job.signal));
        continue;
      }

      job.started = true;
      activeCount += 1;
      void runJob(job);
    }
  }

  async function runJob(job) {
    try {
      job.cleanup?.();
      job.resolve(await job.runner());
    } catch (error) {
      job.reject(error);
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      pump();
    }
  }

  function enqueue(runner, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) {
        reject(getAbortReason(signal));
        return;
      }

      const job = {
        runner,
        resolve,
        reject,
        signal,
        started: false,
        cleanup: null,
      };

      if (signal) {
        const onAbort = () => {
          if (!job.started && removeQueuedJob(job)) {
            job.cleanup?.();
            reject(getAbortReason(signal));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        };
      }

      queue.push(job);
      pump();
    });
  }

  return {
    enqueue,
    getStatus() {
      return {
        active: activeCount,
        queued: queue.length,
        limit: currentLimit(),
      };
    },
    clearQueued(reason) {
      while (queue.length) {
        const job = queue.shift();
        job.cleanup?.();
        job.reject(reason || new Error('Agent proxy 队列已清空'));
      }
    },
  };
}

function assertTextModelConfig(config) {
  if (!config?.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }
  if (!config?.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }
  if (!trimBaseUrl(config?.base_url)) {
    throw new Error('请先在设置中配置文本模型 Base URL');
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'OpenCode AI proxy failed').slice(0, 1000);
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

function appendProxyDeveloperLog(app, config, payload) {
  if (!config?.developer_mode) return;

  try {
    const logDir = getDeveloperLogsDir(app, 'opencode-ai-proxy');
    fs.mkdirSync(logDir, { recursive: true });
    const fileName = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    fs.appendFileSync(
      path.join(logDir, fileName),
      `${JSON.stringify({
        created_at: new Date().toISOString(),
        ...payload,
      })}\n`,
      'utf-8',
    );
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
    message: String(error?.message || error || 'OpenCode AI proxy failed').slice(0, 1000),
    status: error?.status || error?.statusCode || 0,
    code: error?.code || '',
    cause_name: cause?.name || '',
    cause_code: cause?.code || '',
    cause_message: cause?.message || '',
    retryable: error?.aiRequestRetryable,
  };
}

function recordProxyTextTokenStats(config, usage) {
  if (!config?.developer_mode) return;

  try {
    recordTextTokenStats(usage);
  } catch {
    // Token 统计不能影响主流程。
  }
}

function createOpenCodeProxyModelInfo() {
  return {
    id: 'default',
    object: 'model',
    created: 0,
    owned_by: 'yibiao',
  };
}

function normalizeOpenCodeProxyRequestBody(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];

  if (!messages.length) {
    throw new Error('OpenCode 代理请求缺少 messages');
  }

  const normalized = {
    ...source,
    // OpenCode 侧只使用 yibiao/default；真实模型名称以设置页保存的 model_name 为准。
    model: config.model_name,
    messages,
  };

  // 部分 OpenAI 兼容上游会拒绝 OpenCode 注入的输出长度参数。
  delete normalized.max_tokens;
  delete normalized.max_output_tokens;
  delete normalized.max_completion_tokens;

  return normalized;
}

function isAuthorized(req, token) {
  const value = String(req.headers.authorization || '').trim();
  return value === `Bearer ${token}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
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

function createTimeoutSignal(parentSignal, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createAbortError()), timeoutMs);

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
      }
    },
  };
}

function createIdleTimeoutController(parentSignal, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, message) {
  const controller = new AbortController();
  let timer = null;

  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(markAiRequestError(new Error(message || 'AI 流式响应长时间无数据'), { retryable: true }));
    }, timeoutMs);
  }

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  reset();

  return {
    signal: controller.signal,
    touch: reset,
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
      }
    },
  };
}

async function createUpstreamError(response) {
  return createAiHttpErrorFromResponse(response, `AI 请求失败：HTTP ${response.status}`, { source: 'opencode-agent' });
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

function createStreamResponseData(content, usage) {
  return {
    stream: true,
    choices: [{ message: { content } }],
    usage,
  };
}

function createSseResponseCollector() {
  let buffer = '';
  let usage = null;
  const contentParts = [];

  function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;

    try {
      const payload = JSON.parse(data);
      const nextUsage = extractUsageFromPayload(payload);
      if (nextUsage) usage = nextUsage;
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
      return {
        content,
        responseData: createStreamResponseData(content, usage),
        usage,
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
        options.onError?.(error);
        throw error;
      }
    },
    async cancel(reason) {
      options.onCancel?.(reason);
      try { await reader.cancel(reason); } catch {}
    },
  });
}

function getOpenCodeAiLogTitle(requestBody) {
  return requestBody?.logTitle || requestBody?.log_title || 'OpenCode Agent';
}

function getChatCompletionsUrl(config) {
  return `${trimBaseUrl(config.base_url)}/chat/completions`;
}

function getRequestMode(requestBody) {
  return requestBody?.stream ? 'stream' : 'normal';
}

function safeWriteOpenCodeAiLog(app, config, payload) {
  try {
    writeAiLog(app, config, payload);
  } catch {
    // OpenCode 代理日志仅用于开发排查，不能影响主请求。
  }
}

function writeOpenCodeAiPendingLog({ app, config, requestId, requestBody }) {
  safeWriteOpenCodeAiLog(app, config, {
    request_id: requestId,
    log_title: getOpenCodeAiLogTitle(requestBody),
    type: 'chat-pending',
    request_mode: getRequestMode(requestBody),
    url: getChatCompletionsUrl(config),
    request: requestBody,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
}

function recordOpenCodeAiSuccess({ app, config, requestId, requestBody, response, responseData, content, usage, startedAt, stream, attempt, diagnostics }) {
  const normalizedUsage = normalizeTokenUsage(usage);
  recordProxyTextTokenStats(config, usage);

  safeWriteOpenCodeAiLog(app, config, {
    request_id: requestId,
    log_title: getOpenCodeAiLogTitle(requestBody),
    type: 'chat',
    request_mode: getRequestMode(requestBody),
    url: getChatCompletionsUrl(config),
    request: requestBody,
    response: responseData,
    content: content || '',
    created_at: new Date().toISOString(),
  });

  appendProxyDeveloperLog(app, config, {
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

function recordOpenCodeAiFailure({ app, config, requestId, requestBody, error, responseData, startedAt, attempt, diagnostics }) {
  recordProxyTextTokenStats(config, null);

  const errorMessage = safeErrorMessage(error);
  safeWriteOpenCodeAiLog(app, config, {
    request_id: requestId,
    log_title: getOpenCodeAiLogTitle(requestBody),
    type: 'chat-error',
    request_mode: getRequestMode(requestBody),
    url: getChatCompletionsUrl(config),
    request: requestBody,
    response: getAiErrorLogResponse(error, responseData || null),
    error: getAiErrorLogError(error, errorMessage),
    created_at: new Date().toISOString(),
  });

  appendProxyDeveloperLog(app, config, {
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
    error: errorMessage,
  });

  appendProxyDiagnostic(diagnostics, 'proxy.upstream.failed', {
    request_id: requestId,
    attempt,
    duration_ms: Date.now() - startedAt,
    request: summarizeRequestBody(requestBody),
    error: summarizeProxyError(error),
    response_excerpt: String(responseData || error?.raw_response_body || '').slice(0, 2000),
  });
}

async function prepareProxyResponse({ app, config, requestId, requestBody, response, startedAt, attempt, diagnostics, onActivity, activityContext, streamTimeout }) {
  const stream = Boolean(requestBody.stream);
  const contentType = response.headers.get('content-type') || '';
  const isSse = stream || contentType.toLowerCase().includes('text/event-stream');

  if (isSse) {
    const body = createUsageCapturingStream(response.body, (capture) => {
      recordOpenCodeAiSuccess({
        app,
        config,
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
    }, {
      onChunk: () => streamTimeout?.touch?.(),
      onActivity: (event) => emitProxyActivity(onActivity, activityContext, {
        ...event,
        meta: { ...(event.meta || {}), request_id: requestId, attempt, stream: true },
      }),
      onDone: () => streamTimeout?.clear?.(),
      onCancel: () => streamTimeout?.clear?.(),
      onError: (error) => {
        streamTimeout?.clear?.();
        emitProxyActivity(onActivity, activityContext, {
          stage: 'model_request',
          message: safeErrorMessage(error),
          source: 'proxy.upstream.failed',
          activity: true,
          meta: { request_id: requestId, attempt, error: safeErrorMessage(error) },
        });
      },
    });

    return new Response(body, {
      status: response.status,
      headers: responseHeadersFromUpstream(response, 'text/event-stream; charset=utf-8'),
    });
  }

  const rawText = await response.text();
  let responseData = null;
  try {
    responseData = rawText ? JSON.parse(rawText) : null;
  } catch {
    responseData = rawText;
  }
  const usage = extractUsageFromPayload(responseData) || extractUsageFromJsonText(rawText);
  const content = responseData && typeof responseData === 'object' ? extractContentFromResponseData(responseData) : '';
  recordOpenCodeAiSuccess({
    app,
    config,
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
    meta: { request_id: requestId, attempt, stream: false },
  });

  return new Response(rawText, {
    status: response.status,
    headers: responseHeadersFromUpstream(response, 'application/json; charset=utf-8'),
  });
}

async function requestOpenCodeChatCompletion({ app, configStore, textQueue, openAiBody, signal, timeoutMs, diagnostics, onActivity, activityContext }) {
  const requestId = createAiRequestId();
  let queuedConfig = null;
  try { queuedConfig = configStore.load(); } catch {}
  appendProxyDiagnostic(diagnostics, 'proxy.chat.queued', {
    request_id: requestId,
    config: summarizeProxyConfig(queuedConfig || {}),
    request: summarizeRequestBody(openAiBody),
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.chat.queued',
    meta: { request_id: requestId },
  });

  return textQueue.enqueue(async () => {
    const config = configStore.load();
    assertTextModelConfig(config);

    const requestBody = normalizeOpenCodeProxyRequestBody(config, openAiBody);

    return runWithAiRetry(async ({ attempt }) => {
      const stream = Boolean(requestBody.stream);
      const timeout = stream
        ? createIdleTimeoutController(signal, timeoutMs, 'AI 流式响应长时间无数据')
        : createTimeoutSignal(signal, timeoutMs);
      const startedAt = Date.now();
      let streamHandedOff = false;

      try {
        appendProxyDiagnostic(diagnostics, 'proxy.upstream.started', {
          request_id: requestId,
          attempt,
          timeout_ms: timeoutMs,
          config: summarizeProxyConfig(config),
          request: summarizeRequestBody(requestBody),
        });
        emitProxyActivity(onActivity, activityContext, {
          stage: 'model_request',
          message: '',
          source: 'proxy.upstream.started',
          activity: true,
          meta: { request_id: requestId, attempt },
        });
        appendProxyDeveloperLog(app, config, {
          request_id: requestId,
          type: 'chat-pending',
          stream: Boolean(requestBody.stream),
          attempt,
          provider: config.text_model_provider || '',
          model_name: config.model_name || '',
          endpoint_host: normalizeEndpointHost(config.base_url),
          request_hash: createPromptHash(requestBody),
          messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
        });
        writeOpenCodeAiPendingLog({ app, config, requestId, requestBody });

        const response = await fetch(`${trimBaseUrl(config.base_url)}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.api_key}`,
          },
          body: JSON.stringify(requestBody),
          signal: timeout.signal,
        });

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

        if (!response.ok) {
          throw await createUpstreamError(response);
        }

        const proxyResponse = await prepareProxyResponse({
          app,
          config,
          requestId,
          requestBody,
          response,
          startedAt,
          attempt,
          diagnostics,
          onActivity,
          activityContext,
          streamTimeout: stream ? timeout : null,
        });
        streamHandedOff = stream;
        return proxyResponse;
      } catch (error) {
        recordOpenCodeAiFailure({
          app,
          config,
          requestId,
          requestBody,
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
        throw error;
      } finally {
        if (!stream || !streamHandedOff) {
          timeout.clear();
        }
      }
    }, { signal });
  }, { signal });
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

async function handleChatCompletions({ req, res, app, configStore, textQueue, timeoutMs, diagnostics, onActivity, getActivityContext }) {
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
  const upstream = await requestOpenCodeChatCompletion({
    app,
    configStore,
    textQueue,
    openAiBody: requestBody,
    signal: controller.signal,
    timeoutMs,
    diagnostics,
    onActivity,
    activityContext,
  });

  res.statusCode = upstream.status;
  copyUpstreamHeaders(upstream, res);

  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', requestBody.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
  }

  await pipeWebStreamToNode(upstream.body, res);
}

function handleModels({ res }) {
  sendJson(res, 200, {
    object: 'list',
    data: [createOpenCodeProxyModelInfo()],
  });
}

function createAiServiceOpenAiProxy({ app, configStore, timeoutMs, diagnostics, onActivity, getActivityContext }) {
  const token = createProxyToken();
  const upstreamTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const sockets = new Set();
  let closing = false;
  const textQueue = createOpenCodeTextQueue({
    defaultLimit: 10,
    getLimit() {
      return configStore.load()?.concurrency_limit;
    },
  });

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
          configStore,
          textQueue,
          timeoutMs: upstreamTimeoutMs,
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
            message: error.message || 'OpenCode AI proxy failed',
            type: 'proxy_error',
          },
        });
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  server.headersTimeout = upstreamTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.requestTimeout = upstreamTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    token,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('OpenCode AI proxy 启动失败：无法获取监听端口');
      }

      appendProxyDiagnostic(diagnostics, 'proxy.started', {
        port: address.port,
        base_url: `http://127.0.0.1:${address.port}`,
        timeout_ms: upstreamTimeoutMs,
      });

      return {
        token,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    getStatus() {
      return textQueue.getStatus();
    },
    async close({ forceAfterMs = 2000 } = {}) {
      closing = true;
      textQueue.clearQueued(new Error('Agent proxy 正在关闭'));
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
    },
  };
}

module.exports = {
  createAiServiceOpenAiProxy,
};
