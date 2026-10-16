const CHANGELOG_ENDPOINT = 'https://analytics.agnet.top/changelogs';
const PROJECT_NAME = 'yibiao-client';
const SEEN_PUBLISHED_AT_KEY = 'changelog_seen_published_at';
const LOG_PREFIX = '[changelog]';

export interface ChangelogEntry {
  version: string;
  content: string;
  publishedAt: string;
}

interface ChangelogListResponse {
  code?: number;
  changelogs?: ChangelogEntry[];
}

interface ChangelogLatestResponse {
  code?: number;
  latestPublishedAt?: string;
}

function buildUrl(path = '') {
  const url = new URL(`${CHANGELOG_ENDPOINT}${path}`);
  url.searchParams.set('projectName', PROJECT_NAME);
  return url.toString();
}

async function requestJson<T>(path = '') {
  const response = await fetch(buildUrl(path), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`更新日志请求失败：${response.status}`);
  }
  return await response.json() as T;
}

// 读取全部更新日志，服务端已按版本号倒序；失败时抛错，由弹窗展示重试。
export async function fetchChangelogs() {
  const data = await requestJson<ChangelogListResponse>();
  if (data?.code !== 0 || !Array.isArray(data.changelogs)) {
    throw new Error('更新日志响应无效');
  }

  return data.changelogs.map((item) => ({
    version: String(item.version || ''),
    content: String(item.content || ''),
    publishedAt: String(item.publishedAt || ''),
  }));
}

// 读取最新一条日志的发布时间，供红点轮询；失败返回 null，保持原红点状态。
export async function fetchLatestChangelogPublishedAt() {
  try {
    const data = await requestJson<ChangelogLatestResponse>('/latest');
    if (data?.code !== 0) return null;
    return String(data.latestPublishedAt || '');
  } catch (error) {
    console.info(LOG_PREFIX, 'latest check failed', error);
    return null;
  }
}

export function readSeenChangelogPublishedAt() {
  try {
    return localStorage.getItem(SEEN_PUBLISHED_AT_KEY) || '';
  } catch {
    return '';
  }
}

export function saveSeenChangelogPublishedAt(publishedAt: string) {
  if (!publishedAt) return;

  try {
    localStorage.setItem(SEEN_PUBLISHED_AT_KEY, publishedAt);
  } catch {
    // 已读记录写入失败不影响主流程；下次检查可能再次显示红点。
  }
}

// 发布时间为服务端固定格式 YYYY-MM-DD HH:mm:ss，可直接按字符串比较；无已读记录视为未读。
export function isChangelogUnread(latestPublishedAt: string) {
  return Boolean(latestPublishedAt) && latestPublishedAt > readSeenChangelogPublishedAt();
}
