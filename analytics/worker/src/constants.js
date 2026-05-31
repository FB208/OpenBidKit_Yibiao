export const DATASET = 'agnet_analytics';
export const ALLOWED_EVENTS = new Set(['app_open', 'page_view', 'config_usage', 'ai_request']);
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
export const NOTICE_KEY_PREFIX = 'project_notice:';
export const NOTICE_TITLE_MAX_LENGTH = 120;
export const NOTICE_CONTENT_MAX_LENGTH = 20000;
export const WORKER_CODE_VERSION = 'github-stats-resilient-v1';
export const GITHUB_REPO_FULL_NAME = 'FB208/OpenBidKit_Yibiao';
export const GITHUB_REPO_STATS_CACHE_KEY = `github_repo_stats:${GITHUB_REPO_FULL_NAME}`;
export const GITHUB_REPO_STATS_CACHE_TTL_SECONDS = 1800;
export const GITHUB_REPO_STATS_STALE_TTL_SECONDS = 604800;

export const CONFIG_USAGE_FIELDS = [
  { key: 'fileParserProviders', blob: 'blob9' },
  { key: 'imageProviders', blob: 'blob11' },
  { key: 'imageModelStatuses', blob: 'blob12' },
  { key: 'bidAnalysisModes', blob: 'blob13' },
  { key: 'outlineModes', blob: 'blob14' },
  { key: 'tableRequirements', blob: 'blob15' },
  { key: 'useMermaidImages', blob: 'blob16' },
  { key: 'useAiImages', blob: 'blob17' },
  { key: 'contentConcurrencies', blob: 'blob18' },
  { key: 'contentGenerationActions', blob: 'blob19' },
  { key: 'minimumWords', blob: 'blob20' },
];

export const MODEL_USAGE_FIELDS = [
  { key: 'textModelUsage', requestType: 'text' },
  { key: 'imageModelUsage', requestType: 'image' },
];
