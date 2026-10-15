import { useCallback } from 'react';
import { trackChangelogOpen } from '../../../shared/analytics/analytics';
import { EntryBrowserDialog, MarkdownRenderer } from '../../../shared/ui';
import { fetchChangelogs, type ChangelogEntry } from '../services/changelogService';

interface ChangelogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 日志加载成功后回传最新发布时间，用于记录已读 */
  onLoaded: (latestPublishedAt: string) => void;
}

function ChangelogDialog({ open, onOpenChange, onLoaded }: ChangelogDialogProps) {
  const handleLoaded = useCallback((list: ChangelogEntry[]) => {
    onLoaded(list.reduce((latest, item) => (item.publishedAt > latest ? item.publishedAt : latest), ''));
  }, [onLoaded]);

  return (
    <EntryBrowserDialog<ChangelogEntry>
      open={open}
      onOpenChange={onOpenChange}
      kicker="更新日志"
      fallbackTitle="更新日志"
      cardClassName="changelog-dialog"
      loadingText="正在加载更新日志…"
      errorTitle="更新日志加载失败"
      emptyTitle="暂无更新日志"
      selectLabel="选择版本"
      newerLabel="较新版本"
      olderLabel="较旧版本"
      load={fetchChangelogs}
      onOpen={trackChangelogOpen}
      onLoaded={handleLoaded}
      getKey={(entry) => entry.version}
      getOptionLabel={(entry) => `v${entry.version}`}
      getTitle={(entry) => `v${entry.version}`}
      renderContent={(entry) => (
        <div className="changelog-content">
          <MarkdownRenderer allowRawHtml={false}>{entry.content}</MarkdownRenderer>
        </div>
      )}
    />
  );
}

export default ChangelogDialog;
