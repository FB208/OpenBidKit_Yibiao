const DATASET = 'agnet_analytics';
const ALLOWED_EVENTS = new Set(['app_open', 'page_view', 'config_usage']);
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const NOTICE_KEY_PREFIX = 'project_notice:';
const NOTICE_TITLE_MAX_LENGTH = 120;
const NOTICE_CONTENT_MAX_LENGTH = 20000;
const WORKER_CODE_VERSION = 'notice-time-readable-v1';
const CONFIG_USAGE_FIELDS = [
  { key: 'fileParserProviders', blob: 'blob9' },
  { key: 'realTimeRender', blob: 'blob10' },
  { key: 'imageProviders', blob: 'blob11' },
  { key: 'imageModelStatuses', blob: 'blob12' },
  { key: 'bidAnalysisModes', blob: 'blob13' },
  { key: 'outlineModes', blob: 'blob14' },
  { key: 'tableRequirements', blob: 'blob15' },
  { key: 'useMermaidImages', blob: 'blob16' },
  { key: 'useAiImages', blob: 'blob17' },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeMetricValue(value, maxLength) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return normalizeText(value, maxLength);
}

function isValidProjectName(projectName) {
  return PROJECT_NAME_PATTERN.test(projectName);
}

function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token) && authorization === `Bearer ${token}`;
}

function safeDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(Math.floor(days), 90));
}

function safePage(value) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page));
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysSinceIsoDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return NaN;

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayUtc - date.getTime()) / 86400000);
}

function addIsoDays(value, days) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function datePart(value) {
  return String(value || '').slice(0, 10);
}

function logQueryError(scope, error) {
  console.error(`[analytics] ${scope} query failed`, error?.message || String(error));
}

function buildNoticeKey(projectName) {
  return `${NOTICE_KEY_PREFIX}${projectName}`;
}

function createNoticeId(now) {
  const timestamp = now.replace(/[-: ]/g, '').slice(0, 14);
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `notice-${timestamp}-${random}`;
}

function formatNoticeTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function normalizeNoticeForResponse(notice) {
  if (!notice || typeof notice !== 'object') {
    return null;
  }

  return {
    id: normalizeText(notice.id, 80),
    projectName: normalizeText(notice.projectName, 80),
    enabled: notice.enabled !== false,
    title: normalizeText(notice.title, NOTICE_TITLE_MAX_LENGTH),
    content: normalizeText(notice.content, NOTICE_CONTENT_MAX_LENGTH),
    createdAt: normalizeText(notice.createdAt, 40),
    updatedAt: normalizeText(notice.updatedAt, 40),
  };
}

async function readProjectNotice(env, projectName) {
  if (!env.NOTICE_STORE) {
    return null;
  }

  const raw = await env.NOTICE_STORE.get(buildNoticeKey(projectName));
  if (!raw) {
    return null;
  }

  try {
    return normalizeNoticeForResponse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;
  const response = await fetch(api, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
    },
    body: sql,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        code: 0,
        ok: true,
        workerCodeVersion: WORKER_CODE_VERSION,
        noticeTimeFormat: 'YYYY-MM-DD HH:mm:ss Asia/Shanghai',
        noticeStoreConfigured: Boolean(env.NOTICE_STORE),
      });
    }

    if (url.pathname === '/track') {
      return handleTrack(request, env);
    }

    if (url.pathname === '/notice') {
      return handlePublicNotice(request, env, url);
    }

    if (url.pathname === '/api/projects') {
      return handleProjects(request, env);
    }

    if (url.pathname === '/api/notice') {
      return handleAdminNotice(request, env, url);
    }

    if (url.pathname === '/api/summary') {
      return handleSummary(request, env, url);
    }

    if (url.pathname === '/api/latest') {
      return handleLatest(request, env, url);
    }

    if (url.pathname === '/api/retention') {
      return handleRetention(request, env, url);
    }

    if (url.pathname === '/api/config-usage') {
      return handleConfigUsage(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },
};

