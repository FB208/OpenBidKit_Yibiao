import { useEffect, useState } from 'react';
import type { BidSection } from '../types';

interface BidSectionSelectorProps {
  bidSections: BidSection[];
  onConfirm: (selectedIds: string[]) => void;
  onSkip: () => void;
}

function BidSectionSelector({ bidSections, onConfirm, onSkip }: BidSectionSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(bidSections.map((s) => s.section_id)));

  useEffect(() => {
    setSelected(new Set(bidSections.map((s) => s.section_id)));
  }, [bidSections]);

  const toggleSection = (sectionId: string) => {
    const next = new Set(selected);
    if (next.has(sectionId)) {
      next.delete(sectionId);
    } else {
      next.add(sectionId);
    }
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === bidSections.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bidSections.map((s) => s.section_id)));
    }
  };

  const handleConfirm = () => {
    const ids = Array.from(selected);
    if (ids.length > 0) {
      onConfirm(ids);
    }
  };

  return (
    <div className="plan-step-body">
      <section className="analysis-import-card">
        <div>
          <span className="section-kicker">标段选择</span>
          <strong>检测到 {bidSections.length} 个标段，请选择你参与投标的标段</strong>
          <p>每个选中的标段将独立生成技术方案。如果只选一个标段，流程与单标段招标一致。</p>
        </div>
      </section>

      <section className="bid-section-list-card">
        <div className="bid-section-list-header">
          <label className="bid-section-select-all">
            <input
              type="checkbox"
              checked={selected.size === bidSections.length}
              onChange={toggleAll}
            />
            全选 / 取消全选
          </label>
        </div>

        <div className="bid-section-items">
          {bidSections.map((section) => (
            <label
              key={section.section_id}
              className={`bid-section-item ${selected.has(section.section_id) ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.has(section.section_id)}
                onChange={() => toggleSection(section.section_id)}
              />
              <div className="bid-section-item-body">
                <strong>{section.label}：{section.title}</strong>
                {section.description && <p>{section.description}</p>}
                {section.budget && <span className="bid-section-budget">预算：¥{section.budget}</span>}
              </div>
            </label>
          ))}
        </div>

        <div className="bid-section-actions">
          <button type="button" className="secondary-action" onClick={onSkip}>
            跳过（按单标段处理）
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            确认选择（{selected.size} 个标段）
          </button>
        </div>
      </section>
    </div>
  );
}

export default BidSectionSelector;
