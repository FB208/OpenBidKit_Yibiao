import { businessDateSqlExpression, formatBusinessDateTime, getBusinessToday, normalizeText, sqlString } from '../utils.js';

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

function ruleProjectName(rule) {
  return rule.type === 'version' ? normalizeText(rule.projectName, 80) : '';
}

// 读取当前项目可管理的全局 IP 与项目版本规则。
export async function listBlockRules(env, projectName) {
  const db = requireStatsDb(env);
  const result = await db.prepare(`
    SELECT
      'ip' AS type,
      ip AS value,
      '' AS projectName,
      reason,
      created_at AS createdAt
    FROM ip_blocks
    UNION ALL
    SELECT
      'version' AS type,
      version AS value,
      version_blocks.project_name AS projectName,
      reason,
      created_at AS createdAt
    FROM version_blocks
    WHERE version_blocks.project_name = ?
    ORDER BY createdAt DESC, type ASC, value ASC
  `).bind(projectName).all();
  return result.results || [];
}

// 新增规则；重复提交只更新原因并保留首次生效日期。
export async function saveBlockRule(env, rule, reason) {
  const db = requireStatsDb(env);
  const createdAt = formatBusinessDateTime(new Date());
  if (rule.type === 'ip') {
    await db.prepare(`
      INSERT INTO ip_blocks (ip, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason
    `).bind(rule.value, normalizeText(reason, 500), createdAt).run();
  } else {
    await db.prepare(`
      INSERT INTO version_blocks (project_name, version, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_name, version) DO UPDATE SET reason = excluded.reason
    `).bind(rule.projectName, rule.value, normalizeText(reason, 500), createdAt).run();
  }
}

// 清理规则当天实时写入 D1 的新客户端，不改动已由 Cron 汇总的历史表。
export async function cleanupTodayBlockRuleClients(env, rule, projectName) {
  const db = requireStatsDb(env);
  const businessDate = getBusinessToday();
  const clientRuleWhere = rule.type === 'ip'
    ? 'clients.last_access_ip = ?'
    : 'clients.project_name = ? AND clients.last_active_version = ?';
  const deleteRuleWhere = rule.type === 'ip'
    ? 'last_access_ip = ?'
    : 'project_name = ? AND last_active_version = ?';
  const ruleBindings = rule.type === 'ip' ? [rule.value] : [projectName, rule.value];
  const statements = [
    db.prepare(`
      DELETE FROM stats_client_activity
      WHERE activity_date = ?
        AND EXISTS (
          SELECT 1
          FROM stats_clients AS clients
          WHERE clients.project_name = stats_client_activity.project_name
            AND clients.client_id = stats_client_activity.client_id
            AND substr(clients.created_at, 1, 10) = ?
            AND clients.last_active_date = ?
            AND ${clientRuleWhere}
        )
    `).bind(businessDate, businessDate, businessDate, ...ruleBindings),
    db.prepare(`
      DELETE FROM stats_clients
      WHERE substr(created_at, 1, 10) = ?
        AND last_active_date = ?
        AND ${deleteRuleWhere}
    `).bind(businessDate, businessDate, ...ruleBindings),
    db.prepare(`
      UPDATE stats_totals
      SET total_clients = (
          SELECT COUNT(*) FROM stats_clients
          WHERE stats_clients.project_name = stats_totals.project_name
        ),
        updated_at = ?
      ${rule.type === 'ip' ? '' : 'WHERE project_name = ?'}
    `).bind(formatBusinessDateTime(new Date()), ...(rule.type === 'ip' ? [] : [projectName])),
  ];
  const results = await db.batch(statements);
  return { businessDate, removedClients: Number(results[1]?.meta?.changes || 0) };
}

// 解除活动规则；不再维护历史清理状态。
export async function deleteBlockRule(env, rule) {
  const db = requireStatsDb(env);
  const projectName = ruleProjectName(rule);
  const activeTable = rule.type === 'ip' ? 'ip_blocks' : 'version_blocks';
  const activeWhere = rule.type === 'ip' ? 'ip = ?' : 'project_name = ? AND version = ?';
  const activeBindings = rule.type === 'ip' ? [rule.value] : [projectName, rule.value];
  const statements = [
    db.prepare(`DELETE FROM ${activeTable} WHERE ${activeWhere}`).bind(...activeBindings),
  ];
  if (rule.type === 'ip') {
    statements.push(db.prepare('DELETE FROM stats_blocked_clients WHERE blocked_ip = ?').bind(rule.value));
  }
  const results = await db.batch(statements);
  return Number(results[0]?.meta?.changes || 0) > 0;
}

// 按项目和大小写敏感的版本值判断埋点是否应静默丢弃；D1 异常时保留原始埋点。
export async function isTrackVersionBlocked(env, projectName, version) {
  try {
    const row = await requireStatsDb(env).prepare(`
      SELECT 1
      FROM version_blocks
      WHERE project_name = ? AND version = ?
      LIMIT 1
    `).bind(projectName, version).first();
    return Boolean(row);
  } catch (error) {
    console.warn('[analytics] version block lookup failed; track event preserved', error?.message || String(error));
    return false;
  }
}

// 按指定字段组合规则行，避免为同类值重复生成完整判断表达式。
function groupRuleRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = JSON.stringify(keyOf(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

// 将同组规则值压缩为一个 SQL IN 列表。
function ruleValuesSql(rows) {
  return [...new Set(rows.map((row) => row.value))].sort().map(sqlString).join(', ');
}

// 生成从规则创建日期开始生效的 Analytics Engine 过滤条件。
export async function buildAnalyticsBlockCondition(env) {
  const db = requireStatsDb(env);
  const [ips, versions] = await Promise.all([
    db.prepare("SELECT 'ip' AS ruleType, '' AS projectName, ip AS value, created_at AS createdAt FROM ip_blocks").all(),
    db.prepare("SELECT 'version' AS ruleType, project_name AS projectName, version AS value, created_at AS createdAt FROM version_blocks").all(),
  ]);
  const conditions = [];
  const eventDate = businessDateSqlExpression();
  for (const group of groupRuleRows(ips.results, (row) => [String(row.createdAt || '').slice(0, 10)])) {
    conditions.push(`(blob13 IN (${ruleValuesSql(group)}) AND ${eventDate} >= ${sqlString(String(group[0].createdAt || '').slice(0, 10))})`);
  }
  for (const group of groupRuleRows(versions.results, (row) => [row.projectName, String(row.createdAt || '').slice(0, 10)])) {
    conditions.push(`(blob1 = ${sqlString(group[0].projectName)} AND blob4 IN (${ruleValuesSql(group)}) AND ${eventDate} >= ${sqlString(String(group[0].createdAt || '').slice(0, 10))})`);
  }
  return conditions.length ? `NOT (${conditions.join(' OR ')})` : '1 = 1';
}
