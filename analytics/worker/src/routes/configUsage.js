import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsConfigUsage, queryStatsModelUsage, queryStatsModelUsageSummary } from '../services/analyticsStatsStore.js';
import { isValidProjectName, logQueryError, normalizeText, safeStatsRange } from '../utils.js';

function readModelFilters(url) {
  return {
    provider: normalizeText(url.searchParams.get('provider'), 80),
    endpointHost: normalizeText(url.searchParams.get('endpointHost') || url.searchParams.get('endpoint_host'), 120),
    model: normalizeText(url.searchParams.get('model'), 160),
  };
}

export async function handleConfigUsage(request, env, url) {
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
      usage: await queryStatsConfigUsage(env, projectName, range),
    });
  } catch (error) {
    logQueryError('config-usage', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

export async function handleModelUsage(request, env, url) {
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
    const filters = readModelFilters(url);
    const [usage, summary] = await Promise.all([
      queryStatsModelUsage(env, projectName, range, filters),
      queryStatsModelUsageSummary(env, projectName, range),
    ]);
    return json({
      code: 0,
      projectName,
      range,
      source: range === 'history' ? 'd1' : range === 'today' ? 'analytics_engine' : 'd1+analytics_engine',
      filters,
      usage,
      summary,
    });
  } catch (error) {
    logQueryError('model-usage', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
