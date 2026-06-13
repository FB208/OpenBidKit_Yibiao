import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryD1Traffic } from '../services/analyticsD1Query.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { isValidProjectName, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

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
      blob4 AS version,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob4 != ''
      AND blob7 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY version
    ORDER BY version DESC
    LIMIT 50
  `;
  const todayVersionsSql = `
    SELECT
      blob4 AS version,
      COUNT(DISTINCT blob7) AS todayClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob4 != ''
      AND blob7 != ''
      AND toDate(timestamp) = toDate(NOW())
    GROUP BY version
    LIMIT 100
  `;

  try {
    const [pages, versions, todayVersions] = await Promise.all([
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
      queryAnalytics(env, todayVersionsSql),
    ]);
    const todayByVersion = new Map((todayVersions.data || []).map((row) => [row.version, Number(row.todayClients || 0)]));
    return json({
      code: 0,
      projectName,
      days,
      range: 'recent',
      source: 'analytics_engine',
      pages: pages.data || [],
      versions: (versions.data || []).map((row) => ({
        ...row,
        todayClients: todayByVersion.get(row.version) || 0,
      })),
    });
  } catch (error) {
    logQueryError('traffic', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
