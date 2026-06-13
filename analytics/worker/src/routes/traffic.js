import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryD1Traffic } from '../services/analyticsD1Query.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { isValidProjectName, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

const UNKNOWN_VERSION = '未知版本';
const versionExpr = `if(blob4 = '', '${UNKNOWN_VERSION}', blob4)`;
const todayExpr = "formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') = formatDateTime(NOW(), '%Y-%m-%d', 'Asia/Shanghai')";

export async function handleTraffic(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));
  const range = normalizeText(url.searchParams.get('range'), 20);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (range === 'history') {
    try {
      return json({
        code: 0,
        projectName,
        days,
        range: 'history',
        source: 'd1',
        ...(await queryD1Traffic(env, projectName)),
      });
    } catch (error) {
      logQueryError('traffic history', error);
      return json({ code: 500, message: 'query failed' }, { status: 500 });
    }
  }

  const project = sqlString(projectName);
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
      ${versionExpr} AS version,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY version
    ORDER BY version DESC
    LIMIT 50
  `;
  const todayVersionsSql = `
    SELECT
      ${versionExpr} AS version,
      COUNT(DISTINCT blob7) AS todayClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
      AND ${todayExpr}
    GROUP BY version
    LIMIT 100
  `;

  try {
    const [pages, versions, todayVersions] = await Promise.all([
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
      queryAnalytics(env, todayVersionsSql),
    ]);
    const todayByVersion = new Map((todayVersions.data || []).map((row) => [row.version || UNKNOWN_VERSION, Number(row.todayClients || 0)]));
    const versionRows = (versions.data || []).map((row) => ({
      ...row,
      version: row.version || UNKNOWN_VERSION,
      todayClients: todayByVersion.get(row.version || UNKNOWN_VERSION) || 0,
    }));
    const existingVersions = new Set(versionRows.map((row) => row.version));
    for (const [version, todayClients] of todayByVersion.entries()) {
      if (!existingVersions.has(version)) {
        versionRows.push({ version, clients: todayClients, count: 0, todayClients });
      }
    }

    return json({
      code: 0,
      projectName,
      days,
      range: 'recent',
      source: 'analytics_engine',
      pages: pages.data || [],
      versions: versionRows,
    });
  } catch (error) {
    logQueryError('traffic', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
