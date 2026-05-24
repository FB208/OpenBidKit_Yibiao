import { CONFIG_USAGE_FIELDS, DATASET, MODEL_USAGE_FIELDS } from '../constants.js';
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
      AND blob2 = ${sqlString('config_usage')}
      AND ${field.blob} != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY value
    ORDER BY clients DESC, events DESC, value ASC
    LIMIT 50
  `;
}

function buildModelUsageSql(project, days, field) {
  return `
    SELECT
      blob9 AS provider,
      blob10 AS endpoint_host,
      blob11 AS model,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS events,
      SUM(double2 * _sample_interval) AS prompt_tokens,
      SUM(double3 * _sample_interval) AS completion_tokens,
      SUM(double4 * _sample_interval) AS total_tokens
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = ${sqlString('ai_request')}
      AND blob12 = ${sqlString(field.requestType)}
      AND blob11 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY provider, endpoint_host, model
    ORDER BY total_tokens DESC, events DESC, clients DESC, model ASC
    LIMIT 100
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
    const results = await Promise.all([
      ...CONFIG_USAGE_FIELDS.map((field) => queryAnalytics(env, buildConfigUsageSql(project, days, field))),
      ...MODEL_USAGE_FIELDS.map((field) => queryAnalytics(env, buildModelUsageSql(project, days, field))),
    ]);
    const usage = {};
    CONFIG_USAGE_FIELDS.forEach((field, index) => {
      usage[field.key] = results[index].data || [];
    });
    MODEL_USAGE_FIELDS.forEach((field, index) => {
      usage[field.key] = results[CONFIG_USAGE_FIELDS.length + index].data || [];
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
