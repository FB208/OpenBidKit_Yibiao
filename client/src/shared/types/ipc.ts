import type { AiStreamEvent, ChatCompletionRequest, JsonCompletionRequest } from './ai';
import type { FileImportResult } from './bid';
import type { ClientConfig, ConfigSaveResult, ImageModelTestResult, ModelListResult } from './config';

export interface TaskEvent<TState = unknown> {
  task: unknown;
  technicalPlan: TState;
}

export interface YibiaoBridge {
  appName: string;
  platform: string;
  config: {
    load: () => Promise<ClientConfig>;
    save: (config: ClientConfig) => Promise<ConfigSaveResult>;
    listModels: () => Promise<ModelListResult>;
    openConfigFolder: () => Promise<{ success: boolean; path: string }>;
  };
  ai: {
    chat: (request: ChatCompletionRequest) => Promise<string>;
    requestJson: <TResult = unknown>(request: JsonCompletionRequest) => Promise<TResult>;
    testImageModel: (config: ClientConfig) => Promise<ImageModelTestResult>;
    streamChat: (request: ChatCompletionRequest, onEvent: (event: AiStreamEvent) => void) => () => void;
  };
  file: {
    importDocument: () => Promise<FileImportResult>;
  };
  workspace: {
    loadTechnicalPlan: <TState = unknown>() => Promise<TState | null>;
    saveTechnicalPlan: (state: unknown) => Promise<unknown>;
    clearTechnicalPlan: () => Promise<unknown>;
  };
  tasks: {
    startBidAnalysis: (payload: unknown) => Promise<unknown>;
    startOutlineGeneration: (payload: unknown) => Promise<unknown>;
    getActiveTasks: () => Promise<unknown[]>;
    onTaskEvent: <TState = unknown>(callback: (event: TaskEvent<TState>) => void) => () => void;
  };
  export: {
    exportWord: (payload: unknown) => Promise<unknown>;
  };
}
