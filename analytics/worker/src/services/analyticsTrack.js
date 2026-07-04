import { AGENT_RUNTIME_STATUSES, ALLOWED_EVENTS } from '../constants.js';
import { isValidProjectName, normalizeMetricValue, normalizeText } from '../utils.js';

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeBaseUrlHost(value) {
  const text = normalizeText(value, 200);
  if (!text) return '';

  try {
    return normalizeText(new URL(text).hostname.toLowerCase(), 120);
  } catch {
    return normalizeText(text.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase(), 120);
  }
}

function isIpv4(value) {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function isPseudoIpv4(value) {
  if (!isIpv4(value)) return false;
  const first = Number(String(value).split('.')[0]);
  return first >= 240 && first <= 255;
}

function isSingleIp(value) {
  return Boolean(value) && !/[\s,]/.test(value);
}

function normalizeClientIp(request) {
  const connectingIp = normalizeText(request?.headers?.get('CF-Connecting-IP'), 80);
  const connectingIpv6 = normalizeText(request?.headers?.get('CF-Connecting-IPv6'), 80);

  if (isPseudoIpv4(connectingIp)) {
    return isSingleIp(connectingIpv6) ? connectingIpv6 : '';
  }

  return isSingleIp(connectingIp) ? connectingIp : '';
}

function createMetricBlobs(event) {
  const blob9 = event.event === 'ai_request'
    ? event.aiModelProvider
    : event.event === 'resource_click'
      ? event.resourceKey
      : event.event === 'config_usage'
        ? event.configKey
        : event.event === 'agent_runtime'
          ? event.agentRuntimeStatus
          : '';
  const blob10 = event.event === 'ai_request'
    ? event.aiModelEndpointHost
    : event.event === 'config_usage'
      ? event.configValue
      : '';
  const blob11 = event.event === 'ai_request' ? event.aiModelName : '';
  const blob12 = event.event === 'ai_request' ? event.aiRequestType : '';

  return [
    event.projectName,
    event.event,
    event.page,
    event.version,
    event.platform,
    event.arch,
    event.clientId,
    event.clientCreatedAt,
    blob9,
    blob10,
    blob11,
    blob12,
    event.clientIp,
    event.licenseStatus,
    event.licensePlan,
    event.licenseExpiresAt,
    event.sourceTrusted,
    event.untrustedReason,
    '',
    '',
  ];
}

export function normalizeTrackBody(body, request) {
  const promptTokens = normalizeTokenNumber(body.prompt_tokens ?? body.promptTokens);
  const completionTokens = normalizeTokenNumber(body.completion_tokens ?? body.completionTokens);
  const totalTokens = normalizeTokenNumber(body.total_tokens ?? body.totalTokens) || promptTokens + completionTokens;
  const aiRequestType = normalizeText(body.ai_request_type || body.aiRequestType, 20);
  const aiModelName = normalizeText(body.ai_model_name || body.aiModelName, 160);

  const event = {
    projectName: normalizeText(body.projectName || body.project_name, 80),
    event: normalizeText(body.event, 50),
    page: normalizeText(body.page, 120),
    version: normalizeText(body.version, 50),
    platform: normalizeText(body.platform, 50),
    arch: normalizeText(body.arch, 50),
    clientId: normalizeText(body.client_id || body.clientId, 120),
    clientCreatedAt: normalizeText(body.client_created_at || body.clientCreatedAt, 20).slice(0, 10),
    clientIp: normalizeClientIp(request),
    configKey: normalizeText(body.config_key || body.configKey, 80),
    configValue: normalizeMetricValue(body.config_value ?? body.configValue, 200),
    aiRequestType,
    aiModelProvider: normalizeText(body.ai_model_provider || body.aiModelProvider, 80),
    aiModelEndpointHost: normalizeBaseUrlHost(body.ai_model_base_url || body.aiModelBaseUrl),
    aiModelName,
    resourceKey: normalizeText(body.resource_key || body.resourceKey, 80),
    agentRuntimeStatus: normalizeText(body.agent_runtime_status || body.agentRuntimeStatus, 20),
    licenseStatus: normalizeText(body.license_status || body.licenseStatus, 30),
    licensePlan: normalizeText(body.license_plan || body.licensePlan, 40),
    licenseExpiresAt: normalizeText(body.license_expires_at || body.licenseExpiresAt, 20).slice(0, 10),
    sourceTrusted: normalizeText(body.source_trusted ?? body.sourceTrusted, 20),
    untrustedReason: normalizeText(body.untrusted_reason || body.untrustedReason, 80),
    promptTokens,
    completionTokens,
    totalTokens,
  };
  event.blobs = createMetricBlobs(event);
  event.doubles = [1, promptTokens, completionTokens, totalTokens];
  return event;
}

export function validateTrackEvent(event) {
  if (!isValidProjectName(event.projectName)) return 'invalid projectName';
  if (!ALLOWED_EVENTS.has(event.event)) return 'invalid event';
  if (event.event === 'agent_runtime' && !AGENT_RUNTIME_STATUSES.has(event.agentRuntimeStatus)) return 'invalid agent_runtime_status';
  if (!event.clientId) return 'missing client_id';
  if (!event.clientCreatedAt) return 'missing client_created_at';
  if (!event.version) return 'missing version';
  return '';
}

export function writeAnalyticsDataPoint(env, event) {
  env.ANALYTICS.writeDataPoint({
    blobs: event.blobs,
    doubles: event.doubles,
    indexes: [event.projectName],
  });
}
