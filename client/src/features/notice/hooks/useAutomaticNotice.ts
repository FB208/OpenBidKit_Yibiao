import { useEffect, useRef, useState } from 'react';
import { dismissRemoteNotice, fetchRemoteNotice, hasDismissedRemoteNotice, markNoticeSeen, NOTICE_PROJECT_NAME, reportRemoteNoticeDelivered, type RemoteNotice } from '../../../shared/remoteNotice';
import type { NoticeCachedMedia } from '../../../shared/types/notice';
import { prepareNoticeMedia, type PreparedNoticeMedia } from '../noticeMedia';

interface DisplayedNotice {
  notice: RemoteNotice;
  cached?: NoticeCachedMedia;
  prepared?: PreparedNoticeMedia;
}

/** 归还媒体文件占用；清理失败不改变公告展示结果。 */
function releaseCachedMedia(cached: NoticeCachedMedia | undefined) {
  if (cached) void window.yibiao?.notice.releaseMedia(cached.leaseId).catch(() => undefined);
}

/** 统一公告检查与展示：只有图片公告必须等待完整缓存和媒体就绪。 */
export function useAutomaticNotice(enabled: boolean) {
  const [displayed, setDisplayed] = useState<DisplayedNotice | null>(null);
  const activeRef = useRef<DisplayedNotice | null>(null);
  const reportedRef = useRef(new Set<string>());
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [countdown, setCountdown] = useState({ id: '', seconds: 0 });
  const notice = displayed?.notice || null;
  const visibleId = enabled ? notice?.id || '' : '';
  const delay = notice?.noticeType === 'image' ? notice.media.closeDelaySeconds : 5;
  const remainingSeconds = countdown.id === visibleId ? countdown.seconds : delay;

  // 在替换／关闭之后释放旧节点；不能提前删除正在显示的媒体文件。
  useEffect(() => () => {
    displayed?.prepared?.dispose();
    releaseCachedMedia(displayed?.cached);
  }, [displayed]);

  // 只从实际可见时刻开始倒计时，0 秒不创建定时器。
  useEffect(() => {
    if (!visibleId) return;
    setCountdown({ id: visibleId, seconds: delay });
    if (delay === 0) return;
    const deadline = Date.now() + delay * 1000;
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setCountdown({ id: visibleId, seconds });
      if (seconds === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [visibleId, delay]);

  // 维持原送达口径：实际弹出后，同一运行期间同一项目版本只上报一次。
  useEffect(() => {
    if (!enabled || !notice) return;
    const key = `${notice.projectName}:${notice.id}`;
    if (reportedRef.current.has(key)) return;
    reportedRef.current.add(key);
    void reportRemoteNoticeDelivered(notice).catch((error) => console.info('[remote-notice] delivery report failed', error));
  }, [enabled, notice]);

  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    let targetId = '';
    let preparing: { id: string; controller: AbortController } | undefined;

    /** 更换唯一可见公告，不维护按类型拆开的弹窗队列。 */
    const show = (value: DisplayedNotice | null) => {
      activeRef.current = value;
      setDisplayed(value);
    };

    /** 先读取当前版本；同版跳过规则沿用旧公告，媒体失败留待下一轮检查。 */
    const check = async () => {
      const checkId = ++requestId;
      try {
        const next = await fetchRemoteNotice();
        if (disposed || checkId !== requestId) return;
        const nextId = next?.id || '';
        if (nextId !== targetId) {
          targetId = nextId;
          preparing?.controller.abort();
          preparing = undefined;
        }
        const synced = window.yibiao?.notice.syncCurrent({ projectName: NOTICE_PROJECT_NAME, noticeId: next?.id || null });
        // 文字公告和已关闭公告不等待任何缓存操作。
        void synced?.catch((error) => console.info('[remote-notice] cache sync failed', error));
        if (!next || hasDismissedRemoteNotice(next.id)) {
          if (activeRef.current?.notice.id !== next?.id) show(null);
          return;
        }
        if (activeRef.current?.notice.id === next.id || preparing?.id === next.id) return;
        if (next.noticeType === 'text') { show({ notice: next }); return; }

        const pending = { id: next.id, controller: new AbortController() };
        preparing = pending;
        let cached: NoticeCachedMedia | undefined;
        let prepared: PreparedNoticeMedia | undefined;
        try {
          await synced;
          pending.controller.signal.throwIfAborted();
          cached = await window.yibiao!.notice.prepareMedia({ projectName: next.projectName, noticeId: next.id, media: next.media });
          pending.controller.signal.throwIfAborted();
          prepared = await prepareNoticeMedia(next.media.kind, cached.url, pending.controller.signal);
          if (disposed || targetId !== next.id || hasDismissedRemoteNotice(next.id)) return;
          show({ notice: next, cached, prepared });
          cached = undefined;
          prepared = undefined;
        } finally {
          prepared?.dispose();
          releaseCachedMedia(cached);
          if (preparing === pending) preparing = undefined;
        }
      } catch (error) {
        if (!disposed) console.info('[remote-notice] check/prepare failed', error);
      }
    };

    window.__yibiaoCheckRemoteNotice = () => { void check(); };
    void check();
    const timer = window.setInterval(() => { void check(); }, 30 * 60 * 1000);
    return () => {
      disposed = true;
      preparing?.controller.abort();
      window.clearInterval(timer);
      delete window.__yibiaoCheckRemoteNotice;
    };
  }, []);

  /** 按配置先打开链接再关闭；异步期间防止重复点击和误关闭新版本。 */
  const close = async () => {
    const value = activeRef.current;
    if (!value || remainingSeconds !== 0 || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      if (value.notice.noticeType === 'image' && value.notice.media.openLinkOnClose) {
        await window.yibiao?.openExternal(value.notice.media.linkUrl);
      }
      dismissRemoteNotice(value.notice.id);
      markNoticeSeen(value.notice.updatedAt);
      if (activeRef.current === value) {
        activeRef.current = null;
        setDisplayed(null);
      }
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  return { notice, prepared: displayed?.prepared, remainingSeconds, closing, close };
}
