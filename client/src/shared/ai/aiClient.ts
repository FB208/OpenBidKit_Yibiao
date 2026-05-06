import type { AiStreamEvent, ChatCompletionRequest, JsonCompletionRequest } from '../types';

const getBridge = () => {
  if (!window.yibiao) {
    throw new Error('客户端桥接层未初始化');
  }

  return window.yibiao;
};

export const aiClient = {
  chat(request: ChatCompletionRequest): Promise<string> {
    return getBridge().ai.chat(request);
  },

  requestJson<TResult = unknown>(request: JsonCompletionRequest): Promise<TResult> {
    return getBridge().ai.requestJson<TResult>(request);
  },

  streamChat(request: ChatCompletionRequest, onEvent: (event: AiStreamEvent) => void): () => void {
    return getBridge().ai.streamChat(request, onEvent);
  },
};
