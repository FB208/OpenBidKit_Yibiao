import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsTraffic } from '../services/analyticsStatsStore.js';
import { isValidProjectName, logQueryError, normalizeText, safeStatsRange } from '../utils.js';

export async function handleTraffic(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const range = safeStatsRange(url.searchParams.get('range') || url.searchParams.get('days'), 'history');

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    return json({
      code: 0,
      projectName,
      range,
      source: range === 'history' ? 'd1' : 'analytics_engine',
      ...(await queryStatsTraffic(env, projectName, range)),
    });
  } catch (error) {
    logQueryError('traffic', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
