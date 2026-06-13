import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryStatsProjects } from '../services/analyticsStatsStore.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { businessDateRangeCondition, getBusinessDateDaysAgo, getBusinessToday, logQueryError } from '../utils.js';

export async function handleProjects(request, env) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (env.ANALYTICS_DB) {
    try {
      const projects = await queryStatsProjects(env);
      if (projects.length) {
        return json({ code: 0, projects, source: 'd1' });
      }
    } catch (error) {
      logQueryError('projects d1', error);
    }
  }

  const sql = `
    SELECT
      blob1 AS projectName
    FROM ${DATASET}
    WHERE ${businessDateRangeCondition(getBusinessDateDaysAgo(89), getBusinessToday())}
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
