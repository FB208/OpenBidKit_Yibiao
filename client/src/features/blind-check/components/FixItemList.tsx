import { useMemo, useState } from 'react';
import { ChevronRightIcon } from '@radix-ui/react-icons';
import type { BlindCheckFixItem } from '../types';
import { severityLabels } from './FindingGroupList';
import { DetailRow, DetailRows, Occurrence, OccurrenceList, OccurrenceNote } from './IssueDetail';

type FixFilter = 'all' | 'pending' | 'fixed';

const filters: Array<{ id: FixFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待人工处理' },
  { id: 'fixed', label: '已修复' },
];
const severityOrder = ['high', 'medium', 'low'];

const editLabels: Record<BlindCheckFixItem['edits'][number]['op'], string> = {
  replace: '替换文字',
  delete_paragraph: '删除段落',
  clear_image_alt: '清除图片替代文字',
};

/**
 * 修复结果：修复范围内的问题和修复后新出现的问题，每行给出已修复、待人工处理的处数，不区分程序还是 AI 修的。
 * 筛选按处数计，部分修复的问题在两个筛选里都会出现；待人工的排在前面，展开看原因、做法、仍存在的位置和修改内容。
 */
export default function FixItemList({ items }: { items: BlindCheckFixItem[] }) {
  const [filter, setFilter] = useState<FixFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const counts = useMemo(() => ({
    all: items.reduce((sum, item) => sum + item.count, 0),
    pending: items.reduce((sum, item) => sum + item.pending, 0),
    fixed: items.reduce((sum, item) => sum + item.fixed, 0),
  }), [items]);
  const ordered = useMemo(
    () => [...items].sort((left, right) => Number(right.pending > 0) - Number(left.pending > 0)
      || severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity)),
    [items],
  );
  const visible = filter === 'all' ? ordered : ordered.filter((item) => item[filter] > 0);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="blind-check-fix-items">
      <div className="rejection-bid-result-filter" role="tablist" aria-label="按处理结果筛选">
        {filters.filter((item) => item.id === 'all' || counts[item.id] > 0 || item.id === filter).map((item) => (
          <button type="button" key={item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)}>
            {item.label}
            <span>{`${counts[item.id]} 处`}</span>
          </button>
        ))}
      </div>
      <div className="blind-check-group-list">
        {visible.map((item) => {
          const open = expanded.has(item.id);
          return (
            <article className={`blind-check-group is-${item.severity}${item.pending ? '' : ' is-fix-fixed'}${open ? ' is-expanded' : ''}`} key={item.id}>
              <button type="button" className="blind-check-group-row" onClick={() => toggle(item.id)} aria-expanded={open}>
                <ChevronRightIcon className="blind-check-group-chevron" aria-hidden="true" />
                <em className={`rejection-finding-severity is-${item.severity}`}>{severityLabels[item.severity]}</em>
                <strong title={item.message}>{item.message}</strong>
                {item.isNew && <em className="blind-check-group-tag">修复后新出现</em>}
                <span className="blind-check-fix-badges">
                  {item.fixed > 0 && <em className="is-fixed">{`已修复 ${item.fixed} 处`}</em>}
                  {item.pending > 0 && <em className="is-pending">{`待人工 ${item.pending} 处`}</em>}
                </span>
                <span className="blind-check-group-count">{`共 ${item.count} 处`}</span>
              </button>
              {open && (
                <div className="blind-check-group-detail">
                  <DetailRows>
                    {item.pending > 0 && <DetailRow label="未修复原因">{item.reason || '自动修复无法处理'}</DetailRow>}
                    {item.pending > 0 && item.suggestion && <DetailRow label="人工处理">{item.suggestion}</DetailRow>}
                    {!item.pending && !item.edits.length && <DetailRow label="处理情况">复查已确认这些问题不再出现。</DetailRow>}
                    {item.pendingOccurrences.length > 0 && (
                      <DetailRow label="出现位置">
                        <OccurrenceList>
                          {item.pendingOccurrences.map((occurrence, index) => (
                            <Occurrence where={occurrence.where} text={occurrence.text} key={`${occurrence.where}-${index}`}>
                              {occurrence.notes.map((note) => <OccurrenceNote key={note}>{note}</OccurrenceNote>)}
                            </Occurrence>
                          ))}
                        </OccurrenceList>
                      </DetailRow>
                    )}
                    {item.edits.length > 0 && (
                      <DetailRow label="修改内容">
                        <OccurrenceList>
                          {item.edits.map((edit, index) => (
                            <Occurrence where={edit.target} key={`${edit.target}-${index}`}>
                              <OccurrenceNote>{editLabels[edit.op] || edit.op}</OccurrenceNote>
                              {edit.before && <del>{edit.before}</del>}
                              {edit.op === 'replace' && <ins>{edit.after || '（删除）'}</ins>}
                            </Occurrence>
                          ))}
                        </OccurrenceList>
                      </DetailRow>
                    )}
                  </DetailRows>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
