import type { ChatCompletionRequest, JsonCompletionRequest } from './ai';
import type { DuplicateCheckWorkspaceState, FileSelectionResult } from './bid';
import type { ClientConfig, ConfigSaveResult, ImageModelTestResult, ModelListResult, UpdateChannel } from './config';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseEvent, KnowledgeBaseIndex, KnowledgeBaseIndexMutationResult, KnowledgeBaseMigrationResult, KnowledgeBaseMigrationStatus, KnowledgeBaseMutationResult, KnowledgeBaseRetryDocumentResult, KnowledgeBaseStartMatchingResult, KnowledgeBaseUploadResult, KnowledgeDocument, KnowledgeFolder, KnowledgeItem } from '../../features/knowledge-base/types';
import type { RejectionCheckWorkspaceState, RejectionDocumentRole } from '../../features/rejection-check/types';
import type { BidAnalysisMode, BidAnalysisTaskState, BidSectionMode, ContentGenerationOptions, ContentGenerationPlanState, ContentGenerationRuntimeState, ContentGenerationSectionState, DetectedBidSection, GlobalFactGroupState, SaveOutlineRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../../features/technical-plan/types';
import type { ExportFormatConfig, ExportTemplateRecord } from './exportFormat';
import type { OutlineData, OutlineExpansionMode } from './outline';

export interface TaskEvent<TState = unknown, TRejectionCheckState = unknown, TDuplicateCheckState = unknown> {
  task: unknown;
  technicalPlan?: TState;
  technicalPlanPatch?: Partial<TechnicalPlanState>;
  bidItem?: BidAnalysisTaskState;
  outlineData?: OutlineData | null;
  contentSection?: ContentGenerationSectionState;
  contentPlan?: { nodeId: string; value: ContentGenerationPlanState | null };
  contentRuntime?: ContentGenerationRuntimeState;
  rejectionCheck?: TRejectionCheckState;
  duplicateCheck?: TDuplicateCheckState;
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

export interface DeveloperTextTokenStats {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_ratio: number;
}

export interface LatestReleaseInfo {
  version: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  download_url?: string;
  channel?: UpdateChannel;
}

export interface UpdateCheckResult {
  enabled: boolean;
  updateAvailable: boolean;
  version?: string;
  downloaded?: boolean;
  failed?: boolean;
  message?: string;
  channel?: UpdateChannel;
}

export interface UpdateInstallResult {
  success: boolean;
  message?: string;
}

export interface GpuHardwareAccelerationStatus {
  configured: boolean;
  enabled: boolean;
  currentEnabled: boolean;
  trial: boolean;
  forcedDisabled: boolean;
}

export type WorkspaceDatabasePhase = 'checking' | 'repairing' | 'backing-up' | 'upgrading' | 'ready' | 'error';

export interface WorkspaceDatabaseStatus {
  phase: WorkspaceDatabasePhase;
  ready: boolean;
  message: string;
  updatedAt?: string;
  currentVersion?: number;
  targetVersion?: number;
  migrationVersion?: number;
  migrationDescription?: string;
}

export type AgentSelfCheckStepStatus = 'pending' | 'running' | 'success' | 'error';
export type AgentSelfCheckStatus = 'normal' | 'error';

export interface AgentSelfCheckStep {
  id: string;
  label: string;
  status: AgentSelfCheckStepStatus;
  message?: string;
  updated_at?: string;
}

export interface AgentSelfCheckDiagnostics {
  name?: string;
  message?: string;
  stage?: string;
  stack?: string;
  agent_task_id?: string;
  agent_title?: string;
  agent_workspace_dir?: string;
  agent_runtime_root?: string;
  agent_output_file?: string;
  agent_output_path?: string;
  agent_partial_output_chars?: number;
  agent_partial_output?: string;
  opencode_binary_path?: string;
  opencode_base_url?: string;
  opencode_port?: number;
  opencode_exit_code?: number | null;
  opencode_exit_signal?: string;
  opencode_spawn_error?: string;
  opencode_last_health_error?: string;
  opencode_last_health_cause?: string;
  opencode_stdout_tail?: string;
  opencode_stderr_tail?: string;
  opencode_request_log?: unknown[];
}

export interface AgentSelfCheckEnvironmentSnapshot {
  app?: Record<string, unknown>;
  process?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  opencode?: Record<string, unknown>;
  text_model?: Record<string, unknown>;
}

export interface AgentSelfCheckResult {
  success: boolean;
  status: AgentSelfCheckStatus;
  message: string;
  checked_at: string;
  duration_ms: number;
  log_dir: string;
  log_file: string;
  runtime_root: string;
  workspace_dir: string;
  output_file: string;
  output_path: string;
  output_content?: string;
  opencode_binary_path: string;
  conclusion?: string;
  model_config?: Record<string, unknown>;
  environment?: AgentSelfCheckEnvironmentSnapshot | null;
  direct_model_test?: Record<string, unknown> | null;
  opencode_request_log?: unknown[];
  proxy_diagnostics?: { events: unknown[] };
  workspace_snapshot?: Record<string, unknown> | null;
  agent_result?: Record<string, unknown>;
  steps: AgentSelfCheckStep[];
  diagnostics?: AgentSelfCheckDiagnostics;
  error?: AgentSelfCheckDiagnostics;
  detail_text: string;
}

export interface AgentSelfCheckReportExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message: string;
}

export interface YibiaoBridge {
  appName: string;
  platform: string;
  getVersion: () => Promise<string>;
  getGpuHardwareAccelerationStatus: () => Promise<GpuHardwareAccelerationStatus>;
  saveGpuHardwareAccelerationPreference: (enabled: boolean) => Promise<ConfigSaveResult & { enabled: boolean; configured: boolean; restartRequired: boolean }>;
  startGpuHardwareAccelerationTrial: () => Promise<{ success: boolean }>;
  relaunchWithGpuHardwareAccelerationDisabled: () => Promise<{ success: boolean }>;
  getLatestVersion: () => Promise<LatestReleaseInfo>;
  getUpdateDownloadUrl: () => Promise<string>;
  openExternal: (url: string) => Promise<{ success: boolean; message?: string }>;
  checkUpdate: () => Promise<UpdateCheckResult>;
  startUpdate: () => Promise<UpdateCheckResult>;
  quitAndInstall: () => Promise<UpdateInstallResult>;
  onUpdateProgress: (callback: (event: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (event: { version: string }) => void) => () => void;
  onUpdateError: (callback: (event: { message: string }) => void) => () => void;
  database: {
    getStatus: () => Promise<WorkspaceDatabaseStatus>;
    onStatus: (callback: (status: WorkspaceDatabaseStatus) => void) => () => void;
  };
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
  };
  agent: {
    run: (payload: unknown) => Promise<unknown>;
    selfCheck: () => Promise<AgentSelfCheckResult>;
    exportSelfCheckReport: (payload: AgentSelfCheckResult) => Promise<AgentSelfCheckReportExportResult>;
  };
  developerTokenStats: {
    openWindow: () => Promise<{ success: boolean }>;
    get: () => Promise<DeveloperTextTokenStats>;
    reset: () => Promise<DeveloperTextTokenStats>;
    onChanged: (callback: (stats: DeveloperTextTokenStats) => void) => () => void;
  };
  file: {
    selectDuplicateCheckFiles: (options?: { multiple?: boolean }) => Promise<FileSelectionResult>;
  };
  knowledgeBase: {
    getMigrationStatus: () => Promise<KnowledgeBaseMigrationStatus>;
    migrateLegacy: () => Promise<KnowledgeBaseMigrationResult>;
    list: () => Promise<KnowledgeBaseIndex>;
    createFolder: (name: string) => Promise<KnowledgeFolder>;
    renameFolder: (folderId: string, name: string) => Promise<KnowledgeFolder>;
    reorderFolder: (draggedFolderId: string, targetFolderId: string, position: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    deleteFolder: (folderId: string) => Promise<KnowledgeBaseMutationResult>;
    deleteDocument: (documentId: string) => Promise<KnowledgeBaseMutationResult>;
    moveDocument: (documentId: string, targetFolderId: string, targetDocumentId?: string | null, position?: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    uploadDocuments: (folderId: string) => Promise<KnowledgeBaseUploadResult>;
    retryDocument: (documentId: string) => Promise<KnowledgeBaseRetryDocumentResult>;
    startMatching: (documentId: string, batchSize: number) => Promise<KnowledgeBaseStartMatchingResult>;
    readMarkdown: (documentId: string) => Promise<string>;
    readItems: (documentId: string) => Promise<KnowledgeItem[]>;
    readAnalysis: (documentId: string) => Promise<KnowledgeAnalysisSnapshot>;
    onEvent: (callback: (event: KnowledgeBaseEvent) => void) => () => void;
  };
  technicalPlan: {
    loadState: () => Promise<TechnicalPlanState>;
    importTenderDocument: () => Promise<{
      success: boolean;
      message?: string;
      state?: TechnicalPlanState;
      markdown?: string;
      fileName?: string;
      parserLabel?: string | null;
    }>;
    importOriginalPlanDocument: () => Promise<{
      success: boolean;
      message?: string;
      state?: TechnicalPlanState;
      markdown?: string;
    }>;
    checkBidSections: () => Promise<{ hasMultiple: boolean; totalDeclared?: number | null }>;
    selectBidSection: (selectedSection: DetectedBidSection) => Promise<{ success: boolean; message?: string; state: TechnicalPlanState; markdown: string }>;
    readTenderMarkdown: () => Promise<string>;
    readOriginalPlanMarkdown: () => Promise<string>;
    updateStep: (step: TechnicalPlanStep) => Promise<TechnicalPlanState>;
    setWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<TechnicalPlanState>;
    switchWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<TechnicalPlanState>;
    saveBidAnalysisConfig: (payload: { mode: BidAnalysisMode; selectedTaskIds: string[]; bidSectionMode?: BidSectionMode }) => Promise<TechnicalPlanState>;
    saveOutlineConfig: (payload: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode?: OutlineExpansionMode }) => Promise<TechnicalPlanState>;
    saveOutline: (payload: SaveOutlineRequest) => Promise<TechnicalPlanState>;
    saveGlobalFacts: (globalFacts: GlobalFactGroupState[]) => Promise<TechnicalPlanState>;
    saveContentGenerationOptions: (options: ContentGenerationOptions) => Promise<TechnicalPlanState>;
    saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<TechnicalPlanState>;
    clear: () => Promise<{ success: boolean; message?: string; state: TechnicalPlanState }>;
  };
  duplicateCheck: {
    loadState: () => Promise<DuplicateCheckWorkspaceState>;
    saveFiles: (payload: Pick<DuplicateCheckWorkspaceState, 'tenderFile' | 'bidFiles'> & Partial<Pick<DuplicateCheckWorkspaceState, 'step' | 'activeAnalysisTab'>>) => Promise<DuplicateCheckWorkspaceState>;
    saveUiState: (payload: Partial<Pick<DuplicateCheckWorkspaceState, 'step' | 'activeAnalysisTab'>>) => Promise<DuplicateCheckWorkspaceState>;
    updateState: (partial: Partial<DuplicateCheckWorkspaceState>) => Promise<DuplicateCheckWorkspaceState>;
    clear: () => Promise<{ success: boolean; message?: string; state: DuplicateCheckWorkspaceState }>;
  };
  rejectionCheck: {
    loadState: () => Promise<RejectionCheckWorkspaceState>;
    importDocument: (role: RejectionDocumentRole) => Promise<{ success: boolean; message?: string; state: RejectionCheckWorkspaceState }>;
    importTenderFromTechnicalPlan: () => Promise<{ success: boolean; message?: string; state: RejectionCheckWorkspaceState }>;
    removeDocument: (role: RejectionDocumentRole, documentId?: string) => Promise<RejectionCheckWorkspaceState>;
    saveUiState: (payload: Partial<Pick<RejectionCheckWorkspaceState, 'step' | 'activeDocumentTab' | 'activeResultTab' | 'activeCheckResultTab' | 'customCheckItems' | 'checkOptions'>>) => Promise<RejectionCheckWorkspaceState>;
    updateState: (partial: Partial<RejectionCheckWorkspaceState>) => Promise<RejectionCheckWorkspaceState>;
    clear: () => Promise<{ success: boolean; message?: string; state: RejectionCheckWorkspaceState }>;
  };
  templates: {
    list: () => Promise<ExportTemplateRecord[]>;
    get: (templateId: string) => Promise<ExportTemplateRecord | null>;
    create: (config: ExportFormatConfig) => Promise<ExportTemplateRecord>;
    update: (templateId: string, config: ExportFormatConfig) => Promise<ExportTemplateRecord>;
    delete: (templateId: string) => Promise<{ success: boolean; message: string }>;
  };
  tasks: {
    startBidSectionExtraction: (payload?: unknown) => Promise<unknown>;
    startBidAnalysis: (payload: unknown) => Promise<unknown>;
    startOutlineGeneration: (payload: unknown) => Promise<unknown>;
    startGlobalFactsGeneration: (payload: unknown) => Promise<unknown>;
    startContentGeneration: (payload: unknown) => Promise<unknown>;
    pauseContentGeneration: () => Promise<unknown>;
    startRejectionItemsExtraction: (payload: unknown) => Promise<unknown>;
    startRejectionCheck: (payload: unknown) => Promise<unknown>;
    startDuplicateAnalysis: (payload: unknown) => Promise<unknown>;
    getActiveTasks: () => Promise<unknown[]>;
    onTaskEvent: <TState = unknown, TRejectionCheckState = unknown, TDuplicateCheckState = unknown>(callback: (event: TaskEvent<TState, TRejectionCheckState, TDuplicateCheckState>) => void) => () => void;
  };
  export: {
    exportWord: (payload: unknown) => Promise<WordExportResult>;
    openFile: (filePath: string) => Promise<{ success: boolean }>;
    onWordExportProgress: (callback: (event: WordExportProgressEvent) => void) => () => void;
  };
  systemFonts: {
    list: () => Promise<string[]>;
  };
}
