export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatImageDetail = 'auto' | 'low' | 'high';

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: ChatImageDetail;
  };
}

export interface ChatLocalImageContentPart {
  type: 'local_image';
  path: string;
  detail?: ChatImageDetail;
}

export type ChatContentPart = ChatTextContentPart | ChatImageUrlContentPart | ChatLocalImageContentPart;

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
}

export interface ChatRequestOptions {
  response_format?: { type: 'json_object' };
  timeout_ms?: number;
  timeout_message?: string;
  logTitle?: string;
  log_title?: string;
}

export interface ChatCompletionRequest extends ChatRequestOptions {
  messages: ChatMessage[];
}

export interface JsonCompletionRequest<TInput = unknown> extends ChatRequestOptions {
  messages: ChatMessage[];
  schemaName?: string;
  input?: TInput;
  max_retries?: number;
  progressLabel?: string;
  failureMessage?: string;
}

export interface AiHttpErrorPayload {
  status: number;
  statusText?: string;
  contentType?: string;
  body: string;
  source?: string;
  createdAt?: string;
}
