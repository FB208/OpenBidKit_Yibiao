import { PROJECT_NAME_PATTERN } from './constants.js';

export function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeMetricValue(value, maxLength) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return normalizeText(value, maxLength);
}

export function isValidProjectName(projectName) {
  return PROJECT_NAME_PATTERN.test(projectName);
}

export function safeDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(Math.floor(days), 90));
}

export function safePage(value) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page));
}

export function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function daysSinceIsoDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return NaN;

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayUtc - date.getTime()) / 86400000);
}

export function addIsoDays(value, days) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function datePart(value) {
  return String(value || '').slice(0, 10);
}

export function logQueryError(scope, error) {
  console.error(`[analytics] ${scope} query failed`, error?.message || String(error));
}

export function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function formatNoticeTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
