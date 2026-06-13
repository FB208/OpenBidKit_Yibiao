import { ALLOWED_EVENTS } from '../constants.js';
import { isValidProjectName, normalizeMetricValue, normalizeText } from '../utils.js';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const SOURCE_LIVE = 'live';
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const ROLLUP_SHARDS = 16;
const MAX_D1_BATCH_STATEMENTS = 90;

const eventCountColumns = {
  app_open: 'app_open_count',
  page_view: 'page_view_count',
  config_usage: 'config_usage_count',
  ai_request: 'ai_request_count',
  resource_click: 'resource_click_count',
};

const configRollupFields = [
  ['fileParserProviders', 'fileParserProvider'],
  ['enableConsistencyAudit', 'enableConsistencyAudit'],
  ['imageProviders', 'imageProvider'],
  ['imageModelStatuses', 'imageModelStatus'],
  ['bidAnalysisModes', 'bidAnalysisMode'],
  ['outlineModes', 'outlineMode'],
  ['tableRequirements', 'tableRequirement'],
  ['useMermaidImages', 'useMermaidImages'],
  ['useAiImages', 'useAiImages'],
  ['contentConcurrencies', 'contentConcurrency'],
  ['contentGenerationActions', 'contentGenerationAction'],
  ['minimumWords', 'minimumWords'],
];

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeNumberMetricValue(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const number = Number(text);
  if (!Number.isFinite(number)) return '';

  return String(Math.max(0, Math.round(number))).slice(0, maxLength);
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

function datePartsInBusinessZone(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

export function businessDate(date = new Date()) {
  const parts = datePartsInBusinessZone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function businessMonth(date = new Date()) {
  const parts = datePartsInBusinessZone(date);
  return `${parts.year}-${parts.month}`;
}

export function addBusinessDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidDateText(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function hashNumber(value) {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function eventShard(clientId, eventId) {
  return hashNumber(clientId || eventId) % ROLLUP_SHARDS;
}

function normalizeTrackId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function shortHash(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildDimensionKey(type, label) {
  return `${type}_${await shortHash(`${type}:${label}`)}`;
}

function createMetricBlobs(event) {
  const modelProviderBlob = event.event === 'ai_request'
    ? event.aiModelProvider
    : event.event === 'resource_click'
      ? event.resourceKey
      : event.fileParserProvider;
  const modelBaseUrlBlob = event.event === 'ai_request'
    ? event.aiModelEndpointHost
    : event.event === 'config_usage'
      ? event.enableConsistencyAudit
      : '';
  const modelNameBlob = event.event === 'ai_request' ? event.aiModelName : event.imageProvider;
  const requestTypeBlob = event.event === 'ai_request' ? event.aiRequestType : event.imageModelStatus;
  const contentConcurrencyBlob = event.event === 'config_usage' ? event.contentConcurrency : event.textModelName;
  const contentGenerationActionBlob = event.event === 'config_usage' ? event.contentGenerationAction : event.imageModelName;
  const minimumWordsBlob = event.event === 'config_usage' ? event.minimumWords : event.aiRequestType;

  return [
    event.projectName,
    event.event,
    event.page,
    event.version,
    event.platform,
    event.arch,
    event.clientId,
    event.clientCreatedAt,
    modelProviderBlob,
    modelBaseUrlBlob,
    modelNameBlob,
    requestTypeBlob,
    event.bidAnalysisMode,
    event.outlineMode,
    event.tableRequirement,
    event.useMermaidImages,
    event.useAiImages,
    contentConcurrencyBlob,
    contentGenerationActionBlob,
    minimumWordsBlob,
  ];
}

export function normalizeTrackBody(body, now = new Date()) {
  const receivedAt = now.toISOString();
  const activityDate = businessDate(now);
  const month = businessMonth(now);
  const clientCreatedAt = normalizeText(body.client_created_at || body.clientCreatedAt, 20).slice(0, 10);
  const promptTokens = normalizeTokenNumber(body.prompt_tokens ?? body.promptTokens);
  const completionTokens = normalizeTokenNumber(body.completion_tokens ?? body.completionTokens);
  const totalTokens = normalizeTokenNumber(body.total_tokens ?? body.totalTokens) || promptTokens + completionTokens;
  const aiRequestType = normalizeText(body.ai_request_type || body.aiRequestType, 20);
  const aiModelName = normalizeText(body.ai_model_name || body.aiModelName, 160);
  const textModelName = normalizeText(body.text_model_name || body.textModelName, 120) || (aiRequestType === 'text' ? aiModelName : '');
  const imageModelName = normalizeText(body.image_model_name || body.imageModelName, 120) || (aiRequestType === 'image' ? aiModelName : '');
  const eventId = normalizeTrackId();

  const event = {
    eventId,
    projectName: normalizeText(body.projectName || body.project_name, 80),
    event: normalizeText(body.event, 50),
    page: normalizeText(body.page, 120),
    version: normalizeText(body.version, 50),
    platform: normalizeText(body.platform, 50),
    arch: normalizeText(body.arch, 50),
    clientId: normalizeText(body.client_id || body.clientId, 120),
    clientCreatedAt: isValidDateText(clientCreatedAt) ? clientCreatedAt : '',
    fileParserProvider: normalizeText(body.file_parser_provider || body.fileParserProvider, 50),
    imageProvider: normalizeText(body.image_provider || body.imageProvider, 50),
    imageModelStatus: normalizeText(body.image_model_status || body.imageModelStatus, 50),
    bidAnalysisMode: normalizeText(body.bid_analysis_mode || body.bidAnalysisMode, 50),
    outlineMode: normalizeText(body.outline_mode || body.outlineMode, 50),
    tableRequirement: normalizeText(body.table_requirement || body.tableRequirement, 50),
    useMermaidImages: normalizeMetricValue(body.use_mermaid_images ?? body.useMermaidImages, 20),
    useAiImages: normalizeMetricValue(body.use_ai_images ?? body.useAiImages, 20),
    enableConsistencyAudit: normalizeMetricValue(body.enable_consistency_audit ?? body.enableConsistencyAudit, 20),
    contentConcurrency: normalizeNumberMetricValue(body.content_concurrency ?? body.contentConcurrency, 20),
    contentGenerationAction: normalizeText(body.content_generation_action || body.contentGenerationAction, 50),
    minimumWords: normalizeNumberMetricValue(body.minimum_words ?? body.minimumWords, 20),
    textModelName,
    imageModelName,
    aiRequestType,
    aiModelProvider: normalizeText(body.ai_model_provider || body.aiModelProvider, 80),
    aiModelEndpointHost: normalizeBaseUrlHost(body.ai_model_base_url || body.aiModelBaseUrl),
    aiModelName,
    resourceKey: normalizeText(body.resource_key || body.resourceKey, 80),
    promptTokens,
    completionTokens,
    totalTokens,
    receivedAt,
    activityDate,
    month,
    source: SOURCE_LIVE,
  };
  event.shard = eventShard(event.clientId, event.eventId);
  event.blobs = createMetricBlobs(event);
  event.doubles = [1, promptTokens, completionTokens, totalTokens];
  return event;
}

export function validateTrackEvent(event) {
  if (!isValidProjectName(event.projectName)) {
    return 'invalid projectName';
  }
  if (!ALLOWED_EVENTS.has(event.event)) {
    return 'invalid event';
  }
  if (event.event === 'page_view' && !event.page) {
    return 'missing page';
  }
  if (event.event === 'resource_click' && !/^[a-zA-Z0-9._:-]{1,80}$/.test(event.resourceKey)) {
    return 'missing resource_key';
  }
  return '';
}

export function writeAnalyticsDataPoint(env, event) {
  env.ANALYTICS.writeDataPoint({
    blobs: event.blobs,
    doubles: event.doubles,
    indexes: [event.projectName],
  });
}

export async function enqueueAnalyticsRollup(env, event) {
  if (!env.ANALYTICS_ROLLUP_QUEUE) {
    throw new Error('ANALYTICS_ROLLUP_QUEUE is not configured');
  }
  await env.ANALYTICS_ROLLUP_QUEUE.send({ type: 'analytics_event', event });
}

function requireAnalyticsDb(env) {
  if (!env.ANALYTICS_DB) {
    throw new Error('ANALYTICS_DB is not configured');
  }
  return env.ANALYTICS_DB;
}

function businessDateMinus(days) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - days);
  return businessDate(now);
}

function clientCreatedInfo(event) {
  if (event.clientCreatedAt) {
    return {
      reported: event.clientCreatedAt,
      date: event.clientCreatedAt,
      source: 'reported',
    };
  }
  return {
    reported: null,
    date: event.activityDate,
    source: 'first_seen',
  };
}

function addStatement(statements, db, sql, bindings = []) {
  statements.push(db.prepare(sql).bind(...bindings));
}

function incrementMap(map, key, delta) {
  map.set(key, (map.get(key) || 0) + delta);
}

function getEventCountColumn(eventName) {
  return eventCountColumns[eventName] || '';
}

function createAccumulator() {
  return {
    clients: new Map(),
    daily: new Map(),
    monthlyEvents: new Map(),
    monthlyPages: new Map(),
    monthlyVersions: new Map(),
    monthlyConfigs: new Map(),
    monthlyModels: new Map(),
    monthlyResources: new Map(),
    dimensions: new Map(),
    dimensionValues: new Map(),
  };
}

function mergeClient(accumulator, event) {
  if (!event.clientId) return;
  const key = `${event.projectName}\u0001${event.clientId}`;
  const created = clientCreatedInfo(event);
  const current = accumulator.clients.get(key);
  if (!current) {
    accumulator.clients.set(key, {
      projectName: event.projectName,
      clientId: event.clientId,
      reportedClientCreatedDate: created.reported,
      clientCreatedDate: created.date,
      clientCreatedSource: created.source,
      firstSeenAt: event.receivedAt,
      firstSeenDate: event.activityDate,
      firstSeenSource: SOURCE_LIVE,
      lastSeenAt: event.receivedAt,
      lastSeenDate: event.activityDate,
      lastSeenSource: SOURCE_LIVE,
      firstVersion: event.version,
      lastVersion: event.version,
      platform: event.platform,
      arch: event.arch,
    });
    return;
  }

  if (event.receivedAt < current.firstSeenAt) {
    current.firstSeenAt = event.receivedAt;
    current.firstSeenDate = event.activityDate;
    current.firstSeenSource = SOURCE_LIVE;
    current.firstVersion = event.version || current.firstVersion;
  }
  if (event.receivedAt >= current.lastSeenAt) {
    current.lastSeenAt = event.receivedAt;
    current.lastSeenDate = event.activityDate;
    current.lastSeenSource = SOURCE_LIVE;
    current.lastVersion = event.version || current.lastVersion;
    current.platform = event.platform || current.platform;
    current.arch = event.arch || current.arch;
  }
  if (!current.reportedClientCreatedDate && created.reported) {
    current.reportedClientCreatedDate = created.reported;
  }
  if (created.date < current.clientCreatedDate) {
    current.clientCreatedDate = created.date;
    current.clientCreatedSource = created.source;
  }
}

function mergeDaily(accumulator, event) {
  if (!event.clientId) return;
  const key = `${event.projectName}\u0001${event.activityDate}\u0001${event.clientId}`;
  const current = accumulator.daily.get(key) || {
    projectName: event.projectName,
    activityDate: event.activityDate,
    clientId: event.clientId,
    firstSeenAt: event.receivedAt,
    lastSeenAt: event.receivedAt,
    eventCount: 0,
    appOpenCount: 0,
    pageViewCount: 0,
    configUsageCount: 0,
    aiRequestCount: 0,
    resourceClickCount: 0,
  };
  current.firstSeenAt = event.receivedAt < current.firstSeenAt ? event.receivedAt : current.firstSeenAt;
  current.lastSeenAt = event.receivedAt > current.lastSeenAt ? event.receivedAt : current.lastSeenAt;
  current.eventCount += 1;
  current[`${event.event.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}Count`] = (current[`${event.event.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}Count`] || 0) + 1;
  accumulator.daily.set(key, current);
}

function mergeMonthlyEvent(accumulator, event) {
  const key = `${event.projectName}\u0001${event.month}\u0001${event.source}\u0001${event.event}\u0001${event.shard}`;
  const current = accumulator.monthlyEvents.get(key) || {
    projectName: event.projectName,
    month: event.month,
    source: event.source,
    event: event.event,
    shard: event.shard,
    eventCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  current.eventCount += 1;
  current.promptTokens += event.promptTokens;
  current.completionTokens += event.completionTokens;
  current.totalTokens += event.totalTokens;
  accumulator.monthlyEvents.set(key, current);
}

function mergeMonthlyVersion(accumulator, event) {
  if (!event.version) return;
  const key = `${event.projectName}\u0001${event.month}\u0001${event.source}\u0001${event.version}\u0001${event.shard}`;
  const current = accumulator.monthlyVersions.get(key) || {
    projectName: event.projectName,
    month: event.month,
    source: event.source,
    version: event.version,
    shard: event.shard,
    eventCount: 0,
    appOpenCount: 0,
    pageViewCount: 0,
    configUsageCount: 0,
    aiRequestCount: 0,
    resourceClickCount: 0,
  };
  current.eventCount += 1;
  current[`${event.event.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}Count`] = (current[`${event.event.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}Count`] || 0) + 1;
  accumulator.monthlyVersions.set(key, current);
}

function mergeSpecificMonthlyStats(accumulator, event) {
  if (event.event === 'page_view' && event.page) {
    incrementMap(accumulator.monthlyPages, `${event.projectName}\u0001${event.month}\u0001${event.source}\u0001${event.page}\u0001${event.shard}`, 1);
  }

  if (event.event === 'config_usage') {
    for (const [fieldKey, eventKey] of configRollupFields) {
      const value = event[eventKey];
      if (!value) continue;
      incrementMap(accumulator.monthlyConfigs, `${event.projectName}\u0001${event.month}\u0001${event.source}\u0001${fieldKey}\u0001${value}\u0001${event.shard}`, 1);
    }
  }

  if (event.event === 'ai_request' && event.aiRequestType && event.aiModelName) {
    const key = [
      event.projectName,
      event.month,
      event.source,
      event.aiRequestType,
      event.aiModelProvider,
      event.aiModelEndpointHost,
      event.aiModelName,
      event.shard,
    ].join('\u0001');
    const current = accumulator.monthlyModels.get(key) || {
      projectName: event.projectName,
      month: event.month,
      source: event.source,
      requestType: event.aiRequestType,
      provider: event.aiModelProvider,
      endpointHost: event.aiModelEndpointHost,
      model: event.aiModelName,
      shard: event.shard,
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    current.requestCount += 1;
    current.promptTokens += event.promptTokens;
    current.completionTokens += event.completionTokens;
    current.totalTokens += event.totalTokens;
    accumulator.monthlyModels.set(key, current);
  }

  if (event.event === 'resource_click' && event.resourceKey) {
    incrementMap(accumulator.monthlyResources, `${event.projectName}\u0001${event.month}\u0001${event.source}\u0001${event.resourceKey}\u0001${event.shard}`, 1);
  }
}

async function addDimension(accumulator, event, type, label, hitCount = 1) {
  if (!event.clientId || !label) return;
  const dimensionKey = await buildDimensionKey(type, label);
  const key = `${event.projectName}\u0001${type}\u0001${dimensionKey}\u0001${event.clientId}`;
  const current = accumulator.dimensions.get(key) || {
    projectName: event.projectName,
    dimensionType: type,
    dimensionKey,
    clientId: event.clientId,
    firstSeenAt: event.receivedAt,
    firstSeenDate: event.activityDate,
    firstSeenMonth: event.month,
    firstSeenSource: SOURCE_LIVE,
    lastSeenAt: event.receivedAt,
    lastSeenDate: event.activityDate,
    lastSeenSource: SOURCE_LIVE,
    hitCount: 0,
  };
  current.firstSeenAt = event.receivedAt < current.firstSeenAt ? event.receivedAt : current.firstSeenAt;
  current.firstSeenDate = event.activityDate < current.firstSeenDate ? event.activityDate : current.firstSeenDate;
  current.firstSeenMonth = event.month < current.firstSeenMonth ? event.month : current.firstSeenMonth;
  current.lastSeenAt = event.receivedAt > current.lastSeenAt ? event.receivedAt : current.lastSeenAt;
  current.lastSeenDate = event.activityDate > current.lastSeenDate ? event.activityDate : current.lastSeenDate;
  current.lastSeenSource = SOURCE_LIVE;
  current.hitCount += hitCount;
  accumulator.dimensions.set(key, current);
  accumulator.dimensionValues.set(`${event.projectName}\u0001${type}\u0001${dimensionKey}`, {
    projectName: event.projectName,
    dimensionType: type,
    dimensionKey,
    label,
  });
}

async function mergeDimensions(accumulator, event) {
  await addDimension(accumulator, event, 'event', event.event);
  if (event.version) await addDimension(accumulator, event, 'version', event.version);
  if (event.event === 'page_view') await addDimension(accumulator, event, 'page', event.page);
  if (event.event === 'resource_click') await addDimension(accumulator, event, 'resource', event.resourceKey);
  if (event.event === 'ai_request' && event.aiRequestType && event.aiModelName) {
    await addDimension(accumulator, event, 'model', `${event.aiRequestType}|${event.aiModelProvider}|${event.aiModelEndpointHost}|${event.aiModelName}`);
  }
  if (event.event === 'config_usage') {
    for (const [fieldKey, eventKey] of configRollupFields) {
      const value = event[eventKey];
      if (value) await addDimension(accumulator, event, 'config', `${fieldKey}=${value}`);
    }
  }
}

async function buildAccumulator(events) {
  const accumulator = createAccumulator();
  for (const event of events) {
    mergeClient(accumulator, event);
    mergeDaily(accumulator, event);
    mergeMonthlyEvent(accumulator, event);
    mergeMonthlyVersion(accumulator, event);
    mergeSpecificMonthlyStats(accumulator, event);
    await mergeDimensions(accumulator, event);
  }
  return accumulator;
}

async function lockEvent(db, event, now) {
  const existing = await db.prepare(
    'SELECT status, locked_at FROM analytics_processed_events WHERE event_id = ?',
  ).bind(event.eventId).first();

  if (existing?.status === 'done') {
    return false;
  }

  if (existing?.status === 'processing') {
    const lockedAt = Date.parse(existing.locked_at || '');
    if (Number.isFinite(lockedAt) && now.getTime() - lockedAt < LOCK_TIMEOUT_MS) {
      console.warn('[analytics] rollup event is already processing; skipped', event.eventId);
      return false;
    }

    await db.prepare(
      `UPDATE analytics_processed_events
       SET locked_at = ?, received_date = ?, status = 'processing'
       WHERE event_id = ?`,
    ).bind(now.toISOString(), event.activityDate, event.eventId).run();
    return true;
  }

  await db.prepare(
    `INSERT INTO analytics_processed_events (event_id, received_date, status, locked_at, processed_at)
     VALUES (?, ?, 'processing', ?, NULL)`,
  ).bind(event.eventId, event.activityDate, now.toISOString()).run();
  return true;
}

async function lockEvents(db, events) {
  const now = new Date();
  const locked = [];
  const seen = new Set();
  for (const event of events) {
    if (!event?.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (await lockEvent(db, event, now)) {
      locked.push(event);
    }
  }
  return locked;
}

function appendClientStatements(statements, db, accumulator) {
  for (const item of accumulator.clients.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_clients (
        project_name, client_id, reported_client_created_date, client_created_date, client_created_source,
        first_seen_at, first_seen_date, first_seen_source, last_seen_at, last_seen_date, last_seen_source,
        first_version, last_version, platform, arch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, client_id) DO UPDATE SET
        reported_client_created_date = COALESCE(excluded.reported_client_created_date, analytics_clients.reported_client_created_date),
        client_created_date = CASE WHEN excluded.client_created_date < analytics_clients.client_created_date THEN excluded.client_created_date ELSE analytics_clients.client_created_date END,
        client_created_source = CASE WHEN excluded.client_created_date < analytics_clients.client_created_date THEN excluded.client_created_source ELSE analytics_clients.client_created_source END,
        first_seen_at = CASE WHEN excluded.first_seen_at < analytics_clients.first_seen_at THEN excluded.first_seen_at ELSE analytics_clients.first_seen_at END,
        first_seen_date = CASE WHEN excluded.first_seen_date < analytics_clients.first_seen_date THEN excluded.first_seen_date ELSE analytics_clients.first_seen_date END,
        first_seen_source = CASE WHEN excluded.first_seen_at < analytics_clients.first_seen_at THEN excluded.first_seen_source ELSE analytics_clients.first_seen_source END,
        last_seen_at = CASE WHEN excluded.last_seen_at > analytics_clients.last_seen_at THEN excluded.last_seen_at ELSE analytics_clients.last_seen_at END,
        last_seen_date = CASE WHEN excluded.last_seen_date > analytics_clients.last_seen_date THEN excluded.last_seen_date ELSE analytics_clients.last_seen_date END,
        last_seen_source = CASE WHEN excluded.last_seen_at > analytics_clients.last_seen_at THEN excluded.last_seen_source ELSE analytics_clients.last_seen_source END,
        first_version = CASE WHEN analytics_clients.first_version = '' THEN excluded.first_version ELSE analytics_clients.first_version END,
        last_version = CASE WHEN excluded.last_seen_at >= analytics_clients.last_seen_at THEN excluded.last_version ELSE analytics_clients.last_version END,
        platform = CASE WHEN excluded.last_seen_at >= analytics_clients.last_seen_at THEN excluded.platform ELSE analytics_clients.platform END,
        arch = CASE WHEN excluded.last_seen_at >= analytics_clients.last_seen_at THEN excluded.arch ELSE analytics_clients.arch END`, [
      item.projectName,
      item.clientId,
      item.reportedClientCreatedDate,
      item.clientCreatedDate,
      item.clientCreatedSource,
      item.firstSeenAt,
      item.firstSeenDate,
      item.firstSeenSource,
      item.lastSeenAt,
      item.lastSeenDate,
      item.lastSeenSource,
      item.firstVersion,
      item.lastVersion,
      item.platform,
      item.arch,
    ]);
  }
}

function appendDailyStatements(statements, db, accumulator) {
  for (const item of accumulator.daily.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_daily_client_activity (
        project_name, activity_date, client_id, first_seen_at, last_seen_at,
        event_count, app_open_count, page_view_count, config_usage_count, ai_request_count, resource_click_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, activity_date, client_id) DO UPDATE SET
        first_seen_at = CASE WHEN excluded.first_seen_at < analytics_daily_client_activity.first_seen_at THEN excluded.first_seen_at ELSE analytics_daily_client_activity.first_seen_at END,
        last_seen_at = CASE WHEN excluded.last_seen_at > analytics_daily_client_activity.last_seen_at THEN excluded.last_seen_at ELSE analytics_daily_client_activity.last_seen_at END,
        event_count = event_count + excluded.event_count,
        app_open_count = app_open_count + excluded.app_open_count,
        page_view_count = page_view_count + excluded.page_view_count,
        config_usage_count = config_usage_count + excluded.config_usage_count,
        ai_request_count = ai_request_count + excluded.ai_request_count,
        resource_click_count = resource_click_count + excluded.resource_click_count`, [
      item.projectName,
      item.activityDate,
      item.clientId,
      item.firstSeenAt,
      item.lastSeenAt,
      item.eventCount,
      item.appOpenCount,
      item.pageViewCount,
      item.configUsageCount,
      item.aiRequestCount,
      item.resourceClickCount,
    ]);
  }
}

function appendMonthlyStatements(statements, db, accumulator) {
  for (const item of accumulator.monthlyEvents.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_event_stats (project_name, month, source, event, shard, event_count, prompt_tokens, completion_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, event, shard) DO UPDATE SET
        event_count = event_count + excluded.event_count,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens`, [
      item.projectName, item.month, item.source, item.event, item.shard, item.eventCount, item.promptTokens, item.completionTokens, item.totalTokens,
    ]);
  }

  for (const [key, viewCount] of accumulator.monthlyPages.entries()) {
    const [projectName, month, source, page, shard] = key.split('\u0001');
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_page_stats (project_name, month, source, page, shard, view_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, page, shard) DO UPDATE SET view_count = view_count + excluded.view_count`, [
      projectName, month, source, page, Number(shard), viewCount,
    ]);
  }

  for (const item of accumulator.monthlyVersions.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_version_stats (
        project_name, month, source, version, shard, event_count, app_open_count, page_view_count,
        config_usage_count, ai_request_count, resource_click_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, version, shard) DO UPDATE SET
        event_count = event_count + excluded.event_count,
        app_open_count = app_open_count + excluded.app_open_count,
        page_view_count = page_view_count + excluded.page_view_count,
        config_usage_count = config_usage_count + excluded.config_usage_count,
        ai_request_count = ai_request_count + excluded.ai_request_count,
        resource_click_count = resource_click_count + excluded.resource_click_count`, [
      item.projectName,
      item.month,
      item.source,
      item.version,
      item.shard,
      item.eventCount,
      item.appOpenCount,
      item.pageViewCount,
      item.configUsageCount,
      item.aiRequestCount,
      item.resourceClickCount,
    ]);
  }

  for (const [key, reportCount] of accumulator.monthlyConfigs.entries()) {
    const [projectName, month, source, fieldKey, value, shard] = key.split('\u0001');
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_config_stats (project_name, month, source, field_key, value, shard, report_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, field_key, value, shard) DO UPDATE SET report_count = report_count + excluded.report_count`, [
      projectName, month, source, fieldKey, value, Number(shard), reportCount,
    ]);
  }

  for (const item of accumulator.monthlyModels.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_model_stats (
        project_name, month, source, request_type, provider, endpoint_host, model, shard,
        request_count, prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, request_type, provider, endpoint_host, model, shard) DO UPDATE SET
        request_count = request_count + excluded.request_count,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens`, [
      item.projectName,
      item.month,
      item.source,
      item.requestType,
      item.provider,
      item.endpointHost,
      item.model,
      item.shard,
      item.requestCount,
      item.promptTokens,
      item.completionTokens,
      item.totalTokens,
    ]);
  }

  for (const [key, clickCount] of accumulator.monthlyResources.entries()) {
    const [projectName, month, source, resourceKey, shard] = key.split('\u0001');
    addStatement(statements, db, `
      INSERT INTO analytics_monthly_resource_stats (project_name, month, source, resource_key, shard, click_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name, month, source, resource_key, shard) DO UPDATE SET click_count = click_count + excluded.click_count`, [
      projectName, month, source, resourceKey, Number(shard), clickCount,
    ]);
  }
}

function appendDimensionStatements(statements, db, accumulator, nowIso) {
  const totalKeys = new Set();
  for (const item of accumulator.dimensions.values()) {
    totalKeys.add(`${item.projectName}\u0001${item.dimensionType}\u0001${item.dimensionKey}`);
    addStatement(statements, db, `
      INSERT OR IGNORE INTO analytics_dimension_clients (
        project_name, dimension_type, dimension_key, client_id, first_seen_at, first_seen_date, first_seen_month,
        first_seen_source, last_seen_at, last_seen_date, last_seen_source, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
      item.projectName,
      item.dimensionType,
      item.dimensionKey,
      item.clientId,
      item.firstSeenAt,
      item.firstSeenDate,
      item.firstSeenMonth,
      item.firstSeenSource,
      item.lastSeenAt,
      item.lastSeenDate,
      item.lastSeenSource,
    ]);
    addStatement(statements, db, `
      UPDATE analytics_dimension_clients
      SET hit_count = hit_count + ?,
        last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END,
        last_seen_date = CASE WHEN ? > last_seen_date THEN ? ELSE last_seen_date END,
        last_seen_source = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_source END
      WHERE project_name = ? AND dimension_type = ? AND dimension_key = ? AND client_id = ?`, [
      item.hitCount,
      item.lastSeenAt,
      item.lastSeenAt,
      item.lastSeenDate,
      item.lastSeenDate,
      item.lastSeenAt,
      item.lastSeenSource,
      item.projectName,
      item.dimensionType,
      item.dimensionKey,
      item.clientId,
    ]);
  }

  for (const key of totalKeys) {
    const [projectName, dimensionType, dimensionKey] = key.split('\u0001');
    addStatement(statements, db, `
      INSERT INTO analytics_dimension_client_totals (
        project_name, dimension_type, dimension_key, client_count, first_seen_at, last_seen_at
      )
      SELECT project_name, dimension_type, dimension_key, COUNT(*), MIN(first_seen_at), MAX(last_seen_at)
      FROM analytics_dimension_clients
      WHERE project_name = ? AND dimension_type = ? AND dimension_key = ?
      GROUP BY project_name, dimension_type, dimension_key
      ON CONFLICT(project_name, dimension_type, dimension_key) DO UPDATE SET
        client_count = excluded.client_count,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at`, [
      projectName,
      dimensionType,
      dimensionKey,
    ]);
  }

  for (const item of accumulator.dimensionValues.values()) {
    addStatement(statements, db, `
      INSERT INTO analytics_dimension_values (project_name, dimension_type, dimension_key, label, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_name, dimension_type, dimension_key) DO UPDATE SET
        label = excluded.label,
        updated_at = excluded.updated_at`, [
      item.projectName,
      item.dimensionType,
      item.dimensionKey,
      item.label,
      nowIso,
    ]);
  }
}

function appendDoneStatements(statements, db, events, nowIso) {
  for (const event of events) {
    addStatement(statements, db, `
      UPDATE analytics_processed_events
      SET status = 'done', processed_at = ?
      WHERE event_id = ?`, [nowIso, event.eventId]);
  }
}

function buildAccumulatorStatements(db, events, accumulator) {
  const nowIso = new Date().toISOString();
  const statements = [];
  appendClientStatements(statements, db, accumulator);
  appendDailyStatements(statements, db, accumulator);
  appendMonthlyStatements(statements, db, accumulator);
  appendDimensionStatements(statements, db, accumulator, nowIso);
  appendDoneStatements(statements, db, events, nowIso);
  return statements;
}

async function commitEvents(db, events) {
  const accumulator = await buildAccumulator(events);
  const statements = buildAccumulatorStatements(db, events, accumulator);

  if (statements.length > MAX_D1_BATCH_STATEMENTS && events.length > 1) {
    const splitAt = Math.ceil(events.length / 2);
    await commitEvents(db, events.slice(0, splitAt));
    await commitEvents(db, events.slice(splitAt));
    return;
  }

  if (statements.length) {
    await db.batch(statements);
  }
}

export async function consumeAnalyticsRollupBatch(batch, env) {
  const db = requireAnalyticsDb(env);
  const rawEvents = (batch.messages || [])
    .map((message) => message.body?.event || message.body)
    .filter((event) => event?.eventId && event?.projectName && event?.event);
  if (!rawEvents.length) return;

  const lockedEvents = await lockEvents(db, rawEvents);
  if (!lockedEvents.length) return;

  await commitEvents(db, lockedEvents);
}

export function getBusinessToday() {
  return businessDate(new Date());
}

export function getBusinessDateDaysAgo(days) {
  return businessDateMinus(days);
}

export const analyticsRollupConfig = {
  businessTimeZone: BUSINESS_TIME_ZONE,
  sourceLive: SOURCE_LIVE,
};
