export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequestOptions {
  temperature?: number;
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