async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const projectName = normalizeText(body.projectName || body.project_name, 80);
    const event = normalizeText(body.event, 50);
    const page = normalizeText(body.page, 120);
    const version = normalizeText(body.version, 50);
    const platform = normalizeText(body.platform, 50);
    const arch = normalizeText(body.arch, 50);
    const clientId = normalizeText(body.client_id || body.clientId, 120);
    const clientCreatedAt = normalizeText(body.client_created_at || body.clientCreatedAt, 20);
    const fileParserProvider = normalizeText(body.file_parser_provider || body.fileParserProvider, 50);
    const realTimeRender = normalizeMetricValue(body.real_time_render ?? body.realTimeRender, 20);
    const imageProvider = normalizeText(body.image_provider || body.imageProvider, 50);
    const imageModelStatus = normalizeText(body.image_model_status || body.imageModelStatus, 50);
    const bidAnalysisMode = normalizeText(body.bid_analysis_mode || body.bidAnalysisMode, 50);
    const outlineMode = normalizeText(body.outline_mode || body.outlineMode, 50);
    const tableRequirement = normalizeText(body.table_requirement || body.tableRequirement, 50);
    const useMermaidImages = normalizeMetricValue(body.use_mermaid_images ?? body.useMermaidImages, 20);
    const useAiImages = normalizeMetricValue(body.use_ai_images ?? body.useAiImages, 20);

    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }

    if (!ALLOWED_EVENTS.has(event)) {
      return json({ code: 400, message: 'invalid event' }, { status: 400 });
    }

    if (event === 'page_view' && !page) {
      return json({ code: 400, message: 'missing page' }, { status: 400 });
    }

    env.ANALYTICS.writeDataPoint({
      blobs: [
        projectName,
        event,
        page,
        version,
        platform,
        arch,
        clientId,
        clientCreatedAt,
        fileParserProvider,
        realTimeRender,
        imageProvider,
        imageModelStatus,
        bidAnalysisMode,
        outlineMode,
        tableRequirement,
        useMermaidImages,
        useAiImages,
      ],
      doubles: [1],
      indexes: [projectName],
    });

    return json({ code: 0 });
  } catch {
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}

