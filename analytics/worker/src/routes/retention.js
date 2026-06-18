import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsRetention } from '../services/analyticsStatsStore.js';
import { isValidProjectName, logQueryError, normalizeText } from '../utils.js';

export async function handleRetention(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    return json(await queryStatsRetention(env, projectName));
  } catch (error) {
    logQueryError('retention', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
