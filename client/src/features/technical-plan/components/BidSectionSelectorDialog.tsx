import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { DetectedBidSection } from '../types';

interface BidSectionSelectorDialogProps {
  open: boolean;
  sections: DetectedBidSection[];
  totalDeclared?: number | null;
  onSelect: (sectionId: string) => void;
  onCancel: () => void;
  busy?: boolean;
}

function BidSectionSelectorDialog({
  open,
  sections,
  totalDeclared,
  onSelect,
  onCancel,
  busy,
}: BidSectionSelectorDialogProps) {
  const [selectedId, setSelectedId] = useState<string>(sections[0]?.id || '');

  useEffect(() => {
    setSelectedId(open ? sections[0]?.id || '' : '');
  }, [open, sections]);

  const declaredLabel = totalDeclared ? `${totalDeclared} 个` : `${sections.length} 个`;

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="bid-section-selector-card">
          <Dialog.Title className="sr-only">选择投标范围</Dialog.Title>
          <Dialog.Description className="sr-only">检测到招标文件包含多个标段或包，请选择本次投标范围。</Dialog.Description>

          <div className="bid-section-selector-head">
            <h2>选择投标范围</h2>
            <p>检测到本招标文件共包含 <strong>{declaredLabel}</strong>，请选择您要投标的范围。后续解析和生成将只关注该范围相关内容。</p>
          </div>

          <div className="bid-section-selector-list" role="radiogroup" aria-label="投标范围列表">
            {sections.map((section) => {
              const isSelected = section.id === selectedId;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`bid-section-card${isSelected ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(section.id)}
                  disabled={busy}
                  role="radio"
                  aria-checked={isSelected}
                >
                  <div className="bid-section-card-head">
                    <span className="bid-section-card-index">{section.title}</span>
                    {isSelected && <span className="bid-section-card-check">✓</span>}
                  </div>
                  {section.headLine && (
                    <p className="bid-section-card-headline">{section.headLine}</p>
                  )}
                  {section.description && section.description !== section.headLine && (
                    <p className="bid-section-card-description">{section.description}</p>
                  )}
                </button>
              );
            })}
          </div>

          <div className="bid-section-selector-actions">
            <Dialog.Close className="secondary-action" type="button" disabled={busy}>取消</Dialog.Close>
            <button
              type="button"
              className="primary-action"
              onClick={() => onSelect(selectedId)}
              disabled={busy || !selectedId}
            >
              {busy ? '导入中...' : '确认导入'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BidSectionSelectorDialog;
