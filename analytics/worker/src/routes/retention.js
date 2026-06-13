import { DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { addBusinessDateDays, businessDateSqlExpression, datePart, daysSinceBusinessDate, getBusinessDateDaysAgo, isValidProjectName, logQueryError, normalizeText, safeDays, sqlString } from '../utils.js';

export async function handleRetention(request, env, url) {
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
  const sql = `
    SELECT
      ${businessDateSqlExpression()} AS activeDate,
      blob7 AS clientId,
      blob8 AS clientCreatedAt
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND blob8 != ''
      AND blob8 >= ${sqlString(getBusinessDateDaysAgo(days))}
    ORDER BY timestamp ASC
    LIMIT 50000
  `;

  try {
    const result = await queryAnalytics(env, sql);
    const clients = new Map();

    for (const row of result.data || []) {
      const clientId = String(row.clientId || '');
      const clientCreatedAt = datePart(row.clientCreatedAt);
      const activeDate = datePart(row.activeDate);
      const age = daysSinceBusinessDate(clientCreatedAt);
      if (!clientId || !clientCreatedAt || !activeDate || !Number.isFinite(age) || age < 0 || age > days) {
        continue;
      }

      const client = clients.get(clientId) || { clientCreatedAt, activeDates: new Set() };
      client.activeDates.add(activeDate);
      clients.set(clientId, client);
    }

    const buildRow = (day) => {
      let cohortClients = 0;
      let retainedClients = 0;

      for (const client of clients.values()) {
        const age = daysSinceBusinessDate(client.clientCreatedAt);
        if (!Number.isFinite(age) || age < day || age > days) {
          continue;
        }

        cohortClients += 1;
        if (client.activeDates.has(addBusinessDateDays(client.clientCreatedAt, day))) {
          retainedClients += 1;
        }
      }

      return {
        day: `D${day}`,
        cohortClients,
        retainedClients,
        retentionRate: cohortClients > 0 ? retainedClients / cohortClients : 0,
      };
    };

    return json({
      code: 0,
      projectName,
      days,
      retention: [
        buildRow(1),
        buildRow(3),
        buildRow(7),
      ],
    });
  } catch (error) {
    logQueryError('retention', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
