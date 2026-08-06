import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { OutlineAttribute, OutlineSelectionItem, OutlineSelectionState } from '../types';

interface OutlineSelectionDialogProps {
  open: boolean;
  selection: OutlineSelectionState;
  saving?: boolean;
  onDismiss: () => void;
  onConfirm: (items: OutlineSelectionItem[], selectedIds: string[]) => void;
}

const outlineAttributes: OutlineAttribute[] = ['通用', '商务', '资信', '技术', '其他'];
const supportedAttributes = new Set<OutlineAttribute>(['通用', '技术', '其他']);
const githubUrl = 'https://github.com/FB208/OpenBidKit_Yibiao';
const unavailableMessage = '正在开发中，在github给作者点个star，可以加速开发。';

// 展示一级目录候选，并维护本次确认前的属性和选择草稿。
function OutlineSelectionDialog({
  open,
  selection,
  saving,
  onDismiss,
  onConfirm,
}: OutlineSelectionDialogProps) {
  const [items, setItems] = useState<OutlineSelectionItem[]>(selection.items);
  const [selectedIds, setSelectedIds] = useState<string[]>(selection.selected_ids);
  const { showToast } = useToast();

  useEffect(() => {
    if (!open) return;
    setItems(selection.items);
    setSelectedIds(selection.selected_ids);
  }, [open, selection]);

  const showUnavailableNotice = () => {
    showToast(unavailableMessage, 'info', {
      duration: 7000,
      actions: [{
        label: '点此直达',
        variant: 'primary',
        onClick: async () => {
          await window.yibiao?.openExternal(githubUrl);
        },
      }],
    });
  };

  const toggleItem = (item: OutlineSelectionItem) => {
    if (!supportedAttributes.has(item.attr)) {
      return;
    }

    setSelectedIds((current) => current.includes(item.id)
      ? current.filter((id) => id !== item.id)
      : [...current, item.id]);
  };

  const toggleAttribute = (attribute: OutlineAttribute) => {
    if (!supportedAttributes.has(attribute)) {
      showUnavailableNotice();
      return;
    }

    const attributeIds = items.filter((item) => item.attr === attribute).map((item) => item.id);
    if (!attributeIds.length) return;
    const allSelected = attributeIds.every((id) => selectedIds.includes(id));
    const attributeIdSet = new Set(attributeIds);
    setSelectedIds((current) => allSelected
      ? current.filter((id) => !attributeIdSet.has(id))
      : [...current, ...attributeIds.filter((id) => !current.includes(id))]);
  };

  const changeAttribute = (itemId: string, attribute: OutlineAttribute) => {
    const selected = selectedIds.includes(itemId);
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, attr: attribute } : item));
    if (selected && !supportedAttributes.has(attribute)) {
      setSelectedIds((current) => current.filter((id) => id !== itemId));
      showUnavailableNotice();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onDismiss(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="outline-selection-dialog">
          <header className="outline-selection-head">
            <div>
              <Dialog.Title>选择一级目录</Dialog.Title>
              <Dialog.Description>选择需要继续扩展的一级目录，也可以在确认前调整目录属性。</Dialog.Description>
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
                  className={`${allSelected ? 'is-active' : ''}${supportedAttributes.has(attribute) ? '' : ' is-unavailable'}`}
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
              <span>使用</span>
            </div>
            <div className="outline-selection-list">
              {items.map((item) => {
                const selected = selectedIds.includes(item.id);
                const supported = supportedAttributes.has(item.attr);
                return (
                  <div className={`outline-selection-row${selected ? ' is-selected' : ''}${supported ? '' : ' is-unavailable'}`} key={item.id}>
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
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`使用目录：${item.title}`}
                      onChange={() => toggleItem(item)}
                      disabled={saving || !supported}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <footer className="outline-selection-actions">
            <span>{selectedIds.length ? `将使用 ${selectedIds.length} 个一级目录` : '请至少选择一个一级目录'}</span>
            <div>
              <button type="button" className="secondary-action" onClick={onDismiss} disabled={saving}>稍后处理</button>
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
