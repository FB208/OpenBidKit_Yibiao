import * as Dialog from '@radix-ui/react-dialog';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AppSwitch, useAutoAnswer } from '../../../shared/ui';
import type { BusinessFillReview, BusinessFillReviewImage, BusinessFillReviewUnit, BusinessFillReviewValue } from '../types';

interface BusinessFillReviewDialogProps {
  open: boolean;
  review: BusinessFillReview | null;
  autoAnswerAt?: string;
  saving?: boolean;
  onDismiss: () => void;
  onInteraction: () => void;
  onConfirm: (values: BusinessFillReviewValue[]) => void;
}

interface UnitDraft {
  value: string;
  selected: string[];
  imageId: string;
}

function createDraft(unit: BusinessFillReviewUnit): UnitDraft {
  return { value: unit.value || '', selected: unit.selected || [], imageId: unit.image_id || '' };
}

function isFilled(unit: BusinessFillReviewUnit, draft: UnitDraft) {
  if (unit.kind === 'attachment') return Boolean(draft.imageId);
  if (unit.kind === 'choice') return draft.selected.length > 0;
  return Boolean(draft.value.trim());
}

// 展示副 Agent 填写的商务模版字段值，确认前允许修改文字、勾选项和附件图片。
function BusinessFillReviewDialog({
  open,
  review,
  autoAnswerAt,
  saving,
  onDismiss,
  onInteraction,
  onConfirm,
}: BusinessFillReviewDialogProps) {
  const [drafts, setDrafts] = useState<Record<string, UnitDraft>>({});
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const interactionReportedRef = useRef(false);
  const { enabled: autoAnswerEnabled, saving: autoAnswerSaving, setEnabled: setAutoAnswerEnabled } = useAutoAnswer();
  const units = review?.units || [];

  useEffect(() => {
    if (!open || !review) return;
    setDrafts(Object.fromEntries(review.units.map((unit) => [unit.key, createDraft(unit)])));
    interactionReportedRef.current = false;
  }, [open, review]);

  useEffect(() => {
    if (!autoAnswerAt) {
      setCountdownSeconds(0);
      return;
    }
    const deadline = new Date(autoAnswerAt).getTime();
    const updateCountdown = () => {
      setCountdownSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [autoAnswerAt]);

  // 图片按所属记录分组，表格序号按出现顺序编号。
  const imageGroups = useMemo(() => {
    const groups = new Map<string, BusinessFillReviewImage[]>();
    for (const image of review?.images || []) {
      groups.set(image.group, [...(groups.get(image.group) || []), image]);
    }
    return [...groups.entries()];
  }, [review]);
  const imagesById = useMemo(() => new Map((review?.images || []).map((image) => [image.image_id, image])), [review]);
  const tableNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    for (const unit of units) {
      if (unit.table_id && !numbers.has(unit.table_id)) numbers.set(unit.table_id, numbers.size + 1);
    }
    return numbers;
  }, [units]);

  const filledCount = units.filter((unit) => drafts[unit.key] && isFilled(unit, drafts[unit.key])).length;

  // 首次修改字段值时通知 Main 停止本次自动确认。
  const reportInteraction = () => {
    if (interactionReportedRef.current) return;
    interactionReportedRef.current = true;
    onInteraction();
  };

  const updateDraft = (key: string, patch: Partial<UnitDraft>) => {
    reportInteraction();
    setDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const toggleOption = (unit: BusinessFillReviewUnit, option: string) => {
    const selected = drafts[unit.key]?.selected || [];
    updateDraft(unit.key, { selected: selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option] });
  };

  const buildValues = (): BusinessFillReviewValue[] => units.flatMap<BusinessFillReviewValue>((unit) => {
    const draft = drafts[unit.key];
    if (!draft || !isFilled(unit, draft)) return [];
    if (unit.kind === 'attachment') return [{ key: unit.key, image_id: draft.imageId }];
    if (unit.kind === 'choice') return [{ key: unit.key, selected: draft.selected }];
    return [{ key: unit.key, value: draft.value }];
  });

  const renderEditor = (unit: BusinessFillReviewUnit) => {
    const draft = drafts[unit.key] || createDraft(unit);
    if (unit.kind === 'choice') {
      return (
        <div className="business-fill-options">
          {(unit.options || []).map((option) => (
            <label key={option}>
              <input type="checkbox" checked={draft.selected.includes(option)} onChange={() => toggleOption(unit, option)} disabled={saving} />
              <span>{option}</span>
            </label>
          ))}
        </div>
      );
    }
    if (unit.kind === 'attachment') {
      const image = imagesById.get(draft.imageId);
      return (
        <div className="business-fill-attachment">
          <select
            value={draft.imageId}
            aria-label={`${unit.name}的图片`}
            onChange={(event) => updateDraft(unit.key, { imageId: event.target.value })}
            disabled={saving}
          >
            <option value="">不选择</option>
            {imageGroups.map(([group, images]) => (
              <optgroup key={group} label={group}>
                {images.map((item) => <option key={item.image_id} value={item.image_id}>{item.label} · {item.name}</option>)}
              </optgroup>
            ))}
          </select>
          {image && <img src={image.asset_url} alt={image.name} />}
        </div>
      );
    }
    return (
      <textarea
        value={draft.value}
        rows={Math.min(4, Math.max(1, draft.value.split('\n').length))}
        aria-label={unit.name}
        onChange={(event) => updateDraft(unit.key, { value: event.target.value })}
        disabled={saving}
      />
    );
  };

  const describeNote = (unit: BusinessFillReviewUnit) => {
    const draft = drafts[unit.key];
    if (draft && isFilled(unit, draft)) return '';
    if (unit.blank) return '未使用，留空';
    if (unit.unresolved_reason) return unit.unresolved_reason;
    return unit.fill_by === 'manual' ? '保留人工处理占位' : '';
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
        <Dialog.Content className="outline-selection-dialog business-fill-review-dialog">
          <header className="outline-selection-head">
            <div>
              <Dialog.Title>确认商务模版字段值</Dialog.Title>
              <Dialog.Description>核对副 Agent 填写的内容，可修改文字、勾选项和附件图片；确认后回填商务模版 Word。</Dialog.Description>
            </div>
            <span aria-live="polite">已填 {filledCount} / {units.length}</span>
          </header>

          <p className="business-fill-review-hint">清空的字段会在 Word 中保留占位；附件从资信库图片中选择，每个位置一张。</p>

          <div className="outline-selection-table">
            <div className="business-fill-row is-header" aria-hidden="true">
              <span>字段名称</span>
              <span>值</span>
              <span>说明</span>
            </div>
            <div className="outline-selection-list">
              {!review && <div className="business-fill-review-empty">正在读取字段值...</div>}
              {units.map((unit, index) => {
                const startsTable = Boolean(unit.table_id) && units[index - 1]?.table_id !== unit.table_id;
                return (
                  <Fragment key={unit.key}>
                    {startsTable && (
                      <div className="business-fill-table-title">
                        清单表 {tableNumbers.get(unit.table_id!)}{unit.section ? ` · ${unit.section}` : ''}
                      </div>
                    )}
                    <div className="business-fill-row">
                      <div className="business-fill-name">
                        <strong title={unit.instruction || unit.name}>{unit.table_id ? `第${unit.row}行 · ${unit.name}` : unit.name}</strong>
                        {!unit.table_id && unit.section && <span>{unit.section}</span>}
                      </div>
                      {renderEditor(unit)}
                      <small>{describeNote(unit)}</small>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>

          <footer className="outline-selection-actions">
            <div className="outline-selection-summary">
              <span>{units.length - filledCount ? `${units.length - filledCount} 项未填写，将保留占位` : '全部字段已填写'}</span>
              <div className="outline-selection-auto-answer">
                <label>
                  <AppSwitch checked={autoAnswerEnabled} disabled={autoAnswerSaving || saving} onCheckedChange={(checked) => void setAutoAnswerEnabled(checked)} />
                  <span>自动确认</span>
                </label>
                {autoAnswerAt && (
                  <small>{countdownSeconds} 秒后自动采用副 Agent 的填写结果</small>
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
                onClick={() => onConfirm(buildValues())}
                disabled={saving || !review}
              >
                {saving ? '正在保存...' : '确认填写'}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BusinessFillReviewDialog;
