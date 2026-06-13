import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsClientDetail, queryStatsClients } from '../services/analyticsStatsStore.js';
import { isValidProjectName, logQueryError, normalizeText } from '../utils.js';

function normalizeClientDetailRange(value) {
  const range = normalizeText(value, 20);
  return ['7', '30', 'all'].includes(range) ? range : '7';
}

export async function handleClients(request, env, url) {
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
    return json({ code: 0, projectName, clients: await queryStatsClients(env, projectName) });
  } catch (error) {
    logQueryError('clients', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

export async function handleClientDetail(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const clientId = normalizeText(url.searchParams.get('clientId'), 120);
  const range = normalizeClientDetailRange(url.searchParams.get('range'));
  if (!isValidProjectName(projectName) || !clientId) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  try {
    return json({ code: 0, projectName, ...(await queryStatsClientDetail(env, projectName, clientId, range)) });
  } catch (error) {
    logQueryError('client-detail', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
