import { getPublicJwk, verifyPayload } from './licenseCrypto.js';
import { isValidProjectName, normalizeText, safePage } from '../utils.js';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 95 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_DELETE_COUNT = 50;
const MAX_VERSION_COUNT = 50;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,49}$/;
const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireStorage(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  if (!env.AGENT_ERROR_BUCKET) throw new Error('AGENT_ERROR_BUCKET is not configured');
  return { db: env.ANALYTICS_DB, bucket: env.AGENT_ERROR_BUCKET };
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function normalizeVersion(value) {
  const version = normalizeText(value, 50);
  return VERSION_PATTERN.test(version) ? version : '';
}

function normalizeVersions(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeVersion)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizePageSize(value) {
  const pageSize = Number(value || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize)));
}

async function ensureSettings(db, projectName) {
  await db.prepare(`
    INSERT OR IGNORE INTO agent_error_settings (
      project_name, receive_enabled, retention_days, max_storage_bytes, used_bytes, updated_at
    ) VALUES (?, 0, ?, ?, 0, ?)
  `).bind(projectName, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_STORAGE_BYTES, nowIso()).run();
}

async function readSettingsRow(db, projectName) {
  await ensureSettings(db, projectName);
  return db.prepare(`
    SELECT
      project_name AS projectName,
      receive_enabled AS receiveEnabled,
      retention_days AS retentionDays,
      max_storage_bytes AS maxStorageBytes,
      used_bytes AS usedBytes,
      updated_at AS updatedAt
    FROM agent_error_settings
    WHERE project_name = ?
  `).bind(projectName).first();
}