async function handlePublicNotice(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const notice = await readProjectNotice(env, projectName);
    return json({
      code: 0,
      notice: notice?.enabled && notice.content ? notice : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public notice failed', error?.message || String(error));
    return json({ code: 0, notice: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

async function handleAdminNotice(request, env, url) {
  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  if (!env.NOTICE_STORE) {
    return json({ code: 500, message: 'NOTICE_STORE is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetNotice(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveNotice(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteNotice(env, url);
  }

  return json({ code: 405, message: 'method not allowed' }, { status: 405 });
}

async function handleAdminGetNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const notice = await readProjectNotice(env, projectName);
  return json({ code: 0, notice }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleAdminSaveNotice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const title = normalizeText(body.title, NOTICE_TITLE_MAX_LENGTH);
  const content = normalizeText(body.content || body.markdown, NOTICE_CONTENT_MAX_LENGTH);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (!title) {
    return json({ code: 400, message: 'missing title' }, { status: 400 });
  }

  if (!content) {
    return json({ code: 400, message: 'missing content' }, { status: 400 });
  }

  const now = formatNoticeTime();
  const notice = {
    id: createNoticeId(now),
    projectName,
    enabled: body.enabled !== false,
    title,
    content,
    createdAt: now,
    updatedAt: now,
  };

  await env.NOTICE_STORE.put(buildNoticeKey(projectName), JSON.stringify(notice));
  return json({ code: 0, notice });
}

async function handleAdminDeleteNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  await env.NOTICE_STORE.delete(buildNoticeKey(projectName));
  return json({ code: 0, notice: null });
}

async function handleProjects(request, env) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const sql = `
    SELECT
      blob1 AS projectName
    FROM ${DATASET}
    WHERE timestamp >= NOW() - INTERVAL '90' DAY
    GROUP BY projectName
    ORDER BY projectName ASC
  `;

  try {
    const result = await queryAnalytics(env, sql);
    return json({
      code: 0,
      projects: (result.data || []).map((item) => item.projectName).filter(Boolean),
    });
  } catch (error) {
    logQueryError('projects', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleSummary(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const dailySql = `
    SELECT
      toDate(timestamp) AS date,
      blob2 AS event,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ('app_open', 'page_view')
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date, event
    ORDER BY date ASC, event ASC
  `;

  const pagesSql = `
    SELECT
      blob3 AS page,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'page_view'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY page
    ORDER BY count DESC
    LIMIT 100
  `;

  const versionsSql = `
    SELECT
      blob4 AS version,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob4 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY version
    ORDER BY version DESC
    LIMIT 50
  `;

  const totalClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS totalClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
  `;

  const todayActiveClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS todayActiveClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND toDate(timestamp) = toDate(NOW())
  `;

  const wauSql = `
    SELECT
      COUNT(DISTINCT blob7) AS wau
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '7' DAY
  `;

  const mauSql = `
    SELECT
      COUNT(DISTINCT blob7) AS mau
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '30' DAY
  `;

  const activeClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS activeClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  const newClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS newClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND blob8 != ''
      AND blob8 >= ${sqlString(isoDateDaysAgo(days))}
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  try {
    const [daily, pages, versions, totalClients, todayActiveClients, wau, mau, activeClients, newClients] = await Promise.all([
      queryAnalytics(env, dailySql),
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
      queryAnalytics(env, totalClientsSql),
      queryAnalytics(env, todayActiveClientsSql),
      queryAnalytics(env, wauSql),
      queryAnalytics(env, mauSql),
      queryAnalytics(env, activeClientsSql),
      queryAnalytics(env, newClientsSql),
    ]);
    const clientStats = {
      totalClients: Number(totalClients.data?.[0]?.totalClients || 0),
      todayActiveClients: Number(todayActiveClients.data?.[0]?.todayActiveClients || 0),
      wau: Number(wau.data?.[0]?.wau || 0),
      mau: Number(mau.data?.[0]?.mau || 0),
      activeClients: Number(activeClients.data?.[0]?.activeClients || 0),
      newClients: Number(newClients.data?.[0]?.newClients || 0),
    };

    return json({
      code: 0,
      projectName,
      days,
      totalClients: clientStats.totalClients,
      todayActiveClients: clientStats.todayActiveClients,
      wau: clientStats.wau,
      mau: clientStats.mau,
      activeClients: clientStats.activeClients,
      newClients: clientStats.newClients,
      returningClients: Math.max(0, clientStats.activeClients - clientStats.newClients),
      daily: daily.data || [],
      pages: pages.data || [],
      versions: versions.data || [],
    });
  } catch (error) {
    logQueryError('summary', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleLatest(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const page = safePage(url.searchParams.get('page'));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);

  const totalSql = `
    SELECT
      COUNT() AS total
    FROM ${DATASET}
    WHERE blob1 = ${project}
  `;

  const sql = `
    SELECT
      timestamp,
      blob1 AS projectName,
      blob2 AS event,
      blob3 AS page,
      blob4 AS version,
      blob5 AS platform,
      blob6 AS arch,
      blob7 AS clientId,
      blob8 AS clientCreatedAt
    FROM ${DATASET}
    WHERE blob1 = ${project}
    ORDER BY timestamp DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  try {
    const [latest, total] = await Promise.all([
      queryAnalytics(env, sql),
      queryAnalytics(env, totalSql),
    ]);
    return json({
      code: 0,
      page,
      pageSize,
      total: Number(total.data?.[0]?.total || 0),
      events: latest.data || [],
    });
  } catch (error) {
    logQueryError('latest', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleRetention(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const sql = `
    SELECT
      timestamp,
      blob7 AS clientId,
      blob8 AS clientCreatedAt
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND blob8 != ''
      AND blob8 >= ${sqlString(isoDateDaysAgo(days))}
    ORDER BY timestamp ASC
    LIMIT 50000
  `;

  try {
    const result = await queryAnalytics(env, sql);
    const clients = new Map();

    for (const row of result.data || []) {
      const clientId = String(row.clientId || '');
      const clientCreatedAt = datePart(row.clientCreatedAt);
      const activeDate = datePart(row.timestamp);
      const age = daysSinceIsoDate(clientCreatedAt);
      if (!clientId || !clientCreatedAt || !activeDate || !Number.isFinite(age) || age < 0 || age > days) {
        continue;
      }

      const client = clients.get(clientId) || { clientCreatedAt, activeDates: new Set() };
      client.activeDates.add(activeDate);
      clients.set(clientId, client);
    }

    const buildRow = (day) => {
      let cohortClients = 0;
      let retainedClients = 0;

      for (const client of clients.values()) {
        const age = daysSinceIsoDate(client.clientCreatedAt);
        if (!Number.isFinite(age) || age < day || age > days) {
          continue;
        }

        cohortClients += 1;
        if (client.activeDates.has(addIsoDays(client.clientCreatedAt, day))) {
          retainedClients += 1;
        }
      }

      return {
        day: `D${day}`,
        cohortClients,
        retainedClients,
        retentionRate: cohortClients > 0 ? retainedClients / cohortClients : 0,
      };
    };

    return json({
      code: 0,
      projectName,
      days,
      retention: [
        buildRow(1),
        buildRow(3),
        buildRow(7),
      ],
    });
  } catch (error) {
    logQueryError('retention', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

function buildConfigUsageSql(project, days, field) {
  return `
    SELECT
      ${field.blob} AS value,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS events
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'config_usage'
      AND ${field.blob} != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY value
    ORDER BY clients DESC, events DESC, value ASC
    LIMIT 50
  `;
}

async function handleConfigUsage(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);

  try {
    const results = await Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryAnalytics(env, buildConfigUsageSql(project, days, field))));
    const usage = {};
    CONFIG_USAGE_FIELDS.forEach((field, index) => {
      usage[field.key] = results[index].data || [];
    });

    return json({
      code: 0,
      projectName,
      days,
      usage,
    });
  } catch (error) {
    logQueryError('config-usage', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
