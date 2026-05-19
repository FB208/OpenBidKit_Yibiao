import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { logQueryError } from '../utils.js';

export async function handleProjects(request, env) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const sql = `
    SELECT
      blob1 AS projectName
    FROM ${DATASET}
    WHERE timestamp >= NOW() - INTERVAL '90' DAY
    GROUP BY projectName
    ORDER BY projectName ASC
  `;

  try {
    const result = await queryAnalytics(env, sql);
    return json({
      code: 0,
      projects: (result.data || []).map((item) => item.projectName).filter(Boolean),
    });
  } catch (error) {
    logQueryError('projects', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
