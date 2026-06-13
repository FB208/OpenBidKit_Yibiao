import { ALLOWED_EVENTS, DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { businessDateTimeSqlExpression, isValidProjectName, logQueryError, normalizeText, safePage, sqlString } from '../utils.js';

export async function handleLatest(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const page = safePage(url.searchParams.get('page'));
  const event = normalizeText(url.searchParams.get('event'), 50);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  if (!isValidProjectName(projectName) || (event && !ALLOWED_EVENTS.has(event))) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const eventCondition = event ? `AND blob2 = ${sqlString(event)}` : '';

  const totalSql = `
    SELECT
      COUNT() AS total
    FROM ${DATASET}
    WHERE blob1 = ${project}
      ${eventCondition}
  `;

  const sql = `
    SELECT
      ${businessDateTimeSqlExpression()} AS timestamp,
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
      ${eventCondition}
    ORDER BY timestamp DESC, blob7 DESC, blob2 DESC, blob3 DESC
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
      event,
      total: Number(total.data?.[0]?.total || 0),
      events: latest.data || [],
    });
  } catch (error) {
    logQueryError('latest', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
