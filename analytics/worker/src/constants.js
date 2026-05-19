export const DATASET = 'agnet_analytics';
export const ALLOWED_EVENTS = new Set(['app_open', 'page_view', 'config_usage']);
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
export const NOTICE_KEY_PREFIX = 'project_notice:';
export const NOTICE_TITLE_MAX_LENGTH = 120;
export const NOTICE_CONTENT_MAX_LENGTH = 20000;
export const WORKER_CODE_VERSION = 'notice-time-readable-v1';

export const CONFIG_USAGE_FIELDS = [
  { key: 'fileParserProviders', blob: 'blob9' },
  { key: 'realTimeRender', blob: 'blob10' },
  { key: 'imageProviders', blob: 'blob11' },
  { key: 'imageModelStatuses', blob: 'blob12' },
  { key: 'bidAnalysisModes', blob: 'blob13' },
  { key: 'outlineModes', blob: 'blob14' },
  { key: 'tableRequirements', blob: 'blob15' },
  { key: 'useMermaidImages', blob: 'blob16' },
  { key: 'useAiImages', blob: 'blob17' },
  { key: 'textModelNames', blob: 'blob18' },
  { key: 'imageModelNames', blob: 'blob19' },
];
