import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsClientDetail, queryStatsClients, queryStatsIpStats } from '../services/analyticsStatsStore.js';
import { addBusinessDateDays, getBusinessToday, isValidProjectName, logQueryError, normalizeText, safePage } from '../utils.js';

function normalizeClientDetailRange(value) {
  const range = normalizeText(value, 20);
  return ['7', '30', 'all'].includes(range) ? range : '7';
}

// 校验管理端使用的北京时间日期筛选值。
function isValidActivityDate(value) {
  return !value || (
    /^\d{4}-\d{2}-\d{2}$/.test(value)
    && addBusinessDateDays(value, 0) === value
    && value <= getBusinessToday()
  );
}

export async function handleClients(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const filters = {
    clientId: normalizeText(url.searchParams.get('clientId'), 120),
    activeFrom: normalizeText(url.searchParams.get('activeFrom'), 10),
    activeTo: normalizeText(url.searchParams.get('activeTo'), 10),
    licensePlan: normalizeText(url.searchParams.get('licensePlan'), 50),
    lastAccessIp: normalizeText(url.searchParams.get('lastAccessIp'), 80),
    lastActiveVersion: normalizeText(url.searchParams.get('lastActiveVersion'), 50),
  };
  const page = safePage(url.searchParams.get('page'));
  const pageSize = 20;
  const validDateRange = isValidActivityDate(filters.activeFrom)
    && isValidActivityDate(filters.activeTo)
    && (!filters.activeFrom || !filters.activeTo || filters.activeFrom <= filters.activeTo);
  if (!isValidProjectName(projectName) || !validDateRange) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  try {
    return json({ code: 0, projectName, ...(await queryStatsClients(env, projectName, filters, page, pageSize)) });
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

export async function handleIpStats(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const activityDate = normalizeText(url.searchParams.get('date'), 10);
  const page = safePage(url.searchParams.get('page'));
  const pageSize = 20;
  const validDate = isValidActivityDate(activityDate);
  if (!isValidProjectName(projectName) || !validDate) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  try {
    return json({
      code: 0,
      projectName,
      date: activityDate,
      ...(await queryStatsIpStats(env, projectName, activityDate, page, pageSize)),
    });
  } catch (error) {
    logQueryError('ip-stats', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
