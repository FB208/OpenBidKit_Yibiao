import { PROJECT_NAME_PATTERN } from './constants.js';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

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

export function safeStatsRange(value, defaultRange = 'history') {
  const range = normalizeText(value, 20);
  if (['history', 'today', '7', '30'].includes(range)) {
    return range;
  }
  return defaultRange;
}

export function safePage(value) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page));
}

export function isoDateDaysAgo(days) {
  return getBusinessDateDaysAgo(days);
}

export function daysSinceIsoDate(value) {
  return daysSinceBusinessDate(value);
}

export function daysSinceBusinessDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  const today = new Date(`${getBusinessToday()}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return NaN;

  return Math.floor((today.getTime() - date.getTime()) / 86400000);
}

export function addIsoDays(value, days) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';

  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addBusinessDateDays(value, days) {
  return addIsoDays(value, days);
}

export function datePart(value) {
  return String(value || '').slice(0, 10);
}

export function getBusinessDateDaysAgo(days = 0, baseDate = new Date()) {
  const date = new Date(baseDate.getTime() - Math.max(0, Number(days || 0)) * 86400000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getBusinessToday(baseDate = new Date()) {
  return getBusinessDateDaysAgo(0, baseDate);
}

export function formatBusinessDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
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

export function businessDateSqlExpression(value = 'timestamp') {
  return `formatDateTime(${value}, '%Y-%m-%d', '${BUSINESS_TIME_ZONE}')`;
}

export function businessDateTimeSqlExpression(value = 'timestamp') {
  return `formatDateTime(${value}, '%Y-%m-%d %H:%M:%S', '${BUSINESS_TIME_ZONE}')`;
}

export function businessDateRangeCondition(startDate, endDate = getBusinessToday()) {
  const dateExpr = businessDateSqlExpression();
  return `${dateExpr} >= ${sqlString(startDate)} AND ${dateExpr} <= ${sqlString(endDate)}`;
}

export function logQueryError(scope, error) {
  console.error(`[analytics] ${scope} query failed`, error?.message || String(error));
}

export function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function formatNoticeTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
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
