export const DATASET = 'agnet_analytics';
export const ALLOWED_EVENTS = new Set(['app_open', 'page_view', 'config_usage', 'ai_request', 'resource_click', 'agent_runtime']);
export const AGENT_RUNTIME_STATUSES = new Set(['success', 'failed']);
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
export const NOTICE_KEY_PREFIX = 'project_notice:';
export const LICENSE_CONFIG_KEY_PREFIX = 'project_license_config:';
export const NOTICE_TITLE_MAX_LENGTH = 120;
export const NOTICE_CONTENT_MAX_LENGTH = 20000;
export const RESOURCE_TITLE_MAX_LENGTH = 160;
export const RESOURCE_TAGS_MAX_LENGTH = 500;
export const RESOURCE_DESCRIPTION_MAX_LENGTH = 1200;
export const RESOURCE_MODAL_CONTENT_MAX_LENGTH = 50000;
export const RESOURCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const RESOURCE_ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const WORKER_CODE_VERSION = 'stats-redesign-v1';
export const GITHUB_REPO_FULL_NAME = 'FB208/OpenBidKit_Yibiao';
export const GITHUB_REPO_STATS_CACHE_KEY = `github_repo_stats:${GITHUB_REPO_FULL_NAME}`;
export const GITHUB_REPO_STATS_CACHE_TTL_SECONDS = 1800;
export const GITHUB_REPO_STATS_STALE_TTL_SECONDS = 604800;
export const DEFAULT_FREE_LICENSE_DAYS = 30;

export const CONFIG_USAGE_FIELDS = [
  { key: 'fileParserProviders' },
  { key: 'imageProviders' },
  { key: 'imageModelStatuses' },
  { key: 'bidAnalysisModes' },
  { key: 'outlineModes' },
  { key: 'tableRequirements' },
  { key: 'minimumWords' },
  { key: 'contentConcurrencies' },
  { key: 'contentGenerationActions' },
  { key: 'enableConsistencyAudit' },
  { key: 'consistencyRepairModes' },
  { key: 'enableOriginalPlanCoverageAudit' },
  { key: 'useMermaidImages' },
  { key: 'useAiImages' },
];

export const MODEL_USAGE_FIELDS = [
  { key: 'textModelUsage', requestType: 'text' },
  { key: 'imageModelUsage', requestType: 'image' },
];
