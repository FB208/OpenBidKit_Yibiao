import { CONFIG_USAGE_FIELDS, DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { isValidProjectName, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

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

export async function handleConfigUsage(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
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
