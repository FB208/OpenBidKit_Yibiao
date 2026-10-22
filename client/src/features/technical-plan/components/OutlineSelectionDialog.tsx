import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { OutlineContentMode } from '../../../shared/types';
import { AppSwitch, useAutoAnswer } from '../../../shared/ui';
import type { OutlineAttribute, OutlineSelectionBasis, OutlineSelectionItem, OutlineSelectionState } from '../types';

interface OutlineSelectionDialogProps {
  open: boolean;
  selection: OutlineSelectionState;
  saving?: boolean;
  onDismiss: () => void;
  onInteraction: () => void;
  onConfirm: (items: OutlineSelectionItem[], selectedIds: string[]) => void;
}

interface SelectionRow {
  item: OutlineSelectionItem;
  depth: number;
  ancestorIds: string[];
}

const outlineAttributes: OutlineAttribute[] = ['通用', '商务/资信', '技术', '其他', '目录', '报价', '业绩'];
const contentModes = Object.keys(OUTLINE_CONTENT_MODE_LABELS) as OutlineContentMode[];
const basisLabels: Record<OutlineSelectionBasis, string> = {
  'format-template': '依据：招标文件投标文件格式',
  'response-requirements': '依据：响应文件要求（未找到明确格式）',
};

// 按先序展开目录树，记录层级和祖先，供缩进与联动勾选使用。
function flattenItems(items: OutlineSelectionItem[], depth = 0, ancestorIds: string[] = [], rows: SelectionRow[] = []) {
  items.forEach((item) => {
    rows.push({ item, depth, ancestorIds });
    if (item.children?.length) flattenItems(item.children, depth + 1, [...ancestorIds, item.id], rows);
  });
  return rows;
}

function collectSubtreeIds(item: OutlineSelectionItem, ids: string[] = []) {
  ids.push(item.id);
  item.children?.forEach((child) => collectSubtreeIds(child, ids));
  return ids;
}

function updateItem(items: OutlineSelectionItem[], itemId: string, patch: (item: OutlineSelectionItem) => OutlineSelectionItem): OutlineSelectionItem[] {
  return items.map((item) => {
    if (item.id === itemId) return patch(item);
    return item.children?.length ? { ...item, children: updateItem(item.children, itemId, patch) } : item;
  });
}

// 取消勾选后，从近到远移除已没有选中子目录的上级目录。
function pruneAncestors(selected: Set<string>, ancestorIds: string[], rowsById: Map<string, SelectionRow>) {
  [...ancestorIds].reverse().forEach((ancestorId) => {
    const children = rowsById.get(ancestorId)?.item.children || [];
    if (!children.some((child) => selected.has(child.id))) selected.delete(ancestorId);
  });
}

