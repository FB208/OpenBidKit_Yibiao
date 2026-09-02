import { businessDateSqlExpression, businessDateTimeSqlExpression, formatBusinessDateTime, normalizeText, sqlString } from '../utils.js';

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

function ruleProjectName(rule) {
  return rule.type === 'version' ? normalizeText(rule.projectName, 80) : '';
}

function sameRule(row, rule) {
  return row.ruleType === rule.type
    && row.projectName === ruleProjectName(rule)
    && row.value === rule.value;
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
      created_at AS createdAt,
      COALESCE(progress.cleaned_until, '') AS cleanedUntil,
      COALESCE(progress.status, 'pending') AS cleanupStatus,
      COALESCE(progress.error, '') AS cleanupError
    FROM ip_blocks
    LEFT JOIN block_rule_cleanup_progress progress
      ON progress.rule_type = 'ip'
      AND progress.project_name = ?
      AND progress.rule_value = ip_blocks.ip
    UNION ALL
    SELECT
      'version' AS type,
      version AS value,
      version_blocks.project_name AS projectName,
      reason,
      created_at AS createdAt,
      COALESCE(progress.cleaned_until, '') AS cleanedUntil,
      COALESCE(progress.status, 'pending') AS cleanupStatus,
      COALESCE(progress.error, '') AS cleanupError
    FROM version_blocks
    LEFT JOIN block_rule_cleanup_progress progress
      ON progress.rule_type = 'version'
      AND progress.project_name = version_blocks.project_name
      AND progress.rule_value = version_blocks.version
    WHERE version_blocks.project_name = ?
    ORDER BY createdAt DESC, type ASC, value ASC
  `).bind(projectName, projectName).all();
  return result.results || [];
}

// 新增规则；重复提交只更新原因并保留首次封禁时间，供管理端重试清理。
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

// 解除规则并固化截止时间，使解除前的历史事件继续被查询过滤。
export async function deleteBlockRule(env, rule, cleanupProjectName) {
  const db = requireStatsDb(env);
  const projectName = ruleProjectName(rule);
  const excludedUntil = formatBusinessDateTime(new Date());
  const activeTable = rule.type === 'ip' ? 'ip_blocks' : 'version_blocks';
  const activeWhere = rule.type === 'ip' ? 'ip = ?' : 'project_name = ? AND version = ?';
  const activeBindings = rule.type === 'ip' ? [rule.value] : [projectName, rule.value];
  const active = await db.prepare(`SELECT 1 FROM ${activeTable} WHERE ${activeWhere} LIMIT 1`).bind(...activeBindings).first();
  if (!active) return false;
  let incompleteProjects = [];
  if (rule.type === 'ip') {
    const result = await db.prepare(`
      WITH projects AS (
        SELECT project_name FROM stats_totals
        UNION
        SELECT project_name FROM stats_clients
        UNION
        SELECT ? AS project_name
      )
      SELECT projects.project_name AS projectName
      FROM projects
      LEFT JOIN block_rule_cleanup_progress progress
        ON progress.rule_type = 'ip'
        AND progress.project_name = projects.project_name
        AND progress.rule_value = ?
      WHERE projects.project_name != '' AND COALESCE(progress.status, '') != 'success'
      ORDER BY projects.project_name ASC
    `).bind(cleanupProjectName, rule.value).all();
    incompleteProjects = (result.results || []).map((row) => row.projectName).filter(Boolean);
  } else {
    const progress = await getBlockRuleCleanupProgress(env, rule, cleanupProjectName);
    if (progress?.status !== 'success') incompleteProjects = [cleanupProjectName];
  }
  if (incompleteProjects.length) {
    const error = new Error('block rule cleanup is incomplete');
    error.code = 'BLOCK_RULE_CLEANUP_INCOMPLETE';
    error.projects = incompleteProjects;
    throw error;
  }
  const statements = [
    db.prepare(`
      INSERT INTO block_rule_history (rule_type, project_name, rule_value, excluded_until, updated_at)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ${activeTable} WHERE ${activeWhere})
      ON CONFLICT(rule_type, project_name, rule_value) DO UPDATE SET
        excluded_until = MAX(block_rule_history.excluded_until, excluded.excluded_until),
        updated_at = excluded.updated_at
    `).bind(rule.type, projectName, rule.value, excludedUntil, excludedUntil, ...activeBindings),
    db.prepare(`DELETE FROM ${activeTable} WHERE ${activeWhere}`).bind(...activeBindings),
  ];
  if (rule.type === 'ip') {
    statements.push(db.prepare('DELETE FROM stats_blocked_clients WHERE blocked_ip = ?').bind(rule.value));
  }
  let results;
  if (typeof db.batch === 'function') {
    results = await db.batch(statements);
  } else {
    results = [];
    for (const statement of statements) results.push(await statement.run());
  }
  return Number(results[1]?.meta?.changes || 0) > 0;
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

// 生成 Analytics Engine 的统一规则过滤条件；清理时可仅忽略本次新增的活动规则。
export async function buildAnalyticsBlockCondition(env, options = {}) {
  const db = requireStatsDb(env);
  const [ips, versions, history] = await Promise.all([
    db.prepare("SELECT 'ip' AS ruleType, '' AS projectName, ip AS value FROM ip_blocks").all(),
    db.prepare("SELECT 'version' AS ruleType, project_name AS projectName, version AS value FROM version_blocks").all(),
    db.prepare('SELECT rule_type AS ruleType, project_name AS projectName, rule_value AS value, excluded_until AS excludedUntil FROM block_rule_history').all(),
  ]);
  const omit = options.omitActiveRule;
  const conditions = [];
  for (const row of [...(ips.results || []), ...(versions.results || [])]) {
    if (omit && sameRule(row, omit)) continue;
    conditions.push(row.ruleType === 'ip'
      ? `blob13 = ${sqlString(row.value)}`
      : `(blob1 = ${sqlString(row.projectName)} AND blob4 = ${sqlString(row.value)})`);
  }
  for (const row of history.results || []) {
    const match = row.ruleType === 'ip'
      ? `blob13 = ${sqlString(row.value)}`
      : `(blob1 = ${sqlString(row.projectName)} AND blob4 = ${sqlString(row.value)})`;
    conditions.push(`(${match} AND ${businessDateTimeSqlExpression()} <= ${sqlString(row.excludedUntil)})`);
  }
  return conditions.length ? `NOT (${conditions.join(' OR ')})` : '1 = 1';
}

// 构造清理专用过滤：只包含本次规则、已固化历史和已原子落库的清理游标。
export async function buildAnalyticsCleanupCondition(env, projectName, currentRule = null, includeAllProjects = false) {
  const db = requireStatsDb(env);
  const [progress, history] = await Promise.all([
    db.prepare(`
      SELECT rule_type AS ruleType, project_name AS projectName, rule_value AS value, cleaned_until AS cleanedUntil
      FROM block_rule_cleanup_progress
      WHERE cleaned_until != ''
    `).all(),
    db.prepare(`
      SELECT rule_type AS ruleType, project_name AS projectName, rule_value AS value, excluded_until AS excludedUntil
      FROM block_rule_history
    `).all(),
  ]);
  const conditions = [];
  if (currentRule) {
    const match = currentRule.type === 'ip'
      ? `blob13 = ${sqlString(currentRule.value)}`
      : `blob4 = ${sqlString(currentRule.value)}`;
    conditions.push(`(blob1 = ${sqlString(projectName)} AND ${match})`);
  }
  for (const row of progress.results || []) {
    if (!includeAllProjects && row.projectName !== projectName) continue;
    if (currentRule
      && row.ruleType === currentRule.type
      && row.value === currentRule.value
      && row.projectName === projectName) continue;
    const match = row.ruleType === 'ip'
      ? `blob13 = ${sqlString(row.value)}`
      : `blob4 = ${sqlString(row.value)}`;
    conditions.push(`(blob1 = ${sqlString(row.projectName)} AND ${match} AND ${businessDateSqlExpression()} <= ${sqlString(row.cleanedUntil.slice(0, 10))})`);
  }
  for (const row of history.results || []) {
    const match = row.ruleType === 'ip'
      ? `blob13 = ${sqlString(row.value)}`
      : `(blob1 = ${sqlString(row.projectName)} AND blob4 = ${sqlString(row.value)})`;
    conditions.push(`(${match} AND ${businessDateTimeSqlExpression()} <= ${sqlString(row.excludedUntil)})`);
  }
  return conditions.length ? `NOT (${conditions.join(' OR ')})` : '1 = 1';
}

// 更新规则清理进度，失败时保留错误供管理端展示和重试。
export async function saveBlockRuleCleanupProgress(env, rule, projectName, progress) {
  const updatedAt = formatBusinessDateTime(new Date());
  await requireStatsDb(env).prepare(`
    INSERT INTO block_rule_cleanup_progress (
      rule_type, project_name, rule_value, cleaned_until, status, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_type, project_name, rule_value) DO UPDATE SET
      cleaned_until = excluded.cleaned_until,
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).bind(
    rule.type,
    projectName,
    rule.value,
    progress.cleanedUntil || '',
    progress.status,
    normalizeText(progress.error, 1000),
    updatedAt,
  ).run();
}

// 读取单条规则在统计项目内的清理游标。
export async function getBlockRuleCleanupProgress(env, rule, projectName) {
  return await requireStatsDb(env).prepare(`
    SELECT cleaned_until AS cleanedUntil, status, error
    FROM block_rule_cleanup_progress
    WHERE rule_type = ? AND project_name = ? AND rule_value = ?
  `).bind(rule.type, projectName, rule.value).first();
}
