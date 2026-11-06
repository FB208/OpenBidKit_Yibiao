import type { NoticePresentation } from './types/notice';

const NOTICE_ENDPOINT = 'https://analytics.agnet.top/notice';
const NOTICE_LIST_ENDPOINT = 'https://analytics.agnet.top/notices';
export const NOTICE_PROJECT_NAME = 'yibiao-client';
const PROJECT_NAME = NOTICE_PROJECT_NAME;
const DISMISSED_NOTICE_ID_KEY = 'remote_notice_dismissed_id';
const SEEN_NOTICE_UPDATED_AT_KEY = 'remote_notice_seen_updated_at';
export const NOTICE_SEEN_EVENT = 'yibiao:remote-notice-seen';
const LOG_PREFIX = '[remote-notice]';

export type NoticeEntry = NoticePresentation & {
  id: string;
  clientNoticeId: string;
  updatedAt: string;
};

interface NoticeListResponse {
  code?: number;
  notices?: NoticeEntry[];
}

interface NoticeLatestResponse {
  code?: number;
  latestUpdatedAt?: string;
}

export type RemoteNotice = NoticePresentation & {
  id: string;
  projectName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

interface RemoteNoticeResponse {
  code?: number;
  notice?: RemoteNotice | null;
}

function readDismissedNoticeId() {
  try {
    return localStorage.getItem(DISMISSED_NOTICE_ID_KEY) || '';
  } catch {
    return '';
  }
}

export function hasDismissedRemoteNotice(noticeId: string) {
  return Boolean(noticeId) && readDismissedNoticeId() === noticeId;
}

export function dismissRemoteNotice(noticeId: string) {
  if (!noticeId) return;

  try {
    localStorage.setItem(DISMISSED_NOTICE_ID_KEY, noticeId);
  } catch {
    // 公告关闭记录失败不影响主流程；下次轮询可能再次显示同一公告。
  }
}

// 公告弹窗展示后上报一次送达计数。
export async function reportRemoteNoticeDelivered(notice: Pick<RemoteNotice, 'id' | 'projectName'>) {
  const response = await fetch(`${NOTICE_ENDPOINT}/delivered`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      projectName: notice.projectName || PROJECT_NAME,
      noticeId: notice.id,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    console.info(LOG_PREFIX, 'delivery report failed', response.status);
  }
}

// 旧 KV 没有类型标记时按文字公告读取；新图片公告保留媒体配置。
function noticePresentation(notice: NoticePresentation): NoticePresentation {
  const common = { title: String(notice.title || '公告'), content: String(notice.content || '') };
  return notice.noticeType === 'image'
    ? { ...common, noticeType: 'image', media: notice.media }
    : { ...common, noticeType: 'text', media: null };
}

// 规范当前公告；只有明确空值或停用才表示无公告，坏响应不能清理缓存。
function normalizeNotice(notice: RemoteNotice | null | undefined): RemoteNotice | null {
  if (notice === null || notice?.enabled === false) return null;
  if (!notice?.id || !notice.content) throw new Error('公告响应无效');

  return {
    id: String(notice.id),
    projectName: String(notice.projectName || PROJECT_NAME),
    enabled: true,
    ...noticePresentation(notice),
    createdAt: String(notice.createdAt || ''),
    updatedAt: String(notice.updatedAt || ''),
  };
}

// 仅明确成功返回空公告时返回 null；请求失败抛错，不能误清理缓存。
export async function fetchRemoteNotice() {
  const url = new URL(NOTICE_ENDPOINT);
  url.searchParams.set('projectName', PROJECT_NAME);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (!response.ok) throw new Error(`公告请求失败：${response.status}`);

  const data = await response.json() as RemoteNoticeResponse;
  if (data?.code !== 0 || !Object.prototype.hasOwnProperty.call(data, 'notice')) {
    throw new Error('公告响应无效');
  }

  const notice = normalizeNotice(data.notice);
  console.info(LOG_PREFIX, 'normalized notice', notice?.id || null);
  return notice;
}

async function requestNoticeList<T>(path = '') {
  const url = new URL(`${NOTICE_LIST_ENDPOINT}${path}`);
  url.searchParams.set('projectName', PROJECT_NAME);
  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`公告请求失败：${response.status}`);
  }
  return await response.json() as T;
}

// 读取全部启用的公告，服务端已按更新时间倒序；失败时抛错，由弹窗展示重试。
export async function fetchNoticeList() {
  const data = await requestNoticeList<NoticeListResponse>();
  if (data?.code !== 0 || !Array.isArray(data.notices)) {
    throw new Error('公告响应无效');
  }

  return data.notices.map((item) => ({
    id: String(item.id || ''),
    clientNoticeId: String(item.clientNoticeId || ''),
    ...noticePresentation(item),
    updatedAt: String(item.updatedAt || ''),
  }));
}

// 读取最新启用公告的更新时间，供红点轮询；失败返回 null，保持原红点状态。
export async function fetchLatestNoticeUpdatedAt() {
  try {
    const data = await requestNoticeList<NoticeLatestResponse>('/latest');
    if (data?.code !== 0) return null;
    return String(data.latestUpdatedAt || '');
  } catch (error) {
    console.info(LOG_PREFIX, 'latest check failed', error);
    return null;
  }
}

export function readSeenNoticeUpdatedAt() {
  try {
    return localStorage.getItem(SEEN_NOTICE_UPDATED_AT_KEY) || '';
  } catch {
    return '';
  }
}

// 记录已读的公告更新时间（只前进不后退），并通知侧栏红点重新判断。
export function markNoticeSeen(updatedAt: string) {
  if (!updatedAt || updatedAt <= readSeenNoticeUpdatedAt()) return;

  try {
    localStorage.setItem(SEEN_NOTICE_UPDATED_AT_KEY, updatedAt);
  } catch {
    // 已读记录写入失败不影响主流程；下次检查可能再次显示红点。
  }
  window.dispatchEvent(new Event(NOTICE_SEEN_EVENT));
}

// 更新时间为服务端固定格式 YYYY-MM-DD HH:mm:ss，可直接按字符串比较；无已读记录视为未读。
export function isNoticeUnread(latestUpdatedAt: string) {
  return Boolean(latestUpdatedAt) && latestUpdatedAt > readSeenNoticeUpdatedAt();
}
