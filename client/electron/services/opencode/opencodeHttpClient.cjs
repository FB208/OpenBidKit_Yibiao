const { Agent, fetch: undiciFetch } = require('undici');

const AGENT_MESSAGE_HTTP_TIMEOUT_MS = 30 * 60 * 1000;
const agentMessageHttpDispatcher = new Agent({
  headersTimeout: AGENT_MESSAGE_HTTP_TIMEOUT_MS,
  bodyTimeout: AGENT_MESSAGE_HTTP_TIMEOUT_MS,
});

function headers(server) {
  return {
    Authorization: server.authHeader,
    'Content-Type': 'application/json',
  };
}

function errorCauseMessage(error) {
  return error?.cause?.message || error?.cause?.code || '';
}

function appendRequestLog(server, payload) {
  if (!Array.isArray(server?.requestLog)) return;
  server.requestLog.push({
    at: new Date().toISOString(),
    ...payload,
  });
  if (server.requestLog.length > 80) {
    server.requestLog.splice(0, server.requestLog.length - 80);
  }
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    title: body.title || '',
    agent: body.agent || '',
    model: body.model ? `${body.model.providerID || ''}/${body.model.modelID || ''}` : '',
    parts_count: Array.isArray(body.parts) ? body.parts.length : 0,
    text_chars: Array.isArray(body.parts)
      ? body.parts.reduce((total, part) => total + (part?.type === 'text' ? String(part.text || '').length : 0), 0)
      : 0,
  };
}

function summarizeResponseData(data) {
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  return {
    id: data?.id || data?.sessionID || data?.session_id || '',
    session_id: data?.session?.id || data?.sessionID || data?.session_id || '',
    parts_count: parts.length,
    part_types: parts.map((part) => part?.type || '').filter(Boolean),
    text_chars: parts.reduce((total, part) => total + (part?.type === 'text' ? String(part.text || '').length : 0), 0),
    info_status: data?.info?.status || '',
  };
}

function emitHttpActivity(onActivity, event = {}) {
  onActivity?.({
    ...event,
    source: 'opencode-http',
    visible: false,
    activity: false,
  });
}

async function readJsonResponse(response, fallbackMessage) {
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || raw || fallbackMessage;
    const error = new Error(message);
    error.openCodeResponseText = raw;
    error.openCodeResponseData = data;
    throw error;
  }

  if (data && typeof data === 'object') {
    data.__rawLength = raw.length;
  }
  return data;
}

async function requestJson(server, routePath, options = {}) {
  const method = options.method || 'GET';
  const startedAt = Date.now();
  let response = null;
  emitHttpActivity(options.onActivity, {
    stage: options.stage || 'opencode_request',
    message: '',
    meta: { route: routePath, method },
  });
  appendRequestLog(server, {
    route: routePath,
    method,
    status: 0,
    duration_ms: 0,
    ok: 'pending',
    request: summarizeRequestBody(options.body),
  });
  try {
    const fetchOptions = {
      method,
      headers: headers(server),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    };
    if (options.dispatcher) {
      fetchOptions.dispatcher = options.dispatcher;
    }
    const fetchImpl = options.dispatcher ? undiciFetch : fetch;
    response = await fetchImpl(`${server.baseUrl}${routePath}`, fetchOptions);

    const data = await readJsonResponse(response, `OpenCode 请求失败：${routePath}`);
    emitHttpActivity(options.onActivity, {
      stage: options.successStage || options.stage || 'opencode_request',
      message: '',
      meta: { route: routePath, method, status: response.status },
    });
    appendRequestLog(server, {
      route: routePath,
      method,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      ok: true,
      response: summarizeResponseData(data),
      response_raw_chars: data?.__rawLength || 0,
    });
    return data;
  } catch (error) {
    error.openCodeRoute = routePath;
    error.openCodeMethod = method;
    error.openCodeBaseUrl = server.baseUrl;
    error.openCodeStatus = response?.status || 0;
    error.openCodeDurationMs = Date.now() - startedAt;
    error.openCodeCause = errorCauseMessage(error);
    appendRequestLog(server, {
      route: routePath,
      method,
      status: response?.status || 0,
      duration_ms: error.openCodeDurationMs,
      ok: false,
      error: error.message || String(error),
      cause: error.openCodeCause,
      error_name: error?.name || 'Error',
      aborted: Boolean(options.signal?.aborted),
      abort_reason: options.signal?.reason?.message || String(options.signal?.reason || ''),
      response_excerpt: String(error.openCodeResponseText || '').slice(0, 2000),
      request: summarizeRequestBody(options.body),
    });
    emitHttpActivity(options.onActivity, {
      stage: options.errorStage || options.stage || 'opencode_request',
      message: error.message || String(error),
      meta: { route: routePath, method, status: response?.status || 0, error: error.message || String(error) },
    });
    throw error;
  }
}

async function createSession(server, title, options = {}) {
  return requestJson(server, '/session', {
    method: 'POST',
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'session',
    body: { title: title || 'Yibiao Agent Task' },
  });
}

async function sendPrompt(server, sessionId, prompt, options = {}) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'message',
    dispatcher: agentMessageHttpDispatcher,
    body: {
      model: {
        providerID: 'yibiao',
        modelID: 'default',
      },
      agent: options.agent || 'build',
      parts: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    },
  });
}

async function getSessionDiff(server, sessionId, options = {}) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/diff`, {
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'output',
  });
}

function extractTextFromPromptResult(result) {
  const parts = Array.isArray(result?.parts) ? result.parts : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function runOpenCodeTask(server, { title, prompt, signal, agent, onActivity, onSessionCreated }) {
  const session = await createSession(server, title, { signal, onActivity });
  onSessionCreated?.(session);
  const messageResult = await sendPrompt(server, session.id, prompt, { signal, agent, onActivity });
  const diff = await getSessionDiff(server, session.id, { signal, onActivity }).catch(() => []);

  return {
    session,
    message: messageResult?.info || null,
    parts: Array.isArray(messageResult?.parts) ? messageResult.parts : [],
    text: extractTextFromPromptResult(messageResult),
    diff: Array.isArray(diff) ? diff : [],
  };
}

module.exports = {
  createSession,
  sendPrompt,
  getSessionDiff,
  runOpenCodeTask,
};
