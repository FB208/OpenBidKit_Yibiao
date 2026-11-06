import { useCallback, useState } from 'react';
import { trackNoticeBoardOpen } from '../../../shared/analytics/analytics';
import { fetchNoticeList, type NoticeEntry } from '../../../shared/remoteNotice';
import NoticeMediaContent from './NoticeMediaContent';
import {
  EntryBrowserDialog,
  ImagePreviewDialog,
  MarkdownFullscreenViewer,
  MarkdownRenderer,
  type PreviewImage,
} from '../../../shared/ui';

interface NoticeBoardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 公告加载成功后回传最新更新时间，用于记录已读 */
  onLoaded: (latestUpdatedAt: string) => void;
}

// 同一时间线按公告类型展示内容；历史浏览不应用自动公告的倒计时和关闭跳转。
function NoticeBoardDialog({ open, onOpenChange, onLoaded }: NoticeBoardDialogProps) {
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  const handleLoaded = useCallback((list: NoticeEntry[]) => {
    onLoaded(list.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), ''));
  }, [onLoaded]);

  return (
    <>
      <EntryBrowserDialog<NoticeEntry>
        open={open}
        onOpenChange={onOpenChange}
        kicker="公告"
        fallbackTitle="公告"
        cardClassName="notice-board-dialog"
        loadingText="正在加载公告…"
        errorTitle="公告加载失败"
        emptyTitle="暂无公告"
        selectLabel="选择公告"
        newerLabel="较新公告"
        olderLabel="较旧公告"
        load={fetchNoticeList}
        onOpen={trackNoticeBoardOpen}
        onLoaded={handleLoaded}
        getKey={(entry) => entry.id}
        getOptionLabel={(entry) => `${entry.noticeType === 'image' ? '图片公告' : '文字公告'} · ${entry.title}`}
        getTitle={(entry) => entry.title}
        renderContent={(entry) => (
          <>
            {entry.updatedAt ? <div className="notice-board-time">公告时间：{entry.updatedAt}</div> : null}
            {entry.noticeType === 'image' ? (
              <NoticeMediaContent key={`${entry.id}:${entry.clientNoticeId}`} media={entry.media} title={entry.title} />
            ) : (
            <MarkdownFullscreenViewer
              className="markdown-viewer remote-notice-content"
              fullscreenClassName="markdown-viewer"
              title={`${entry.title}全屏查看`}
            >
              <MarkdownRenderer
                allowRawHtml={false}
                imageMode="preview"
                imageClassName="remote-notice-image"
                onPreviewImage={(src, alt) => setPreviewImage({ src, alt: alt || '公告图片' })}
              >
                {entry.content}
              </MarkdownRenderer>
            </MarkdownFullscreenViewer>
            )}
          </>
        )}
      />
      <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
    </>
  );
}

export default NoticeBoardDialog;