export async function readAgentErrorConfig(env, projectName) {
  const { db } = requireStorage(env);
  const settings = await readSettingsRow(db, projectName);
  const versionResult = await db.prepare(`
    SELECT version
    FROM agent_error_versions
    WHERE project_name = ?
    ORDER BY version ASC
  `).bind(projectName).all();
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS logCount
    FROM agent_error_logs
    WHERE project_name = ? AND status = 'ready'
  `).bind(projectName).first();
  const usedBytes = number(settings?.usedBytes);
  const maxStorageBytes = number(settings?.maxStorageBytes) || DEFAULT_MAX_STORAGE_BYTES;
  return {
    projectName,
    receiveEnabled: Number(settings?.receiveEnabled || 0) === 1,
    retentionDays: number(settings?.retentionDays) || DEFAULT_RETENTION_DAYS,
    maxStorageBytes,
    usedBytes,
    remainingBytes: Math.max(0, maxStorageBytes - usedBytes),
    logCount: number(countRow?.logCount),
    versions: (versionResult.results || []).map((row) => row.version),
    updatedAt: settings?.updatedAt || '',
  };
}

export async function saveAgentErrorConfig(env, input = {}) {
  const { db } = requireStorage(env);
  const projectName = normalizeText(input.projectName || input.project_name, 80);
  if (!isValidProjectName(projectName)) throw new Error('invalid projectName');
  const versions = normalizeVersions(input.versions);
  if (versions.length > MAX_VERSION_COUNT) throw new Error('too many versions');
  await ensureSettings(db, projectName);
  const updatedAt = nowIso();
  const statements = [
    db.prepare(`
      UPDATE agent_error_settings
      SET receive_enabled = ?, retention_days = ?, max_storage_bytes = ?, updated_at = ?
      WHERE project_name = ?
    `).bind(input.receiveEnabled === true ? 1 : 0, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_STORAGE_BYTES, updatedAt, projectName),
    db.prepare('DELETE FROM agent_error_versions WHERE project_name = ?').bind(projectName),
    ...versions.map((version) => db.prepare(`
      INSERT INTO agent_error_versions (project_name, version, created_at)
      VALUES (?, ?, ?)
    `).bind(projectName, version, updatedAt)),
  ];
  await db.batch(statements);
  return readAgentErrorConfig(env, projectName);
}

export async function checkAgentErrorReception(env, projectName, version, compressedBytes = 0) {
  if (!env.ANALYTICS_DB) return { accepted: false, reason: 'storage-unavailable' };
  const normalizedVersion = normalizeVersion(version);
  if (!isValidProjectName(projectName) || !normalizedVersion) return { accepted: false, reason: 'invalid-meta' };
  const row = await env.ANALYTICS_DB.prepare(`
    SELECT
      s.retention_days AS retentionDays,
      s.max_storage_bytes AS maxStorageBytes,
      s.used_bytes AS usedBytes
    FROM agent_error_settings s
    INNER JOIN agent_error_versions v
      ON v.project_name = s.project_name AND v.version = ?
    WHERE s.project_name = ? AND s.receive_enabled = 1
  `).bind(normalizedVersion, projectName).first();
  if (!row) return { accepted: false, reason: 'disabled-or-version-rejected' };
  const remainingBytes = Math.max(0, number(row.maxStorageBytes) - number(row.usedBytes));
  if (!remainingBytes || number(compressedBytes) > remainingBytes) {
    return { accepted: false, reason: 'capacity-exceeded' };
  }
  return { accepted: true, version: normalizedVersion, retentionDays: number(row.retentionDays) || DEFAULT_RETENTION_DAYS };
}

export async function verifyAgentErrorLicense(env, license, meta) {
  const payload = license?.payload;
  const signature = normalizeText(license?.signature, 1000);
  if (!payload || !signature || !await verifyPayload(getPublicJwk(env), payload, signature)) return false;
  const expiresAt = new Date(payload.expiresAt || '').getTime();
  return payload.status === 'active'
    && payload.sourceTrusted === true
    && payload.projectName === meta.projectName
    && payload.clientId === meta.clientId
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now();
}

export function normalizeAgentErrorMeta(input = {}) {
  const meta = {
    schemaVersion: number(input.schemaVersion),
    reportId: normalizeText(input.reportId, 80),
    projectName: normalizeText(input.projectName, 80),
    occurredAt: normalizeText(input.occurredAt, 40),
    version: normalizeVersion(input.version),
    platform: normalizeText(input.platform, 50),
    arch: normalizeText(input.arch, 50),
    clientId: normalizeText(input.clientId, 120),
    clientCreatedAt: normalizeText(input.clientCreatedAt, 20).slice(0, 10),
    runtime: normalizeText(input.runtime, 40),
    errorName: normalizeText(input.errorName, 120),
    errorCode: normalizeText(input.errorCode, 120),
    errorSummary: normalizeText(input.errorSummary, 1000),
    originalBytes: Math.max(0, Math.floor(number(input.originalBytes))),
    compressedBytes: Math.max(0, Math.floor(number(input.compressedBytes))),
  };
  if (meta.schemaVersion !== 1
    || !REPORT_ID_PATTERN.test(meta.reportId)
    || !isValidProjectName(meta.projectName)
    || !meta.version
    || !meta.clientId
    || !meta.runtime
    || !meta.occurredAt
    || !meta.compressedBytes
    || meta.compressedBytes > MAX_COMPRESSED_BYTES) {
    return null;
  }
  return meta;
}

async function reserveStorage(db, projectName, version, compressedBytes) {
  const result = await db.prepare(`
    UPDATE agent_error_settings
    SET used_bytes = used_bytes + ?, updated_at = ?
    WHERE project_name = ?
      AND receive_enabled = 1
      AND used_bytes + ? <= max_storage_bytes
      AND EXISTS (
        SELECT 1 FROM agent_error_versions
        WHERE project_name = ? AND version = ?
      )
  `).bind(compressedBytes, nowIso(), projectName, compressedBytes, projectName, version).run();
  return number(result?.meta?.changes) > 0;
}

async function releaseStorage(db, projectName, compressedBytes) {
  await db.prepare(`
    UPDATE agent_error_settings
    SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
    WHERE project_name = ?
  `).bind(compressedBytes, nowIso(), projectName).run();
}

function createObjectKey(meta, receivedAt) {
  return `${meta.projectName}/${receivedAt.slice(0, 10)}/${meta.reportId}.json.gz`;
}

export async function storeAgentError(env, meta, compressedBody, retentionDays = DEFAULT_RETENTION_DAYS) {
  const { db, bucket } = requireStorage(env);
  const existing = await db.prepare('SELECT id FROM agent_error_logs WHERE id = ?').bind(meta.reportId).first();
  if (existing) return { accepted: true, duplicate: true };
  if (!await reserveStorage(db, meta.projectName, meta.version, meta.compressedBytes)) {
    return { accepted: false, reason: 'capacity-exceeded' };
  }

  const receivedAt = nowIso();
  const objectKey = createObjectKey(meta, receivedAt);
  try {
    await bucket.put(objectKey, compressedBody, {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { projectName: meta.projectName, reportId: meta.reportId, version: meta.version },
    });
    await db.prepare(`
      INSERT INTO agent_error_logs (
        id, project_name, client_id, client_created_at, version, runtime, platform, arch,
        occurred_at, received_at, expires_at, error_name, error_code, error_summary,
        original_bytes, compressed_bytes, object_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    `).bind(
      meta.reportId,
      meta.projectName,
      meta.clientId,
      meta.clientCreatedAt,
      meta.version,
      meta.runtime,
      meta.platform,
      meta.arch,
      meta.occurredAt,
      receivedAt,
      addDaysIso(receivedAt, retentionDays),
      meta.errorName,
      meta.errorCode,
      meta.errorSummary,
      meta.originalBytes,
      meta.compressedBytes,
      objectKey,
    ).run();
    return { accepted: true, reportId: meta.reportId };
  } catch (error) {
    await bucket.delete(objectKey).catch(() => undefined);
    await releaseStorage(db, meta.projectName, meta.compressedBytes).catch(() => undefined);
    throw error;
  }
}

export async function listAgentErrors(env, projectName, pageValue, pageSizeValue) {
  const { db } = requireStorage(env);
  const page = safePage(pageValue);
  const pageSize = normalizePageSize(pageSizeValue);
  const offset = (page - 1) * pageSize;
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM agent_error_logs
    WHERE project_name = ? AND status = 'ready'
  `).bind(projectName).first();
  const result = await db.prepare(`
    SELECT
      id,
      client_id AS clientId,
      version,
      runtime,
      platform,
      arch,
      occurred_at AS occurredAt,
      received_at AS receivedAt,
      expires_at AS expiresAt,
      error_name AS errorName,
      error_code AS errorCode,
      error_summary AS errorSummary,
      original_bytes AS originalBytes,
      compressed_bytes AS compressedBytes
    FROM agent_error_logs
    WHERE project_name = ? AND status = 'ready'
    ORDER BY received_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(projectName, pageSize, offset).all();
  return { page, pageSize, total: number(countRow?.total), logs: result.results || [] };
}

export async function getAgentErrorDownload(env, projectName, reportId) {
  const { db, bucket } = requireStorage(env);
  const row = await db.prepare(`
    SELECT id, object_key AS objectKey
    FROM agent_error_logs
    WHERE project_name = ? AND id = ? AND status = 'ready'
  `).bind(projectName, reportId).first();
  if (!row) return null;
  const object = await bucket.get(row.objectKey);
  return object ? { row, object } : null;
}

function normalizeDeleteIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeText(value, 80))
    .filter((value) => REPORT_ID_PATTERN.test(value)))]
    .slice(0, MAX_DELETE_COUNT);
}

async function deleteRows(env, rows) {
  if (!rows.length) return { deletedCount: 0, deletedBytes: 0 };
  const { db, bucket } = requireStorage(env);
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  await db.prepare(`UPDATE agent_error_logs SET status = 'deleting' WHERE id IN (${placeholders})`).bind(...ids).run();
  await bucket.delete(rows.map((row) => row.objectKey));

  const bytesByProject = new Map();
  rows.forEach((row) => bytesByProject.set(row.projectName, (bytesByProject.get(row.projectName) || 0) + number(row.compressedBytes)));
  await db.batch([
    db.prepare(`DELETE FROM agent_error_logs WHERE id IN (${placeholders})`).bind(...ids),
    ...[...bytesByProject.entries()].map(([projectName, bytes]) => db.prepare(`
      UPDATE agent_error_settings
      SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
      WHERE project_name = ?
    `).bind(bytes, nowIso(), projectName)),
  ]);
  return {
    deletedCount: rows.length,
    deletedBytes: rows.reduce((total, row) => total + number(row.compressedBytes), 0),
  };
}

export async function deleteAgentErrors(env, projectName, inputIds) {
  const { db } = requireStorage(env);
  const ids = normalizeDeleteIds(inputIds);
  if (!ids.length) return { deletedCount: 0, deletedBytes: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  const result = await db.prepare(`
    SELECT id, project_name AS projectName, object_key AS objectKey, compressed_bytes AS compressedBytes
    FROM agent_error_logs
    WHERE project_name = ? AND id IN (${placeholders})
  `).bind(projectName, ...ids).all();
  return deleteRows(env, result.results || []);
}

export async function cleanupExpiredAgentErrors(env) {
  if (!env.ANALYTICS_DB || !env.AGENT_ERROR_BUCKET) return { deletedCount: 0, deletedBytes: 0 };
  const total = { deletedCount: 0, deletedBytes: 0 };
  for (let batchIndex = 0; batchIndex < 40; batchIndex += 1) {
    const result = await env.ANALYTICS_DB.prepare(`
      SELECT id, project_name AS projectName, object_key AS objectKey, compressed_bytes AS compressedBytes
      FROM agent_error_logs
      WHERE expires_at <= ? OR status = 'deleting'
      ORDER BY expires_at ASC
      LIMIT ?
    `).bind(nowIso(), MAX_DELETE_COUNT).all();
    const rows = result.results || [];
    if (!rows.length) break;
    const deleted = await deleteRows(env, rows);
    total.deletedCount += deleted.deletedCount;
    total.deletedBytes += deleted.deletedBytes;
  }
  return total;
}
