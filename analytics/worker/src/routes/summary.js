import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryD1Overview } from '../services/analyticsD1Query.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { isValidProjectName, isoDateDaysAgo, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

const UNKNOWN_VERSION = '未知版本';
const versionExpr = `if(blob4 = '', ${sqlString(UNKNOWN_VERSION)}, blob4)`;
const todayExpr = "formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') = formatDateTime(NOW(), '%Y-%m-%d', 'Asia/Shanghai')";

export async function handleSummary(request, env, url) {
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
      return json(await queryD1Overview(env, projectName, days));
    } catch (error) {
      logQueryError('summary history', error);
      return json({ code: 500, message: 'query failed' }, { status: 500 });
    }
  }

  const project = sqlString(projectName);
  const dailySql = `
    SELECT
      formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') AS date,
      blob2 AS event,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ('app_open', 'page_view')
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date, event
    ORDER BY date ASC, event ASC
  `;

  const dailyClientsSql = `
    SELECT
      formatDateTime(timestamp, '%Y-%m-%d', 'Asia/Shanghai') AS date,
      COUNT(DISTINCT blob7) AS clients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date
    ORDER BY date ASC
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
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND ${todayExpr}
    GROUP BY version
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
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND ${todayExpr}
  `;

  const wauSql = `
    SELECT
      COUNT(DISTINCT blob7) AS wau
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '7' DAY
  `;

  const mauSql = `
    SELECT
      COUNT(DISTINCT blob7) AS mau
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '30' DAY
  `;

  const activeClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS activeClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  const newClientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS newClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND blob8 != ''
      AND blob8 >= ${sqlString(isoDateDaysAgo(days))}
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  try {
    const [daily, dailyClients, pages, versions, todayVersions, totalClients, todayActiveClients, wau, mau, activeClients, newClients] = await Promise.all([
      queryAnalytics(env, dailySql),
      queryAnalytics(env, dailyClientsSql),
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
      queryAnalytics(env, todayVersionsSql),
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
    const todayClientsByVersion = new Map((todayVersions.data || []).map((row) => [row.version || UNKNOWN_VERSION, Number(row.todayClients || 0)]));
    const versionsWithTodayClients = (versions.data || []).map((row) => ({
      ...row,
      version: row.version || UNKNOWN_VERSION,
      todayClients: todayClientsByVersion.get(row.version || UNKNOWN_VERSION) || 0,
    }));
    const existingVersions = new Set(versionsWithTodayClients.map((row) => row.version));
    for (const [version, todayClients] of todayClientsByVersion.entries()) {
      if (!existingVersions.has(version)) {
        versionsWithTodayClients.push({ version, clients: todayClients, count: 0, todayClients });
      }
    }

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
      dailyClients: dailyClients.data || [],
      pages: pages.data || [],
      versions: versionsWithTodayClients,
    });
  } catch (error) {
    logQueryError('summary', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
