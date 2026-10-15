import { useCallback, useEffect, useRef, useState } from 'react';
import { trackChangelogOpen } from '../../../shared/analytics/analytics';
import { AppDialog, EmptyState, InlineSpinner, MarkdownRenderer } from '../../../shared/ui';
import { fetchChangelogs, type ChangelogEntry } from '../services/changelogService';

interface ChangelogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 日志加载成功后回传最新发布时间，用于记录已读 */
  onLoaded: (latestPublishedAt: string) => void;
}

type LoadStatus = 'loading' | 'ready' | 'error';

function ChangelogDialog({ open, onOpenChange, onLoaded }: ChangelogDialogProps) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const requestIdRef = useRef(0);
  const current = entries[selectedIndex];

  const loadChangelogs = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');
    try {
      const list = await fetchChangelogs();
      if (requestId !== requestIdRef.current) return;
      setEntries(list);
      setSelectedIndex(0);
      setStatus('ready');
      onLoaded(list.reduce((latest, item) => (item.publishedAt > latest ? item.publishedAt : latest), ''));
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.info('[changelog] load failed', error);
      setStatus('error');
    }
  }, [onLoaded]);

  useEffect(() => {
    if (!open) return;
    trackChangelogOpen();
    void loadChangelogs();
  }, [open, loadChangelogs]);

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="更新日志"
      title={status === 'ready' && current ? `v${current.version}` : '更新日志'}
      cardClassName="changelog-dialog"
      actions={<button type="button" className="secondary-action" onClick={() => onOpenChange(false)}>关闭</button>}
    >
      {status === 'loading' ? (
        <div className="changelog-loading">
          <InlineSpinner />
          <span>正在加载更新日志…</span>
        </div>
      ) : null}

      {status === 'error' ? (
        <EmptyState className="changelog-empty" title="更新日志加载失败" hint="请检查网络后重试">
          <button type="button" className="secondary-action" onClick={() => void loadChangelogs()}>重试</button>
        </EmptyState>
      ) : null}

      {status === 'ready' && !current ? <EmptyState className="changelog-empty" title="暂无更新日志" /> : null}

      {status === 'ready' && current ? (
        <>
          <div className="changelog-nav">
            <button
              type="button"
              className="changelog-nav-button"
              aria-label="较旧版本"
              title="较旧版本"
              disabled={selectedIndex >= entries.length - 1}
              onClick={() => setSelectedIndex((index) => Math.min(entries.length - 1, index + 1))}
            >
              ‹
            </button>
            <select
              className="changelog-version-select"
              aria-label="选择版本"
              value={selectedIndex}
              onChange={(event) => setSelectedIndex(Number(event.target.value))}
            >
              {entries.map((entry, index) => (
                <option key={entry.version} value={index}>v{entry.version}</option>
              ))}
            </select>
            <button
              type="button"
              className="changelog-nav-button"
              aria-label="较新版本"
              title="较新版本"
              disabled={selectedIndex <= 0}
              onClick={() => setSelectedIndex((index) => Math.max(0, index - 1))}
            >
              ›
            </button>
          </div>
          <div className="changelog-content">
            <MarkdownRenderer allowRawHtml={false}>{current.content}</MarkdownRenderer>
          </div>
        </>
      ) : null}
    </AppDialog>
  );
}

export default ChangelogDialog;
