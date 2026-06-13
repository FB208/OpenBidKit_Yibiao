import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryD1Overview } from '../services/analyticsD1Query.js';
import { isValidProjectName, logQueryError, normalizeText, safeDays } from '../utils.js';

export async function handleOverview(request, env, url) {
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

  try {
    return json(await queryD1Overview(env, projectName, days));
  } catch (error) {
    logQueryError('overview', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
