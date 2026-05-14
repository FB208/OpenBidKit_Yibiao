const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAiLogsDir, getGeneratedImagesDir } = require('../utils/paths.cjs');

const AI_REQUEST_TIMEOUT_MS = 300000;

function trimBaseUrl(baseUrl) {
  return (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function createRequestId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
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

function writeAiLog(app, config, payload) {
  if (!config.developer_mode) {
    return;
  }

  const logsDir = getAiLogsDir(app);
  fs.mkdirSync(logsDir, { recursive: true });
  const fileName = `${payload.request_id}.json`;
  fs.writeFileSync(path.join(logsDir, fileName), JSON.stringify(payload, null, 2), 'utf-8');
}

function createHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
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

async function downloadImage(url) {
  const response = await fetch(url);
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
  try {
    const body = await response.json();
    detail = body.error?.message || body.message || '';
  } catch {
    detail = await response.text().catch(() => '');
  }

  throw new Error(detail || fallbackMessage);
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

  const uniqueCandidates = [...new Set(withBalancedCandidates.map((item) => item.trim()).filter(Boolean))];
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
5. 只返回修复后的完整 JSON，不要输出任何解释`,
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

async function repairJsonResponse(app, config, invalidContent, issues, temperature, responseFormat, progressCallback, progressLabel, repairMessagesBuilder) {
  await emitProgress(progressCallback, `${progressLabel}格式校验失败，正在基于当前结果进行修复。`);
  return chatWithConfig(app, config, {
    messages: repairMessagesBuilder
      ? repairMessagesBuilder({ invalidContent, issues, progressLabel })
      : buildJsonRepairMessages(invalidContent, issues, progressLabel),
    temperature,
    response_format: responseFormat,
  });
}

async function collectJsonResponseWithConfig(app, config, request) {
  const maxRetries = request.max_retries ?? 2;
  const totalAttempts = maxRetries + 1;
  const temperature = request.temperature ?? 0.7;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const content = await chatWithConfig(app, config, {
      messages: request.messages,
      temperature,
      response_format: responseFormat,
    });

    try {
      const parsed = parseJsonContent(content);
      const normalized = request.normalizer ? request.normalizer(parsed) : parsed;
      if (request.validator) {
        request.validator(normalized);
      }
      return normalized;
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
        );
        const repairedParsed = parseJsonContent(repairedContent);
        const repairedNormalized = request.normalizer ? request.normalizer(repairedParsed) : repairedParsed;
        if (request.validator) {
          request.validator(repairedNormalized);
        }
        return repairedNormalized;
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
    temperature: request.temperature ?? 0.3,
  };

  if (request.response_format && !options.omitResponseFormat) {
    body.response_format = request.response_format;
  }

  if (options.stream) {
    body.stream = true;
  }

  return body;
}

async function fetchChatCompletion(config, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${trimBaseUrl(config.base_url)}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(config.api_key),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function chatWithConfig(app, config, request) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }

  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }

  const requestId = createRequestId();
  let requestBody = createChatRequestBody(config, request);
  let responseData = null;
  let errorMessage = '';

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'chat-pending',
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    let response = await fetchChatCompletion(config, requestBody);
    if (!response.ok && request.response_format) {
      const detail = await response.text().catch(() => '');
      if (isResponseFormatUnsupported(detail)) {
        requestBody = createChatRequestBody(config, request, { omitResponseFormat: true });
        response = await fetchChatCompletion(config, requestBody);
      } else {
        throw new Error(detail || 'AI 请求失败');
      }
    }

    await ensureOk(response, 'AI 请求失败');
    responseData = await response.json();
    const content = responseData.choices?.[0]?.message?.content || '';
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'chat',
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      content,
      created_at: new Date().toISOString(),
    });
    return content;
  } catch (error) {
    errorMessage = error.name === 'AbortError' ? `AI 请求超时（${AI_REQUEST_TIMEOUT_MS / 1000} 秒）` : error.message;
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'chat-error',
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      error: errorMessage,
      created_at: new Date().toISOString(),
    });
    throw new Error(errorMessage || 'AI 请求失败');
  }
}

async function streamChatWithConfig(app, config, request, onEvent) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }

  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }

  const requestId = createRequestId();
  let requestBody = createChatRequestBody(config, request, { stream: true });
  const rawEvents = [];
  const contentParts = [];

  writeAiLog(app, config, {
    request_id: requestId,
    type: 'stream-pending',
    url: `${trimBaseUrl(config.base_url)}/chat/completions`,
    request: requestBody,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  let response = await fetchChatCompletion(config, requestBody);

  try {
    if (!response.ok && request.response_format) {
      const detail = await response.text().catch(() => '');
      if (isResponseFormatUnsupported(detail)) {
        requestBody = createChatRequestBody(config, request, { stream: true, omitResponseFormat: true });
        response = await fetchChatCompletion(config, requestBody);
      } else {
        throw new Error(detail || 'AI 流式请求失败');
      }
    }

    await ensureOk(response, 'AI 流式请求失败');
  } catch (error) {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'stream-error',
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      error: error.message,
      created_at: new Date().toISOString(),
    });
    throw error;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const emitLine = (line) => {
    if (!line.startsWith('data:')) {
      return;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      return;
    }

    try {
      const data = JSON.parse(payload);
      rawEvents.push(data);
      const chunk = data.choices?.[0]?.delta?.content || '';
      if (chunk) {
        contentParts.push(chunk);
        onEvent({ type: 'chunk', chunk });
      }
    } catch {
      // 忽略供应商偶发的非 JSON SSE 行，避免中断已返回内容。
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach((line) => emitLine(line.trim()));
  }

  buffer.split(/\r?\n/).forEach((line) => emitLine(line.trim()));
  writeAiLog(app, config, {
    request_id: requestId,
    type: 'stream',
    url: `${trimBaseUrl(config.base_url)}/chat/completions`,
    request: requestBody,
    response: rawEvents,
    content: contentParts.join(''),
    created_at: new Date().toISOString(),
  });
  onEvent({ type: 'done' });
}

async function testVolcengineImageModel(config) {
  const imageConfig = config.image_model || {};

  if (!imageConfig.api_key) {
    throw new Error('请先填写火山方舟 API Key');
  }

  if (!imageConfig.model_name) {
    throw new Error('请先填写火山方舟生图模型名称');
  }

  const response = await fetch(`${trimBaseUrl(imageConfig.base_url || 'https://ark.cn-beijing.volces.com/api/v3')}/images/generations`, {
    method: 'POST',
    headers: createHeaders(imageConfig.api_key),
    body: JSON.stringify({
      model: imageConfig.model_name,
      prompt: 'a simple blue dot on a white background',
      size: '2048x2048',
      response_format: 'url',
    }),
  });

  try {
    await ensureOk(response, '火山方舟生图测试失败');
  } catch (error) {
    const message = error.message || '';
    if (message.includes('does not exist') || message.includes('do not have access')) {
      throw new Error(`火山方舟生图模型不可用，请确认模型名称或推理接入点 ID 已开通并可访问。原始错误：${message}`);
    }

    throw error;
  }
  const data = await response.json();
  const imageUrl = data.data?.[0]?.url || '';

  return {
    success: true,
    message: imageUrl ? `测试成功：已生成图片 ${imageUrl}` : '测试成功：已返回生图结果',
    image_url: imageUrl,
  };
}

async function testGoogleImageModel(config) {
  const imageConfig = config.image_model || {};

  if (!imageConfig.api_key) {
    throw new Error('请先填写 Google AI Studio API Key');
  }

  if (!imageConfig.model_name) {
    throw new Error('请先填写 Google 生图模型名称');
  }

  const response = await fetch(`${trimBaseUrl(imageConfig.base_url || 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(imageConfig.model_name)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': imageConfig.api_key,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Create a simple blue dot on a white background.' }],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
  });

  await ensureOk(response, 'Google AI Studio 生图测试失败');
  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.find((part) => part.text)?.text || '';
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  return {
    success: true,
    message: inlineData?.data ? `测试成功：已返回图片${text ? `，${text}` : ''}` : `测试成功：${text || '已返回生成结果'}`,
    image_data: inlineData?.data || '',
    mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png',
  };
}

