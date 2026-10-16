import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import AppDialog from './AppDialog';
import EmptyState from './EmptyState';
import InlineSpinner from './InlineSpinner';

export interface EntryBrowserDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kicker: string;
  /** 加载中、失败或无数据时的标题 */
  fallbackTitle: string;
  cardClassName?: string;
  loadingText: string;
  errorTitle: string;
  emptyTitle: string;
  selectLabel: string;
  /** 左右切换按钮的提示文案，例如“较新版本”“较旧版本” */
  newerLabel: string;
  olderLabel: string;
  /** 读取全部条目，需已按新到旧排序；失败时抛错，弹窗展示重试 */
  load: () => Promise<T[]>;
  /** 每次打开弹窗时调用，用于埋点 */
  onOpen?: () => void;
  /** 条目加载成功后回调，用于记录已读 */
  onLoaded?: (entries: T[]) => void;
  getKey: (entry: T) => string;
  getOptionLabel: (entry: T) => string;
  getTitle: (entry: T) => string;
  renderContent: (entry: T) => ReactNode;
}

type LoadStatus = 'loading' | 'ready' | 'error';

/**
 * 侧栏远程内容浏览弹窗：每次打开重新加载，默认显示最新一条，
 * 通过下拉框和左右按钮切换（左侧较新、右侧较旧）。
 */
export default function EntryBrowserDialog<T>({
  open,
  onOpenChange,
  kicker,
  fallbackTitle,
  cardClassName,
  loadingText,
  errorTitle,
  emptyTitle,
  selectLabel,
  newerLabel,
  olderLabel,
  load,
  onOpen,
  onLoaded,
  getKey,
  getOptionLabel,
  getTitle,
  renderContent,
}: EntryBrowserDialogProps<T>) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [entries, setEntries] = useState<T[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const requestIdRef = useRef(0);
  const current = entries[selectedIndex];

  const loadEntries = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');
    try {
      const list = await load();
      if (requestId !== requestIdRef.current) return;
      setEntries(list);
      setSelectedIndex(0);
      setStatus('ready');
      onLoaded?.(list);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.info(`[${kicker}] load failed`, error);
      setStatus('error');
    }
  }, [kicker, load, onLoaded]);

  useEffect(() => {
    if (!open) return;
    onOpen?.();
    void loadEntries();
    // 只在打开时触发一次，避免回调引用变化导致重复加载和重复埋点。
  }, [open]);

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={kicker}
      title={status === 'ready' && current ? getTitle(current) : fallbackTitle}
      cardClassName={cardClassName}
      actions={<button type="button" className="secondary-action" onClick={() => onOpenChange(false)}>关闭</button>}
    >
      {status === 'loading' ? (
        <div className="entry-browser-loading">
          <InlineSpinner />
          <span>{loadingText}</span>
        </div>
      ) : null}

      {status === 'error' ? (
        <EmptyState className="entry-browser-empty" title={errorTitle} hint="请检查网络后重试">
          <button type="button" className="secondary-action" onClick={() => void loadEntries()}>重试</button>
        </EmptyState>
      ) : null}

      {status === 'ready' && !current ? <EmptyState className="entry-browser-empty" title={emptyTitle} /> : null}

      {status === 'ready' && current ? (
        <>
          <div className="entry-browser-nav">
            <button
              type="button"
              className="entry-browser-nav-button"
              aria-label={newerLabel}
              title={newerLabel}
              disabled={selectedIndex <= 0}
              onClick={() => setSelectedIndex((index) => Math.max(0, index - 1))}
            >
              ‹
            </button>
            <select
              className="entry-browser-select"
              aria-label={selectLabel}
              value={selectedIndex}
              onChange={(event) => setSelectedIndex(Number(event.target.value))}
            >
              {entries.map((entry, index) => (
                <option key={getKey(entry)} value={index}>{getOptionLabel(entry)}</option>
              ))}
            </select>
            <button
              type="button"
              className="entry-browser-nav-button"
              aria-label={olderLabel}
              title={olderLabel}
              disabled={selectedIndex >= entries.length - 1}
              onClick={() => setSelectedIndex((index) => Math.min(entries.length - 1, index + 1))}
            >
              ›
            </button>
          </div>
          {renderContent(current)}
        </>
      ) : null}
    </AppDialog>
  );
}
