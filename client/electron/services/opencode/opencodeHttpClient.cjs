function headers(server) {
  return {
    Authorization: server.authHeader,
    'Content-Type': 'application/json',
  };
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
  const response = await fetch(`${server.baseUrl}${routePath}`, {
    method: options.method || 'GET',
    headers: headers(server),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  return readJsonResponse(response, `OpenCode 请求失败：${routePath}`);
}

async function createSession(server, title) {
  return requestJson(server, '/session', {
    method: 'POST',
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

async function getSessionDiff(server, sessionId) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/diff`);
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
  const session = await createSession(server, title);
  const messageResult = await sendPrompt(server, session.id, prompt, { signal });
  const diff = await getSessionDiff(server, session.id).catch(() => []);

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