async function generateVolcengineImage(app, config, request) {
  const imageConfig = config.image_model || {};
  const requestId = createRequestId();
  const requestBody = {
    model: imageConfig.model_name,
    prompt: normalizeImagePrompt(request),
    size: request.size || '2048x2048',
    response_format: 'url',
  };
  let responseData = null;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image-pending',
      provider: 'volcengine',
      url: `${trimBaseUrl(imageConfig.base_url || 'https://ark.cn-beijing.volces.com/api/v3')}/images/generations`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const response = await fetch(`${trimBaseUrl(imageConfig.base_url || 'https://ark.cn-beijing.volces.com/api/v3')}/images/generations`, {
      method: 'POST',
      headers: createHeaders(imageConfig.api_key),
      body: JSON.stringify(requestBody),
    });
    await ensureOk(response, '火山方舟生图失败');
    responseData = await response.json();

    const item = responseData.data?.[0] || {};
    const image = item.b64_json
      ? { buffer: Buffer.from(item.b64_json, 'base64'), mime_type: 'image/png' }
      : item.url
        ? await downloadImage(item.url)
        : null;

    if (!image) {
      throw new Error('火山方舟生图未返回图片数据');
    }

    const saved = saveGeneratedImage(app, image);
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image',
      provider: 'volcengine',
      request: requestBody,
      response: safeImageResponse(responseData),
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image-error',
      provider: 'volcengine',
      request: requestBody,
      response: responseData ? safeImageResponse(responseData) : null,
      error: error.message,
      created_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function generateGoogleImage(app, config, request) {
  const imageConfig = config.image_model || {};
  const requestId = createRequestId();
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: normalizeImagePrompt(request) }],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };
  let responseData = null;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image-pending',
      provider: 'google-ai-studio',
      url: `${trimBaseUrl(imageConfig.base_url || 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(imageConfig.model_name)}:generateContent`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const response = await fetch(`${trimBaseUrl(imageConfig.base_url || 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(imageConfig.model_name)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': imageConfig.api_key,
      },
      body: JSON.stringify(requestBody),
    });
    await ensureOk(response, 'Google AI Studio 生图失败');
    responseData = await response.json();
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
    const inlineData = imagePart?.inlineData || imagePart?.inline_data;

    if (!inlineData?.data) {
      throw new Error('Google AI Studio 生图未返回图片数据');
    }

    const saved = saveGeneratedImage(app, {
      buffer: Buffer.from(inlineData.data, 'base64'),
      mime_type: inlineData.mimeType || inlineData.mime_type || 'image/png',
    });
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image',
      provider: 'google-ai-studio',
      request: requestBody,
      response: safeImageResponse(responseData),
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    writeAiLog(app, config, {
      request_id: requestId,
      type: 'image-error',
      provider: 'google-ai-studio',
      request: requestBody,
      response: responseData ? safeImageResponse(responseData) : null,
      error: error.message,
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

  if (config.image_model?.provider === 'volcengine') {
    return generateVolcengineImage(app, config, request);
  }

  if (config.image_model?.provider === 'google-ai-studio') {
    return generateGoogleImage(app, config, request);
  }

  throw new Error('当前生图服务商暂不支持正文配图');
}

function createAiService({ app, configStore }) {
  return {
    async chat(request) {
      const config = configStore.load();
      return chatWithConfig(app, config, request);
    },

    async requestJson(request) {
      const config = configStore.load();
      return collectJsonResponseWithConfig(app, config, request);
    },

    async collectJsonResponse(request) {
      const config = configStore.load();
      return collectJsonResponseWithConfig(app, config, request);
    },

    async streamChat(request, onEvent) {
      const config = configStore.load();
      return streamChatWithConfig(app, config, request, onEvent);
    },

    async testImageModel(config) {
      if (config.image_model?.provider === 'volcengine') {
        return testVolcengineImageModel(config);
      }

      if (config.image_model?.provider === 'google-ai-studio') {
        return testGoogleImageModel(config);
      }

      throw new Error('当前服务商暂不支持测试');
    },

    getImageModelAvailability() {
      return getImageModelAvailability(configStore.load());
    },

    isDeveloperMode() {
      return Boolean(configStore.load()?.developer_mode);
    },

    async generateImage(request) {
      const config = configStore.load();
      return generateImageWithConfig(app, config, request);
    },

    async listModels(configOverride) {
      const config = configOverride || configStore.load();

      if (!config.api_key) {
        return { success: false, message: '请先填写文本模型 API Key', models: [] };
      }

      const response = await fetch(`${trimBaseUrl(config.base_url)}/models`, {
        method: 'GET',
        headers: createHeaders(config.api_key),
      });

      await ensureOk(response, '获取模型列表失败');
      const data = await response.json();

      return {
        success: true,
        message: '模型列表已更新',
        models: Array.isArray(data.data) ? data.data.map((item) => item.id).filter(Boolean) : [],
      };
    },
  };
}

module.exports = {
  createAiService,
};
