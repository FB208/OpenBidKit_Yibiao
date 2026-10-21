import { useEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from '@radix-ui/react-icons';
import type { StorageCleanGroupId, StorageCleanResult, StorageUsage, StorageUsageGroupId } from '../../../shared/types';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes: number) {
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${BYTE_UNITS[unitIndex]}`;
}

// 跳过的清理项按原因合并成一句提示。
function describeCleanResult(result: StorageCleanResult) {
  const parts = [`已释放 ${formatBytes(result.freedBytes)}`];
  if (result.failedCount > 0) parts.push(`${result.failedCount} 项文件被占用未删除`);
  const skippedByReason = new Map<string, string[]>();
  result.skipped.forEach(({ label, reason }) => skippedByReason.set(reason, [...(skippedByReason.get(reason) || []), label]));
  skippedByReason.forEach((labels, reason) => parts.push(`${reason}，已跳过${labels.join('、')}`));
  return parts.join('；');
}

// 打开即统计占用；删除完成后直接使用 Main 返回的最新统计。分组默认折叠，展开查看明细。
export default function StorageSpaceDialog({ onClose }: { onClose: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [cleaningGroup, setCleaningGroup] = useState<StorageCleanGroupId | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<StorageUsageGroupId>>(() => new Set());
  const mounted = useRef(false);
  const { showToast } = useToast();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    setStatus('loading');
    void window.yibiao.storage.getUsage().then((nextUsage) => {
      if (disposed) return;
      setUsage(nextUsage);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '计算占用空间失败', 'error');
    });
    return () => { disposed = true; };
  }, [attempt, showToast]);

  const toggleGroup = (groupId: StorageUsageGroupId) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const cleanGroup = async (groupId: StorageCleanGroupId) => {
    if (cleaningGroup) return;
    setCleaningGroup(groupId);
    try {
      const result = await window.yibiao.storage.clean(groupId);
      if (!mounted.current) return;
      setUsage(result.usage);
      showToast(describeCleanResult(result), result.skipped.length || result.failedCount ? 'info' : 'success');
    } catch (error) {
      if (mounted.current) showToast(error instanceof Error ? error.message : '清理失败', 'error');
    } finally {
      if (mounted.current) setCleaningGroup(null);
    }
  };

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      kicker="通用"
      title="存储空间"
      description={usage && status === 'ready' ? `共占用 ${formatBytes(usage.totalBytes)}` : undefined}
      cardClassName="storage-space-dialog"
      preventClose={cleaningGroup !== null}
      actions={(
        <>
          {status === 'error' && (
            <button type="button" className="primary-action" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          )}
          <button type="button" className="secondary-action" disabled={cleaningGroup !== null} onClick={onClose}>关闭</button>
        </>
      )}
    >
      <div className="storage-space-body" aria-busy={status === 'loading' || cleaningGroup !== null}>
        {status !== 'ready' || !usage ? (
          <div className="storage-space-status" role="status">
            {status === 'loading' && <InlineSpinner />}
            {status === 'loading' ? '正在计算占用空间…' : '占用空间计算失败，请重试'}
          </div>
        ) : usage.groups.map((group) => {
          const expanded = expandedGroups.has(group.id);
          return (
            <section className={`storage-space-group is-${group.id}${expanded ? ' is-expanded' : ''}`} key={group.id}>
              <div className="storage-space-group-head">
                <button
                  type="button"
                  className="storage-space-group-toggle"
                  aria-expanded={expanded}
                  aria-controls={`storage-space-items-${group.id}`}
                  onClick={() => toggleGroup(group.id)}
                >
                  <ChevronRightIcon className="storage-space-group-chevron" aria-hidden="true" />
                  <span className="storage-space-group-copy">
                    <strong>{group.label}</strong>
                    <span>{group.description}</span>
                  </span>
                  <span className="storage-space-size">{formatBytes(group.bytes)}</span>
                </button>
                {group.id !== 'protected' && (
                  <button
                    type="button"
                    className="danger-action"
                    disabled={cleaningGroup !== null || group.bytes === 0}
                    onClick={() => { void cleanGroup(group.id as StorageCleanGroupId); }}
                  >
                    {cleaningGroup === group.id ? '正在删除…' : '删除'}
                  </button>
                )}
              </div>
              {expanded && (
                <ul className="storage-space-items" id={`storage-space-items-${group.id}`}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <div className="storage-space-item-copy">
                        <span>{item.label}</span>
                        <small>{item.description}</small>
                      </div>
                      <span className="storage-space-size">{formatBytes(item.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </AppDialog>
  );
}
