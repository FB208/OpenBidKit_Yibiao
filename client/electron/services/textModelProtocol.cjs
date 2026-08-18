const TEXT_API_PROTOCOLS = ['openai-compatible', 'anthropic-messages'];
const DEFAULT_TEXT_API_PROTOCOL = 'openai-compatible';
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic Messages 必填 max_tokens。读配置里的 max_output_tokens，缺省 32768，不从上下文窗口推导。
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const ANTHROPIC_DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;
const ANTHROPIC_CONTINUE_USER_CONTENT = '（继续）';

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function normalizeTextApiProtocol(value, provider) {
  if (provider && provider !== 'custom') {
    return DEFAULT_TEXT_API_PROTOCOL;
  }
  return value === 'anthropic-messages' ? 'anthropic-messages' : DEFAULT_TEXT_API_PROTOCOL;
}

function resolveTextApiProtocol(config) {
  return normalizeTextApiProtocol(config?.api_protocol, config?.text_model_provider);
}

function isAnthropicMessagesProtocol(config) {
  return resolveTextApiProtocol(config) === 'anthropic-messages';
}

function getTextChatUrl(config) {
  const baseUrl = trimBaseUrl(config?.base_url);
  return isAnthropicMessagesProtocol(config)
    ? `${baseUrl}/messages`
    : `${baseUrl}/chat/completions`;
}

function getTextModelsUrl(config) {
  return `${trimBaseUrl(config?.base_url)}/models`;
}

