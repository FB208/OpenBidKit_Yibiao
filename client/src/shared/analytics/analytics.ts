import type { ClientConfig } from '../types/config';

const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const PROJECT_NAME = 'yibiao-client';
const LEGACY_CLIENT_ID_KEY = 'analytics_client_id';

type AnalyticsEvent = 'app_open' | 'page_view' | 'config_usage';

interface AnalyticsIdentity {
  clientId: string;
  clientCreatedAt: string;
}

interface ConfigUsagePayload {
  file_parser_provider?: string;
  real_time_render?: boolean;
  image_provider?: string;
  image_model_status?: string;
  text_model_name?: string;
  image_model_name?: string;
  bid_analysis_mode?: string;
  outline_mode?: string;
  table_requirement?: string;
  use_mermaid_images?: boolean;
  use_ai_images?: boolean;
}

let appOpenTracked = false;
let lastTrackedPage = '';
let versionPromise: Promise<string> | null = null;
let identityPromise: Promise<AnalyticsIdentity> | null = null;

function getLegacyClientId() {
  try {
    return localStorage.getItem(LEGACY_CLIENT_ID_KEY) || '';
  } catch {
    return '';
  }
}

function removeLegacyClientId() {
  try {
    localStorage.removeItem(LEGACY_CLIENT_ID_KEY);
  } catch {
    // 埋点迁移失败不影响主流程。
  }
}

async function migrateLegacyClientId(config: ClientConfig) {
  const legacyClientId = getLegacyClientId();
  if (!legacyClientId) {
    return config;
  }

  if (config.analytics_client_id === legacyClientId) {
    removeLegacyClientId();
    return config;
  }

  const migratedConfig: ClientConfig = {
    ...config,
    analytics_client_id: legacyClientId,
  };

  try {
    const result = await window.yibiao?.config.save(migratedConfig);
    if (result?.success) {
      removeLegacyClientId();
      return migratedConfig;
    }
  } catch {
    // 保存失败时保留旧 localStorage，后续启动继续尝试迁移。
  }

  return migratedConfig;
}

function getAnalyticsIdentity() {
  if (!identityPromise) {
    identityPromise = window.yibiao?.config.load()
      .then((config) => migrateLegacyClientId(config))
      .then((config) => ({
        clientId: config?.analytics_client_id || '',
        clientCreatedAt: config?.analytics_created_at || '',
      }))
      .catch(() => ({ clientId: '', clientCreatedAt: '' })) || Promise.resolve({ clientId: '', clientCreatedAt: '' });
  }

  return identityPromise;
}

function getPlatform() {
  return window.yibiao?.platform || window.yibiaoClient?.platform || '';
}

function getVersion() {
  if (!versionPromise) {
    versionPromise = window.yibiao?.getVersion?.().catch(() => '') || Promise.resolve('');
  }

  return versionPromise;
}

function booleanText(value: boolean | undefined) {
  if (value === undefined) return undefined;
  return value ? 'true' : 'false';
}

function buildBaseConfigUsage(config?: ClientConfig | null): ConfigUsagePayload {
  return {
    file_parser_provider: config?.file_parser?.provider,
    real_time_render: config ? config.real_time_render !== false : undefined,
    image_provider: config?.image_model?.provider,
    image_model_status: config?.image_model?.status || undefined,
    text_model_name: config?.model_name,
    image_model_name: config?.image_model?.model_name,
  };
}

function normalizeUsagePayload(payload: ConfigUsagePayload) {
  return {
    ...payload,
    real_time_render: booleanText(payload.real_time_render),
    use_mermaid_images: booleanText(payload.use_mermaid_images),
    use_ai_images: booleanText(payload.use_ai_images),
  };
}

function sendAnalytics(event: AnalyticsEvent, page = '', payload: Record<string, unknown> = {}) {
  void Promise.all([getVersion(), getAnalyticsIdentity()]).then(([version, identity]) => {
    fetch(ANALYTICS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectName: PROJECT_NAME,
        event,
        page,
        version,
        platform: getPlatform(),
        arch: '',
        client_id: identity.clientId,
        client_created_at: identity.clientCreatedAt,
        ...payload,
      }),
    }).catch(() => undefined);
  }).catch(() => undefined);
}

export function trackAppOpen() {
  if (appOpenTracked) return;
  appOpenTracked = true;
  sendAnalytics('app_open');
}

export function trackPageView(page: string) {
  const normalizedPage = page.trim();
  if (!normalizedPage || normalizedPage === lastTrackedPage) return;

  lastTrackedPage = normalizedPage;
  sendAnalytics('page_view', normalizedPage);
}

export function trackConfigUsage(payload: ConfigUsagePayload = {}, config?: ClientConfig | null) {
  const send = (loadedConfig?: ClientConfig | null) => {
    sendAnalytics('config_usage', '', normalizeUsagePayload({
      ...buildBaseConfigUsage(loadedConfig),
      ...payload,
    }));
  };

  if (config) {
    send(config);
    return;
  }

  void window.yibiao?.config.load()
    .then((loadedConfig) => send(loadedConfig))
    .catch(() => send(null));
}
