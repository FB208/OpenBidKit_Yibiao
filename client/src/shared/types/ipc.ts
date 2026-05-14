import type { AiStreamEvent, ChatCompletionRequest, JsonCompletionRequest } from './ai';
import type { FileImportResult } from './bid';
import type { ClientConfig, ConfigSaveResult, ImageModelTestResult, ModelListResult } from './config';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseEvent, KnowledgeBaseIndex, KnowledgeBaseMutationResult, KnowledgeBaseStartMatchingResult, KnowledgeBaseUploadResult, KnowledgeDocument, KnowledgeFolder, KnowledgeItem } from '../../features/knowledge-base/types';

export interface TaskEvent<TState = unknown> {
  task: unknown;
  technicalPlan: TState;
}

export interface WordExportProgressEvent {
  requestId?: string;
  phase: 'running' | 'success' | 'error' | 'canceled';
  progress: number;
  message: string;
  warnings?: string[];
}

export interface WordExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message?: string;
  warnings?: string[];
}

export interface LatestReleaseInfo {
  version: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

export interface YibiaoBridge {
  appName: string;
  platform: string;
  getVersion: () => Promise<string>;
  getLatestVersion: () => Promise<LatestReleaseInfo>;
  startUpdate: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
  onUpdateProgress: (callback: (event: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (event: { version: string }) => void) => () => void;
  onUpdateError: (callback: (event: { message: string }) => void) => () => void;
  config: {
    load: () => Promise<ClientConfig>;
    save: (config: ClientConfig) => Promise<ConfigSaveResult>;
    listModels: (config?: ClientConfig) => Promise<ModelListResult>;
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
  knowledgeBase: {
    list: () => Promise<KnowledgeBaseIndex>;
    createFolder: (name: string) => Promise<KnowledgeFolder>;
    renameFolder: (folderId: string, name: string) => Promise<KnowledgeFolder>;
    deleteFolder: (folderId: string) => Promise<KnowledgeBaseMutationResult>;
    deleteDocument: (documentId: string) => Promise<KnowledgeBaseMutationResult>;
    uploadDocuments: (folderId: string) => Promise<KnowledgeBaseUploadResult>;
    startMatching: (documentId: string, batchSize: number) => Promise<KnowledgeBaseStartMatchingResult>;
    readMarkdown: (documentId: string) => Promise<string>;
    readItems: (documentId: string) => Promise<KnowledgeItem[]>;
    readAnalysis: (documentId: string) => Promise<KnowledgeAnalysisSnapshot>;
    onEvent: (callback: (event: KnowledgeBaseEvent) => void) => () => void;
  };
  workspace: {
    loadTechnicalPlan: <TState = unknown>() => Promise<TState | null>;
    saveTechnicalPlan: (state: unknown) => Promise<unknown>;
    updateTechnicalPlan: <TState = unknown>(partial: unknown) => Promise<TState>;
    clearTechnicalPlan: () => Promise<unknown>;
  };
  tasks: {
    startBidAnalysis: (payload: unknown) => Promise<unknown>;
    startOutlineGeneration: (payload: unknown) => Promise<unknown>;
    startContentGeneration: (payload: unknown) => Promise<unknown>;
    getActiveTasks: () => Promise<unknown[]>;
    onTaskEvent: <TState = unknown>(callback: (event: TaskEvent<TState>) => void) => () => void;
  };
  export: {
    exportWord: (payload: unknown) => Promise<WordExportResult>;
    onWordExportProgress: (callback: (event: WordExportProgressEvent) => void) => () => void;
  };
}