function createTextRequestHeaders(config) {
  if (isAnthropicMessagesProtocol(config)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config?.api_key || '',
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config?.api_key || ''}`,
  };
}

function resolveAnthropicMaxTokens(config, source) {
  const candidates = [source?.max_tokens, config?.max_output_tokens];
  for (const candidate of candidates) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

function extractOpenAiMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }

  return content == null ? '' : String(content);
}

function parseToolArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  if (typeof rawArguments === 'string' && rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 按 OpenAI 惯例 arguments 是 JSON 字符串；解析失败时交给空对象，避免 Anthropic 拒请求。
    }
  }
  return {};
}

function mapOpenAiToolToAnthropic(tool) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const name = fn.name || tool.name;
  if (!name) {
    return null;
  }

  return {
    name,
    description: fn.description || tool.description || '',
    input_schema: fn.parameters || fn.input_schema || tool.parameters || tool.input_schema || {
      type: 'object',
      properties: {},
    },
  };
}

function mapOpenAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return undefined;
  }

  const mapped = tools.map(mapOpenAiToolToAnthropic).filter(Boolean);
  return mapped.length ? mapped : undefined;
}

function mapOpenAiToolChoice(toolChoice) {
  if (toolChoice == null || toolChoice === '') {
    return undefined;
  }
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice !== 'object') {
    return undefined;
  }
  if (toolChoice.type === 'auto' || toolChoice.type === 'any' || toolChoice.type === 'none') {
    return { type: toolChoice.type };
  }
  const name = toolChoice.function?.name || toolChoice.name;
  if ((toolChoice.type === 'function' || toolChoice.type === 'tool') && name) {
    return { type: 'tool', name };
  }
  return undefined;
}

function toAnthropicContentBlocks(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.slice();
  }
  return [];
}

function finalizeAnthropicContent(blocks) {
  if (!blocks.length) {
    return '';
  }
  if (blocks.every((block) => block?.type === 'text')) {
    return blocks.map((block) => block.text).filter(Boolean).join('\n\n');
  }
  return blocks;
}

function appendConversationMessage(conversation, role, content) {
  const last = conversation[conversation.length - 1];
  if (last && last.role === role) {
    last.content = finalizeAnthropicContent(
      toAnthropicContentBlocks(last.content).concat(toAnthropicContentBlocks(content)),
    );
    return;
  }
  conversation.push({ role, content });
}

function collectOpenAiToolCalls(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    return message.tool_calls;
  }
  if (message?.function_call && typeof message.function_call === 'object') {
    return [{
      id: message.function_call.id,
      type: 'function',
      function: message.function_call,
    }];
  }
  return [];
}

function buildAssistantContentBlocks(message) {
  const blocks = [];
  const text = extractOpenAiMessageText(message?.content);
  if (text) {
    blocks.push({ type: 'text', text });
  }

  collectOpenAiToolCalls(message).forEach((call) => {
    const name = call?.function?.name || call?.name;
    if (!name) {
      return;
    }
    blocks.push({
      type: 'tool_use',
      id: call.id || call.tool_call_id || name,
      name,
      input: parseToolArguments(call.function?.arguments ?? call.arguments),
    });
  });

  return blocks;
}

function buildToolResultBlock(message) {
  return {
    type: 'tool_result',
    tool_use_id: message?.tool_call_id || message?.id || message?.name || '',
    content: extractOpenAiMessageText(message?.content),
  };
}

function buildAnthropicMessagesRequest(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
  const systemParts = [];
  const conversation = [];

  sourceMessages.forEach((message) => {
    const role = message?.role;
    if (role === 'system') {
      const text = extractOpenAiMessageText(message?.content);
      if (text) {
        systemParts.push(text);
      }
      return;
    }

    if (role === 'tool' || role === 'function') {
      appendConversationMessage(conversation, 'user', [buildToolResultBlock(message)]);
      return;
    }

    if (role === 'user') {
      appendConversationMessage(conversation, 'user', extractOpenAiMessageText(message?.content));
      return;
    }

    if (role === 'assistant') {
      const blocks = buildAssistantContentBlocks(message);
      appendConversationMessage(conversation, 'assistant', finalizeAnthropicContent(blocks));
    }
  });

  if (conversation[0]?.role === 'assistant') {
    conversation.unshift({ role: 'user', content: ANTHROPIC_CONTINUE_USER_CONTENT });
  }

  const body = {
    model: config?.model_name || source.model,
    max_tokens: resolveAnthropicMaxTokens(config, source),
    messages: conversation,
  };

  if (systemParts.length) {
    body.system = systemParts.join('\n\n');
  }

  const tools = mapOpenAiTools(source.tools);
  if (tools) {
    body.tools = tools;
  }

  const toolChoice = mapOpenAiToolChoice(source.tool_choice);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  if (source.stream) {
    body.stream = true;
  }

  return body;
}

function extractAnthropicTextContent(responseData) {
  const blocks = Array.isArray(responseData?.content) ? responseData.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function extractAnthropicToolCalls(responseData) {
  const blocks = Array.isArray(responseData?.content) ? responseData.content : [];
  return blocks
    .filter((block) => block?.type === 'tool_use' && block.name)
    .map((block) => ({
      id: block.id || block.name,
      type: 'function',
      function: {
        name: block.name,
        arguments: typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input && typeof block.input === 'object' ? block.input : {}),
      },
    }));
}

function mapAnthropicUsage(usage) {
  const source = usage || {};
  const promptTokens = Number(source.input_tokens ?? source.prompt_tokens ?? 0);
  const completionTokens = Number(source.output_tokens ?? source.completion_tokens ?? 0);
  const cachedTokens = Number(source.cache_read_input_tokens ?? 0);

  return {
    prompt_tokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0,
    completion_tokens: Number.isFinite(completionTokens) && completionTokens > 0 ? Math.floor(completionTokens) : 0,
    total_tokens: (Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0)
      + (Number.isFinite(completionTokens) && completionTokens > 0 ? Math.floor(completionTokens) : 0),
    cache_read_input_tokens: Number.isFinite(cachedTokens) && cachedTokens > 0 ? Math.floor(cachedTokens) : 0,
    input_tokens: source.input_tokens,
    output_tokens: source.output_tokens,
  };
}

function mergeAnthropicUsage(current, nextUsage) {
  const mapped = mapAnthropicUsage({
    input_tokens: nextUsage?.input_tokens ?? current.prompt_tokens,
    output_tokens: nextUsage?.output_tokens ?? current.completion_tokens,
    cache_read_input_tokens: nextUsage?.cache_read_input_tokens ?? current.cache_read_input_tokens,
  });
  return mapped;
}

function toInternalChatResult(responseData) {
  const usage = mapAnthropicUsage(responseData?.usage);
  return {
    content: extractAnthropicTextContent(responseData),
    usage,
    responseData,
  };
}

function mapAnthropicStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'end_turn' || reason === 'stop_sequence' || !reason) return 'stop';
  return String(reason);
}

function anthropicMessageToOpenAiCompletion(responseData) {
  const content = extractAnthropicTextContent(responseData);
  const toolCalls = extractAnthropicToolCalls(responseData);
  const usage = mapAnthropicUsage(responseData?.usage);
  const message = {
    role: 'assistant',
    content: content || (toolCalls.length ? null : ''),
  };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return {
    id: responseData?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: responseData?.model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: mapAnthropicStopReason(responseData?.stop_reason),
    }],
    usage,
  };
}

function createAnthropicSseError(payload, data) {
  const message = payload?.error?.message || payload?.message || 'AI 流式请求失败';
  const error = new Error(message);
  error.raw_response_payload = payload;
  error.raw_sse_data = data;
  return error;
}

function parseSseJsonData(data, parseErrorMessage) {
  try {
    return JSON.parse(data);
  } catch (error) {
    const parseError = new Error(`${parseErrorMessage || 'AI 流式响应解析失败'}：${error.message}`);
    parseError.raw_response_body = data;
    throw parseError;
  }
}

function consumeAnthropicSsePayload(payload, handlers) {
  if (payload?.type === 'error' || (payload?.error && !payload?.type)) {
    handlers.onError?.(payload);
    return 'error';
  }

  if (payload?.type === 'message_start') {
    handlers.onMessageStart?.(payload.message);
    return;
  }

  if (payload?.type === 'content_block_start') {
    handlers.onContentBlockStart?.(payload.index, payload.content_block);
    return;
  }

  if (payload?.type === 'content_block_delta') {
    if (payload.delta?.type === 'text_delta') {
      const text = typeof payload.delta.text === 'string' ? payload.delta.text : '';
      if (text) {
        handlers.onTextDelta?.(text);
      }
      return;
    }
    if (payload.delta?.type === 'input_json_delta') {
      const partialJson = typeof payload.delta.partial_json === 'string' ? payload.delta.partial_json : '';
      handlers.onInputJsonDelta?.(payload.index, partialJson);
    }
    return;
  }

  if (payload?.type === 'content_block_stop') {
    handlers.onContentBlockStop?.(payload.index);
    return;
  }

  if (payload?.type === 'message_delta') {
    handlers.onUsage?.(payload.usage);
    if (payload.delta?.stop_reason) {
      handlers.onStopReason?.(payload.delta.stop_reason);
    }
    return;
  }

  if (payload?.type === 'message_stop') {
    handlers.onStop?.();
    return 'done';
  }
}

async function readSseDataLines(response, onData, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error(options.unreadableMessage || 'AI 流式响应不可读');
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = false;

  async function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
      return;
    }

    const data = trimmed.slice(5).trim();
    if (!data) {
      return;
    }

    const result = await onData(data);
    if (result === 'done') {
      done = true;
    }
  }

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      await processLine(line);
      if (done) {
        break;
      }
    }
  }

  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await processLine(line);
      if (done) {
        break;
      }
    }
  }
}

async function readAnthropicMessageStream(response) {
  const contentParts = [];
  let usage = mapAnthropicUsage(null);
  let messageId = '';
  let model = '';

  await readSseDataLines(response, async (data) => {
    if (data === '[DONE]') {
      return 'done';
    }

    const payload = parseSseJsonData(data, 'AI 流式响应解析失败');
    const result = consumeAnthropicSsePayload(payload, {
      onError(errorPayload) {
        throw createAnthropicSseError(errorPayload, data);
      },
      onMessageStart(message) {
        if (message?.id) {
          messageId = message.id;
        }
        if (message?.model) {
          model = message.model;
        }
        if (message?.usage) {
          usage = mergeAnthropicUsage(usage, message.usage);
        }
      },
      onTextDelta(text) {
        contentParts.push(text);
      },
      onUsage(nextUsage) {
        usage = mergeAnthropicUsage(usage, nextUsage);
      },
    });
    return result;
  });

  const content = contentParts.join('');
  return {
    content,
    usage,
    responseData: {
      id: messageId,
      model,
      stream: true,
      content: [{ type: 'text', text: content }],
      usage,
    },
  };
}

function createAnthropicToOpenAiSseStream(source) {
  if (!source?.getReader) {
    throw new Error('AI 流式响应不可读');
  }

  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let buffer = '';
  let completionId = `chatcmpl-${Date.now()}`;
  let usage = mapAnthropicUsage(null);
  let finished = false;
  let stopReason = '';
  let nextToolCallIndex = 0;
  const toolCallIndexByBlock = new Map();

  function encodeSse(payload) {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function chunkPayload(delta, finishReason = null, includeUsage = false) {
    const payload = {
      id: completionId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
    if (includeUsage) {
      payload.usage = usage;
    }
    return payload;
  }

  async function processLine(controller, line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
      return;
    }

    const data = trimmed.slice(5).trim();
    if (!data) {
      return;
    }

    if (data === '[DONE]') {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      finished = true;
      return;
    }

    const payload = parseSseJsonData(data, 'AI 流式响应解析失败');
    const result = consumeAnthropicSsePayload(payload, {
      onError(errorPayload) {
        throw createAnthropicSseError(errorPayload, data);
      },
      onMessageStart(message) {
        if (message?.id) {
          completionId = message.id;
        }
        if (message?.usage) {
          usage = mergeAnthropicUsage(usage, message.usage);
        }
      },
      onContentBlockStart(index, block) {
        if (block?.type !== 'tool_use' || !block.name) {
          return;
        }
        const toolIndex = nextToolCallIndex;
        nextToolCallIndex += 1;
        toolCallIndexByBlock.set(index, toolIndex);
        let argumentsText = '';
        if (block.input && typeof block.input === 'object' && Object.keys(block.input).length) {
          argumentsText = JSON.stringify(block.input);
        }
        controller.enqueue(encodeSse(chunkPayload({
          tool_calls: [{
            index: toolIndex,
            id: block.id || block.name,
            type: 'function',
            function: {
              name: block.name,
              arguments: argumentsText,
            },
          }],
        })));
      },
      onTextDelta(text) {
        controller.enqueue(encodeSse(chunkPayload({ content: text })));
      },
      onInputJsonDelta(index, partialJson) {
        const toolIndex = toolCallIndexByBlock.get(index);
        if (toolIndex == null) {
          return;
        }
        controller.enqueue(encodeSse(chunkPayload({
          tool_calls: [{
            index: toolIndex,
            function: { arguments: partialJson },
          }],
        })));
      },
      onUsage(nextUsage) {
        usage = mergeAnthropicUsage(usage, nextUsage);
      },
      onStopReason(reason) {
        stopReason = reason;
      },
      onStop() {
        controller.enqueue(encodeSse(chunkPayload({}, mapAnthropicStopReason(stopReason), true)));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        finished = true;
      },
    });

    if (result === 'done') {
      finished = true;
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const lines = buffer.split(/\r?\n/);
              for (const line of lines) {
                await processLine(controller, line);
                if (finished) {
                  break;
                }
              }
            }
            if (!finished) {
              controller.enqueue(encodeSse(chunkPayload({}, mapAnthropicStopReason(stopReason), true)));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            await processLine(controller, line);
            if (finished) {
              controller.close();
              return;
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // 上游取消失败不影响代理关闭。
      }
    },
  });
}

function copyUpstreamResponseHeaders(response, fallbackContentType) {
  const headers = {
    'content-type': response.headers.get('content-type') || fallbackContentType,
  };
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    headers['cache-control'] = cacheControl;
  }
  const requestId = response.headers.get('x-request-id');
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return headers;
}

async function translateAnthropicResponseToOpenAI(response, options = {}) {
  if (options.stream) {
    return new Response(createAnthropicToOpenAiSseStream(response.body), {
      status: response.status,
      headers: copyUpstreamResponseHeaders(response, 'text/event-stream; charset=utf-8'),
    });
  }

  const responseData = await response.json();
  return new Response(JSON.stringify(anthropicMessageToOpenAiCompletion(responseData)), {
    status: response.status,
    headers: copyUpstreamResponseHeaders(response, 'application/json; charset=utf-8'),
  });
}

module.exports = {
  TEXT_API_PROTOCOLS,
  DEFAULT_TEXT_API_PROTOCOL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  trimBaseUrl,
  normalizeTextApiProtocol,
  resolveTextApiProtocol,
  isAnthropicMessagesProtocol,
  getTextChatUrl,
  getTextModelsUrl,
  createTextRequestHeaders,
  resolveAnthropicMaxTokens,
  buildAnthropicMessagesRequest,
  extractAnthropicTextContent,
  mapAnthropicUsage,
  toInternalChatResult,
  anthropicMessageToOpenAiCompletion,
  readAnthropicMessageStream,
  translateAnthropicResponseToOpenAI,
};
