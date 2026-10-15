import { useCallback, useEffect, useState } from 'react';
import { fetchLatestChangelogPublishedAt, isChangelogUnread, saveSeenChangelogPublishedAt } from '../services/changelogService';

const changelogPollIntervalMs = 30 * 60 * 1000;

// 启动时及每 30 分钟检查是否有晚于已读记录发布的更新日志。
export function useChangelogUnread() {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    let disposed = false;

    const check = async () => {
      const latestPublishedAt = await fetchLatestChangelogPublishedAt();
      if (disposed || latestPublishedAt === null) return;
      setHasUnread(isChangelogUnread(latestPublishedAt));
    };

    void check();
    const timer = window.setInterval(() => void check(), changelogPollIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // 弹窗内日志加载成功后记录当时最新的发布时间并清除红点。
  const markSeen = useCallback((latestPublishedAt: string) => {
    saveSeenChangelogPublishedAt(latestPublishedAt);
    setHasUnread(false);
  }, []);

  return { hasUnread, markSeen };
}
