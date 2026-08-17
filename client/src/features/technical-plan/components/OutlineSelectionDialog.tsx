import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { OutlineContentMode } from '../../../shared/types';
import { AppSwitch, useAutoAnswer } from '../../../shared/ui';
import type { OutlineAttribute, OutlineSelectionItem, OutlineSelectionState } from '../types';

interface OutlineSelectionDialogProps {
  open: boolean;
  selection: OutlineSelectionState;
  saving?: boolean;
  onDismiss: () => void;
  onInteraction: () => void;
  onConfirm: (items: OutlineSelectionItem[], selectedIds: string[]) => void;
}

const outlineAttributes: OutlineAttribute[] = ['通用', '商务', '资信', '技术', '其他'];
const contentModes = Object.keys(OUTLINE_CONTENT_MODE_LABELS) as OutlineContentMode[];

// 展示一级目录候选，并维护本次确认前的属性和选择草稿。
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

  const toggleItem = (item: OutlineSelectionItem) => {
    reportInteraction();
    setSelectedIds((current) => current.includes(item.id)
      ? current.filter((id) => id !== item.id)
      : [...current, item.id]);
  };

  const toggleAttribute = (attribute: OutlineAttribute) => {
    const attributeIds = items.filter((item) => item.attr === attribute).map((item) => item.id);
    if (!attributeIds.length) return;
    reportInteraction();
    const allSelected = attributeIds.every((id) => selectedIds.includes(id));
    const attributeIdSet = new Set(attributeIds);
    setSelectedIds((current) => allSelected
      ? current.filter((id) => !attributeIdSet.has(id))
      : [...current, ...attributeIds.filter((id) => !current.includes(id))]);
  };

  const changeAttribute = (itemId: string, attribute: OutlineAttribute) => {
    reportInteraction();
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, attr: attribute } : item));
  };

  const changeContentMode = (itemId: string, contentMode: OutlineContentMode) => {
    reportInteraction();
    setItems((current) => current.map((item) => item.id === itemId
      ? { ...item, content_mode: contentMode, ...(contentMode === 'other' ? {} : { content_mode_note: undefined }) }
      : item));
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
              <Dialog.Title>选择一级目录</Dialog.Title>
              <Dialog.Description>选择需要继续使用的一级目录，也可以在确认前调整目录属性和内容处理模式。</Dialog.Description>
            </div>
            <span aria-live="polite">已选 {selectedIds.length} / {items.length}</span>
          </header>

          <div className="outline-selection-filters" aria-label="按属性快捷选择">
            {outlineAttributes.map((attribute) => {
              const attributeItems = items.filter((item) => item.attr === attribute);
              const allSelected = Boolean(attributeItems.length)
                && attributeItems.every((item) => selectedIds.includes(item.id));
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
              {items.map((item) => {
                const selected = selectedIds.includes(item.id);
                return (
                  <div className={`outline-selection-row${selected ? ' is-selected' : ''}`} key={item.id}>
                    <span className="outline-selection-id">{item.id}</span>
                    <strong title={item.title}>{item.title}</strong>
                    <select
                      value={item.attr}
                      aria-label={`${item.title}的目录属性`}
                      onChange={(event) => changeAttribute(item.id, event.target.value as OutlineAttribute)}
                      disabled={saving}
                    >
                      {outlineAttributes.map((attribute) => <option key={attribute} value={attribute}>{attribute}</option>)}
                    </select>
                    <select
                      className="outline-selection-mode"
                      value={item.content_mode}
                      aria-label={`${item.title}的内容处理模式`}
                      onChange={(event) => changeContentMode(item.id, event.target.value as OutlineContentMode)}
                      disabled={saving}
                    >
                      {contentModes.map((mode) => <option key={mode} value={mode}>{OUTLINE_CONTENT_MODE_LABELS[mode]}</option>)}
                    </select>
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`使用目录：${item.title}`}
                      onChange={() => toggleItem(item)}
                      disabled={saving}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <footer className="outline-selection-actions">
            <div className="outline-selection-summary">
              <span>{selectedIds.length ? `将使用 ${selectedIds.length} 个一级目录` : '请至少选择一个一级目录'}</span>
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
                disabled={saving || !selectedIds.length}
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
