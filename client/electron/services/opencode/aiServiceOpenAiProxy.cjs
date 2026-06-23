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
  isRetryableHttpStatus,
  markAiRequestError,
  runWithAiRetry,
} = require('../../utils/aiRetry.cjs');
const {
  normalizeTokenUsage,
  recordTextTokenStats,
} = require('../textTokenStatsStore.cjs');

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300000;
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

  return {
    ...source,
    // OpenCode 侧只使用 yibiao/default；真实模型名称以设置页保存的 model_name 为准。
    model: config.model_name,
    messages,
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

async function createUpstreamError(response) {
  const rawText = await response.text().catch(() => '');
  let detail = '';

  try {
    const body = rawText ? JSON.parse(rawText) : null;
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = rawText;
  }

  const error = new Error(detail || `AI 请求失败：HTTP ${response.status}`);
  error.status = response.status;
  error.statusCode = response.status;
  error.raw_response_body = rawText;
  return markAiRequestError(error, { retryable: isRetryableHttpStatus(response.status) });
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

function createUsageCapturingStream(source, onDone) {
  if (!source?.getReader) return source;

  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const collector = createSseResponseCollector();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        collector.push(decoder.decode());
        await Promise.resolve(onDone(collector.flush()));
        controller.close();
        return;
      }

      if (value) {
        collector.push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
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

function recordOpenCodeAiSuccess({ app, config, requestId, requestBody, response, responseData, content, usage, startedAt, stream, attempt }) {
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
}

function recordOpenCodeAiFailure({ app, config, requestId, requestBody, error, responseData, startedAt, attempt }) {
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
}

async function prepareProxyResponse({ app, config, requestId, requestBody, response, startedAt, attempt }) {
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
      });
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
  });

  return new Response(rawText, {
    status: response.status,
    headers: responseHeadersFromUpstream(response, 'application/json; charset=utf-8'),
  });
}

async function requestOpenCodeChatCompletion({ app, configStore, textQueue, openAiBody, signal, timeoutMs }) {
  return textQueue.enqueue(async () => {
    const config = configStore.load();
    assertTextModelConfig(config);

    const requestBody = normalizeOpenCodeProxyRequestBody(config, openAiBody);
    const requestId = createAiRequestId();

    return runWithAiRetry(async ({ attempt }) => {
      const timeout = createTimeoutSignal(signal, timeoutMs);
      const startedAt = Date.now();

      try {
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

        if (!response.ok) {
          throw await createUpstreamError(response);
        }

        return prepareProxyResponse({
          app,
          config,
          requestId,
          requestBody,
          response,
          startedAt,
          attempt,
        });
      } catch (error) {
        recordOpenCodeAiFailure({
          app,
          config,
          requestId,
          requestBody,
          error,
          startedAt,
          attempt,
        });
        throw error;
      } finally {
        timeout.clear();
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

async function pipeWebStreamToNode(webStream, res) {
  if (!webStream?.getReader) {
    res.end();
    return;
  }

  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function bindAbortToRequestLifecycle({ req, res, controller }) {
  req.on('aborted', () => controller.abort(new Error('客户端请求已中止')));
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort(new Error('客户端连接已关闭'));
    }
  });
}

async function handleChatCompletions({ req, res, app, configStore, textQueue, timeoutMs }) {
  const controller = new AbortController();
  bindAbortToRequestLifecycle({ req, res, controller });

  const requestBody = await readJson(req);
  const upstream = await requestOpenCodeChatCompletion({
    app,
    configStore,
    textQueue,
    openAiBody: requestBody,
    signal: controller.signal,
    timeoutMs,
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

function createAiServiceOpenAiProxy({ app, configStore, timeoutMs }) {
  const token = createProxyToken();
  const upstreamTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const textQueue = createOpenCodeTextQueue({
    defaultLimit: 10,
    getLimit() {
      return configStore.load()?.concurrency_limit;
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
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
        handleModels({ res });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChatCompletions({ req, res, app, configStore, textQueue, timeoutMs: upstreamTimeoutMs });
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Not found: ${req.method} ${url.pathname}`,
          type: 'not_found',
        },
      });
    } catch (error) {
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

      return {
        token,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createAiServiceOpenAiProxy,
};
