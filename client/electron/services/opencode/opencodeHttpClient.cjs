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
    throw new Error(message);
  }

  return data;
}

async function requestJson(server, routePath, options = {}) {
  const method = options.method || 'GET';
  const startedAt = Date.now();
  let response = null;
  try {
    response = await fetch(`${server.baseUrl}${routePath}`, {
      method,
      headers: headers(server),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    const data = await readJsonResponse(response, `OpenCode 请求失败：${routePath}`);
    appendRequestLog(server, {
      route: routePath,
      method,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      ok: true,
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
    });
    throw error;
  }
}

async function createSession(server, title, options = {}) {
  return requestJson(server, '/session', {
    method: 'POST',
    signal: options.signal,
    body: { title: title || 'Yibiao Agent Task' },
  });
}

async function sendPrompt(server, sessionId, prompt, options = {}) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    signal: options.signal,
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

async function runOpenCodeTask(server, { title, prompt, signal }) {
  const session = await createSession(server, title, { signal });
  const messageResult = await sendPrompt(server, session.id, prompt, { signal });
  const diff = await getSessionDiff(server, session.id, { signal }).catch(() => []);

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
