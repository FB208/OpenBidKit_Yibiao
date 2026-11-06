import { useLayoutEffect, useRef, useState } from 'react';
import type { NoticeMedia } from '../../../shared/types/notice';
import { InlineSpinner } from '../../../shared/ui';
import { prepareNoticeMedia, type PreparedNoticeMedia } from '../noticeMedia';

interface NoticeMediaContentProps {
  media: NoticeMedia;
  title: string;
  prepared?: PreparedNoticeMedia;
}

/** 自动公告复用预先解码的同一节点；历史浏览只加载选中的媒体。 */
function NoticeMediaContent({ media, title, prepared }: NoticeMediaContentProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(prepared ? 'ready' : 'loading');

  useLayoutEffect(() => {
    const controller = new AbortController();
    let owned: PreparedNoticeMedia | undefined;
    let attached: PreparedNoticeMedia | undefined;
    let playbackFrame: number | undefined;

    /** 将已就绪的媒体节点直接移入内容区，避免弹出后重新下载或解码。 */
    const attach = (value: PreparedNoticeMedia) => {
      if (controller.signal.aborted) return;
      attached = value;
      const element = value.element;
      if (element instanceof HTMLImageElement) element.alt = title;
      else {
        element.setAttribute('aria-label', title);
        element.currentTime = 0;
        element.muted = true;
        element.autoplay = true;
      }
      hostRef.current?.replaceChildren(element);
      setStatus('ready');
      if (element instanceof HTMLVideoElement) {
        // 等待挂载稳定后播放，避免挂载清理打断尚未完成的播放请求。
        playbackFrame = window.requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          void element.play().catch((error: unknown) => {
            if (!controller.signal.aborted) {
              console.info('[remote-notice] 自动播放未开始', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
            }
          });
        });
      }
    };

    if (prepared) attach(prepared);
    else {
      setStatus('loading');
      void prepareNoticeMedia(media.kind, media.url, controller.signal).then((value) => {
        owned = value;
        if (controller.signal.aborted) value.dispose();
        else attach(value);
      }).catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    }
    return () => {
      controller.abort();
      if (playbackFrame !== undefined) window.cancelAnimationFrame(playbackFrame);
      if (attached?.element instanceof HTMLVideoElement) attached.element.pause();
      attached?.element.remove();
      owned?.dispose();
    };
  }, [media.kind, media.url, prepared, title]);

  /** 媒体点击与关闭跳转分离，点击详情不关闭公告。 */
  const openLink = () => { void window.yibiao?.openExternal(media.linkUrl); };

  const host = <span className="notice-media-host" ref={hostRef} />;
  return (
    <div className="notice-media-content">
      {status === 'loading' ? <div className="notice-media-status"><InlineSpinner />正在加载公告媒体…</div> : null}
      {status === 'error' ? <p className="notice-media-status">公告媒体加载失败，请重新打开后重试。</p> : null}
      {media.kind === 'image' && media.linkUrl ? (
        <button className="notice-media-link" type="button" onClick={openLink} aria-label="查看公告详情" disabled={status !== 'ready'}>{host}</button>
      ) : host}
      {media.kind === 'video' && media.linkUrl ? <button className="secondary-action notice-media-details" type="button" onClick={openLink}>查看详情</button> : null}
    </div>
  );
}

export default NoticeMediaContent;