// 展示目录候选树，并维护本次确认前的属性、处理模式和勾选草稿。
function OutlineSelectionDialog({
  open,
  selection,
  saving,
  onDismiss,
  onInteraction,
  onConfirm,
}: OutlineSelectionDialogProps) {
  const [items, setItems] = useState<OutlineSelectionItem[]>(selection.items);
  const [selectedIds, setSelectedIds] = useState<string[]>(selection.selected_ids);
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const interactionReportedRef = useRef(false);
  const { enabled: autoAnswerEnabled, saving: autoAnswerSaving, setEnabled: setAutoAnswerEnabled } = useAutoAnswer();
  const rows = useMemo(() => flattenItems(items), [items]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.item.id, row])), [rows]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const leafRows = rows.filter((row) => !row.item.children?.length);
  const selectedLeafCount = leafRows.filter((row) => selectedIdSet.has(row.item.id)).length;

  useEffect(() => {
    if (!open) return;
    setItems(selection.items);
    setSelectedIds(selection.selected_ids);
    interactionReportedRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!selection.auto_answer_at) {
      setCountdownSeconds(0);
      return;
    }
    const deadline = new Date(selection.auto_answer_at).getTime();
    const updateCountdown = () => {
      setCountdownSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [selection.auto_answer_at]);

  // 首次修改目录草稿时通知 Main 停止本次自动确认。
  const reportInteraction = () => {
    if (interactionReportedRef.current) return;
    interactionReportedRef.current = true;
    onInteraction();
  };

  // 勾选会带上整棵子树和全部上级；取消会移除整棵子树，并移除已没有选中子目录的上级。
  const toggleRow = (row: SelectionRow) => {
    reportInteraction();
    setSelectedIds((current) => {
      const next = new Set(current);
      const subtreeIds = collectSubtreeIds(row.item);
      if (next.has(row.item.id)) {
        subtreeIds.forEach((id) => next.delete(id));
        pruneAncestors(next, row.ancestorIds, rowsById);
      } else {
        [...row.ancestorIds, ...subtreeIds].forEach((id) => next.add(id));
      }
      return [...next];
    });
  };

  // 属性快捷按钮按一级目录的属性整棵选中或取消。
  const toggleAttribute = (attribute: OutlineAttribute) => {
    const roots = items.filter((item) => item.attr === attribute);
    if (!roots.length) return;
    reportInteraction();
    const allSelected = roots.every((item) => selectedIdSet.has(item.id));
    const subtreeIds = roots.flatMap((item) => collectSubtreeIds(item));
    setSelectedIds((current) => {
      const next = new Set(current);
      subtreeIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return [...next];
    });
  };

  const changeAttribute = (itemId: string, attribute: OutlineAttribute) => {
    reportInteraction();
    setItems((current) => updateItem(current, itemId, (item) => ({ ...item, attr: attribute })));
  };

  const changeContentMode = (itemId: string, contentMode: OutlineContentMode) => {
    reportInteraction();
    setItems((current) => updateItem(current, itemId, (item) => ({
      ...item,
      content_mode: contentMode,
      ...(contentMode === 'other' ? {} : { content_mode_note: undefined }),
    })));
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !saving) {
        reportInteraction();
        onDismiss();
      }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="outline-selection-dialog">
          <header className="outline-selection-head">
            <div>
              <Dialog.Title>选择目录</Dialog.Title>
              <Dialog.Description>选择需要使用的目录，也可以在确认前调整一级目录的属性和各目录的内容处理模式。</Dialog.Description>
              {selection.basis && <p className="outline-selection-basis">{basisLabels[selection.basis]}</p>}
            </div>
            <span aria-live="polite">已选 {selectedLeafCount} / {leafRows.length}</span>
          </header>

          <div className="outline-selection-filters" aria-label="按属性快捷选择">
            {outlineAttributes.map((attribute) => {
              const attributeItems = items.filter((item) => item.attr === attribute);
              const allSelected = Boolean(attributeItems.length)
                && attributeItems.every((item) => selectedIdSet.has(item.id));
              return (
                <button
                  key={attribute}
                  type="button"
                  className={allSelected ? 'is-active' : ''}
                  aria-pressed={allSelected}
                  onClick={() => toggleAttribute(attribute)}
                  disabled={saving}
                >
                  {attribute}
                </button>
              );
            })}
          </div>

          <div className="outline-selection-table">
            <div className="outline-selection-row is-header" aria-hidden="true">
              <span>ID</span>
              <span>标题</span>
              <span>属性</span>
              <span>处理模式</span>
              <span>使用</span>
            </div>
            <div className="outline-selection-list">
              {rows.map((row) => {
                const { item } = row;
                const selected = selectedIdSet.has(item.id);
                const leaf = !item.children?.length;
                return (
                  <div className={`outline-selection-row${selected ? ' is-selected' : ''}`} key={item.id}>
                    <span className="outline-selection-id">{item.number}</span>
                    <div className="outline-selection-title" style={{ '--outline-selection-depth': row.depth } as CSSProperties}>
                      <strong title={item.title}>{item.title}</strong>
                      {item.post_award && <span className="outline-selection-tag">中标后使用</span>}
                    </div>
                    {row.depth === 0 && item.attr ? (
                      <select
                        value={item.attr}
                        aria-label={`${item.title}的目录属性`}
                        onChange={(event) => changeAttribute(item.id, event.target.value as OutlineAttribute)}
                        disabled={saving}
                      >
                        {outlineAttributes.map((attribute) => <option key={attribute} value={attribute}>{attribute}</option>)}
                      </select>
                    ) : (
                      <span className="outline-selection-blank is-attribute" aria-hidden="true">—</span>
                    )}
                    {leaf && item.content_mode ? (
                      <select
                        className="outline-selection-mode"
                        value={item.content_mode}
                        aria-label={`${item.title}的内容处理模式`}
                        onChange={(event) => changeContentMode(item.id, event.target.value as OutlineContentMode)}
                        disabled={saving}
                      >
                        {contentModes.map((mode) => <option key={mode} value={mode}>{OUTLINE_CONTENT_MODE_LABELS[mode]}</option>)}
                      </select>
                    ) : (
                      <span className="outline-selection-blank is-mode" aria-hidden="true">—</span>
                    )}
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`使用目录：${item.title}`}
                      onChange={() => toggleRow(row)}
                      disabled={saving}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <footer className="outline-selection-actions">
            <div className="outline-selection-summary">
              <span>{selectedLeafCount ? `将使用 ${selectedLeafCount} 个目录` : '请至少选择一个目录'}</span>
              <div className="outline-selection-auto-answer">
                <label>
                  <AppSwitch checked={autoAnswerEnabled} disabled={autoAnswerSaving || saving} onCheckedChange={(checked) => void setAutoAnswerEnabled(checked)} />
                  <span>自动确认</span>
                </label>
                {selection.auto_answer_at && (
                  <small>{countdownSeconds} 秒后自动提交默认选择</small>
                )}
              </div>
            </div>
            <div className="outline-selection-buttons">
              <button type="button" className="secondary-action" onClick={() => {
                reportInteraction();
                onDismiss();
              }} disabled={saving}>稍后处理</button>
              <button
                type="button"
                className="primary-action"
                onClick={() => onConfirm(items, selectedIds)}
                disabled={saving || !selectedLeafCount}
              >
                {saving ? '正在保存...' : '确认选择'}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default OutlineSelectionDialog;
