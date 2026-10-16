import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLatestNoticeUpdatedAt, isNoticeUnread, markNoticeSeen, NOTICE_SEEN_EVENT } from '../../../shared/remoteNotice';

const noticePollIntervalMs = 30 * 60 * 1000;

// 启动时及每 30 分钟检查是否有晚于已读记录更新的公告；自动弹窗点“知道了”后也会重新判断。
export function useNoticeUnread() {
  const [hasUnread, setHasUnread] = useState(false);
  const latestUpdatedAtRef = useRef('');

  useEffect(() => {
    let disposed = false;

    const check = async () => {
      const latestUpdatedAt = await fetchLatestNoticeUpdatedAt();
      if (disposed || latestUpdatedAt === null) return;
      latestUpdatedAtRef.current = latestUpdatedAt;
      setHasUnread(isNoticeUnread(latestUpdatedAt));
    };

    const handleSeen = () => setHasUnread(isNoticeUnread(latestUpdatedAtRef.current));

    void check();
    const timer = window.setInterval(() => void check(), noticePollIntervalMs);
    window.addEventListener(NOTICE_SEEN_EVENT, handleSeen);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(NOTICE_SEEN_EVENT, handleSeen);
    };
  }, []);

  // 弹窗内公告加载成功后记录当时最新的更新时间并清除红点。
  const markSeen = useCallback((latestUpdatedAt: string) => {
    markNoticeSeen(latestUpdatedAt);
    setHasUnread(false);
  }, []);

  return { hasUnread, markSeen };
}
