import type { AiHttpErrorPayload, ChatCompletionRequest, JsonCompletionRequest } from './ai';
import type { DuplicateCheckWorkspaceState, FileSelectionResult } from './bid';
import type { ClientConfig, ConfigSaveResult, ImageModelTestResult, ModelListResult, UpdateChannel } from './config';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseEvent, KnowledgeBaseIndex, KnowledgeBaseIndexMutationResult, KnowledgeBaseMigrationResult, KnowledgeBaseMigrationStatus, KnowledgeBaseMutationResult, KnowledgeBaseRetryDocumentResult, KnowledgeBaseStartMatchingResult, KnowledgeBaseUploadResult, KnowledgeDocument, KnowledgeFolder, KnowledgeItem } from '../../features/knowledge-base/types';
import type { RejectionCheckWorkspaceState, RejectionDocumentRole } from '../../features/rejection-check/types';
import type { BidAnalysisMode, BidAnalysisTaskState, BidSectionMode, ContentGenerationOptions, ContentGenerationPlanState, ContentGenerationRuntimeState, ContentGenerationSectionState, DetectedBidSection, GlobalFactGroupState, SaveOutlineRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../../features/technical-plan/types';
import type { ExportFormatConfig, ExportTemplateRecord } from './exportFormat';
import type { OutlineData, OutlineExpansionMode, OutlineWordControlOptions } from './outline';

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

export interface RequiredOnlineServiceStatus {
  id: string;
  label: string;
  domain: string;
  available: boolean;
  checked: boolean;
}

export interface RequiredOnlineServicesStatus {
  checked: boolean;
  services: RequiredOnlineServiceStatus[];
  unavailableServices: RequiredOnlineServiceStatus[];
}

export interface DeveloperTextTokenStats {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_ratio: number;
}

export interface DeveloperExpansionReplaceTestPayload {
  sectionId: string;
  sectionTitle: string;
  sectionDescription?: string;
  content: string;
  selectedText: string;
}

export interface DeveloperExpansionReplacePatch {
  operation: string;
  anchor?: string;
  target_text?: string;
  content: string;
}

export type DeveloperExpansionReplaceTestStatus = 'replace-success' | 'blocked';

export interface DeveloperExpansionReplaceTestDiagnostics {
  status: DeveloperExpansionReplaceTestStatus;
  matchStrategy: string;
  matchStart: number;
  matchEnd: number;
  matchedText: string;
  targetTextMatched: boolean;
  targetTextKey: string;
  candidateCount: number;
  contentOccurrencesBefore: number;
  contentOccurrencesAfter: number;
  charsBefore: number;
  charsAfter: number;
  deltaChars: number;
  error: string;
}

export interface DeveloperExpansionReplaceTestResult {
  success: boolean;
  status: DeveloperExpansionReplaceTestStatus;
  sectionId: string;
  sectionTitle: string;
  rawPatch: DeveloperExpansionReplacePatch;
  appliedPatch: DeveloperExpansionReplacePatch;
  diagnostics: DeveloperExpansionReplaceTestDiagnostics;
  applyError?: string;
  originalContent: string;
  selectedText: string;
  nextContent: string;
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

export type AgentSelfCheckStepStatus = 'pending' | 'running' | 'success' | 'warning' | 'error' | 'skipped';
export type AgentSelfCheckStatus = 'normal' | 'error' | 'busy';

export type AgentRuntimePhase = 'stopped' | 'starting' | 'idle' | 'running' | 'aborting' | 'unhealthy' | 'restarting' | 'closing';

export interface AgentRuntimeDescriptor {
  id: string;
  display_name: string;
  description: string;
  is_default: boolean;
}

export interface AgentRuntimeActiveTask {
  task_id: string;
  title: string;
  stage: string;
  progress_text: string;
  started_at: string;
  last_activity_at: string;
  last_progress_at?: string;
  elapsed_seconds: number;
  idle_seconds: number;
}

export type LicenseStatusValue = 'missing' | 'active' | 'expired' | 'invalid' | 'invalidated' | 'machine_mismatch' | 'refresh_failed' | 'debug_disabled';

export interface LicenseRuntimeStatus {
  status: LicenseStatusValue | string;
  plan: 'free' | 'personal_premium' | 'enterprise_premium' | string;
  expiresAt: string;
  licenseExpiresAt: string;
  licenseStatus: string;
  activationMode: 'online' | 'offline' | 'debug_disabled' | string;
  sourceTrusted: boolean;
  sourceTrustedText: string;
  untrustedReason: string;
  machineFingerprintHash: string;
  fingerprintVersion: string;
  buildTrusted: boolean;
  buildChanged: boolean;
  buildId: string;
  keyId: string;
  lastCheckedAt: string;
  refreshError?: string;
  config: {
    freeLicenseDays: number;
    expirePopupEnabled: boolean;
    expirePopupDismissible: boolean;
  };
}

export interface LicenseOfflineActivationResult {
  success: boolean;
  canceled?: boolean;
  message: string;
  status: LicenseRuntimeStatus;
}

export interface AgentRuntimeStatus {
  runtime_id: string;
  runtime_name: string;
  selected_runtime_id?: string;
  active_runtime_id?: string;
  phase: AgentRuntimePhase;
  healthy: boolean;
  message: string;
  updated_at: string;
  last_health_at?: string;
  last_health_error?: string;
  restart_pending?: boolean;
  restart_pending_reason?: string;
  active_task?: AgentRuntimeActiveTask | null;
  queued_count?: number;
  queued_tasks?: Array<{
    task_id: string;
    title: string;
    queued_at: string;
    position: number;
    runtime_id: string;
  }>;
  proxy?: {
    active: number;
    queued: number;
    limit: number;
  };
  runtime_details?: Record<string, unknown>;
}

export interface AgentRunFile {
  path: string;
  content: string;
}

export interface AgentRunPayload {
  task_id?: string;
  title?: string;
  task?: string;
  prompt?: string;
  output_file?: string;
  files?: AgentRunFile[];
  timeout_ms?: number;
  max_retries?: number;
  agent?: string;
}

export interface AgentRetryAttempt {
  attempt: number;
  at: string;
  error: string;
  output_chars: number;
}

export interface AgentRunResult {
  success: boolean;
  runtime_id: string;
  status?: 'busy' | string;
  skipped?: boolean;
  message?: string;
  task_id?: string;
  title?: string;
  workspace_dir?: string;
  runtime_workspace_dir?: string;
  runtime_root?: string;
  output_file?: string;
  output_content?: string;
  assistant_text?: string;
  diff?: unknown[];
  session_id?: string;
  retry_count?: number;
  retry_attempts?: AgentRetryAttempt[];
  validation_result?: unknown;
  active_task?: AgentRuntimeActiveTask | null;
  diagnostics?: Record<string, unknown>;
}

export interface AgentSelfCheckStep {
  id: string;
  label: string;
  status: AgentSelfCheckStepStatus;
  message?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface AgentDiagnosticSection {
  id: string;
  title: string;
  status: AgentSelfCheckStepStatus | 'warning';
  summary?: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  items?: Array<{
    id: string;
    label: string;
    status: AgentSelfCheckStepStatus | 'warning';
    message?: string;
    detail?: string;
  }>;
}

export interface AgentSelfCheckResult {
  report_version?: number;
  check_id?: string;
  success: boolean;
  repaired?: boolean;
  runtime_id: string;
  runtime_name: string;
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
  conclusion?: string;
  steps: AgentSelfCheckStep[];
  sections: AgentDiagnosticSection[];
  diagnostics?: Record<string, unknown>;
  error?: Record<string, unknown>;
  model_config?: Record<string, unknown>;
  model_check?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  loopback_check?: Record<string, unknown>;
  tool_check?: Record<string, unknown>;
  agent_check?: Record<string, unknown>;
  session_snapshot?: Record<string, unknown>;
  diagnosis?: Record<string, unknown>;
  repair?: Record<string, unknown>;
  detail_text: string;
  runtime_status?: AgentRuntimeStatus;
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
  requiredOnlineServices: {
    getStatus: () => Promise<RequiredOnlineServicesStatus>;
  };
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
  license: {
    getStatus: () => Promise<LicenseRuntimeStatus>;
    refresh: () => Promise<LicenseRuntimeStatus>;
    importOfflineFile: () => Promise<LicenseOfflineActivationResult>;
    activateOfflineCode: (code: string) => Promise<LicenseOfflineActivationResult>;
  };
  ai: {
    chat: (request: ChatCompletionRequest) => Promise<string>;
    requestJson: <TResult = unknown>(request: JsonCompletionRequest) => Promise<TResult>;
    testImageModel: (config: ClientConfig) => Promise<ImageModelTestResult>;
    onHttpError: (callback: (event: AiHttpErrorPayload) => void) => () => void;
  };
  agent: {
    listRuntimes: () => Promise<AgentRuntimeDescriptor[]>;
    run: (payload: AgentRunPayload, runtimeId?: string) => Promise<AgentRunResult>;
    selfCheck: (runtimeId?: string) => Promise<AgentSelfCheckResult>;
    exportSelfCheckReport: (payload: AgentSelfCheckResult) => Promise<AgentSelfCheckReportExportResult>;
    getStatus: (runtimeId?: string) => Promise<AgentRuntimeStatus>;
    restart: (reason?: string, runtimeId?: string) => Promise<AgentRuntimeStatus>;
    onStatus: (callback: (status: AgentRuntimeStatus) => void) => () => void;
  };
  developerTokenStats: {
    openWindow: () => Promise<{ success: boolean }>;
    get: () => Promise<DeveloperTextTokenStats>;
    reset: () => Promise<DeveloperTextTokenStats>;
    onChanged: (callback: (stats: DeveloperTextTokenStats) => void) => () => void;
  };
  developerExpansionReplaceTest: {
    run: (payload: DeveloperExpansionReplaceTestPayload) => Promise<DeveloperExpansionReplaceTestResult>;
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
    startMatching: (documentId: string, batchSize?: number) => Promise<KnowledgeBaseStartMatchingResult>;
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
    readTenderSourceMarkdown: (sourceId: string) => Promise<string>;
    readOriginalPlanMarkdown: () => Promise<string>;
    updateStep: (step: TechnicalPlanStep) => Promise<TechnicalPlanState>;
    setWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<TechnicalPlanState>;
    switchWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<TechnicalPlanState>;
    saveBidAnalysisConfig: (payload: { mode: BidAnalysisMode; selectedTaskIds: string[]; bidSectionMode?: BidSectionMode }) => Promise<TechnicalPlanState>;
    saveOutlineConfig: (payload: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode?: OutlineExpansionMode; wordControlOptions: OutlineWordControlOptions }) => Promise<TechnicalPlanState>;
    saveOutline: (payload: SaveOutlineRequest) => Promise<TechnicalPlanState>;
    saveGlobalFacts: (globalFacts: GlobalFactGroupState[]) => Promise<TechnicalPlanState>;
    saveContentGenerationOptions: (options: ContentGenerationOptions) => Promise<TechnicalPlanState>;
    saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<TechnicalPlanState>;
    clear: () => Promise<{ success: boolean; message?: string; state: TechnicalPlanState }>;
  };
  duplicateCheck: {
    loadState: () => Promise<DuplicateCheckWorkspaceState>;
    saveFiles: (payload: Pick<DuplicateCheckWorkspaceState, 'tenderFile' | 'tenderFiles' | 'bidFiles'> & Partial<Pick<DuplicateCheckWorkspaceState, 'step' | 'activeAnalysisTab'>>) => Promise<DuplicateCheckWorkspaceState>;
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
  plugins: {
    getAvailablePlugins: () => Promise<AvailablePlugin[]>;
    install: (pluginId: string) => Promise<void>;
    uninstall: (pluginId: string) => Promise<void>;
    enable: (pluginId: string) => Promise<void>;
    disable: (pluginId: string) => Promise<void>;
    update: (pluginId: string) => Promise<void>;
    openConfig: (pluginId: string) => Promise<void>;
    refreshMarket: () => Promise<void>;
  };
}

export interface AvailablePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  repository: string;
  releaseUrl: string;
  tags: string[];
  iconUrl: string;
  downloadCount: number;
  installed: boolean;
  installedVersion?: string;
  enabled: boolean;
  hasConfig: boolean;
  hasUpdate?: boolean;
}


