import * as Dialog from '@radix-ui/react-dialog';
import { InfoCircledIcon } from '@radix-ui/react-icons';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { AppSwitch, useAutoAnswer } from '../../../shared/ui';
import type { BusinessFillReview, BusinessFillReviewImage, BusinessFillReviewUnit, BusinessFillReviewValue } from '../types';
import BusinessFillDocument, { collectFieldIds, createDraft, describeUnitState, isFilled, isPending, type UnitDraft } from './BusinessFillDocument';

interface BusinessFillReviewDialogProps {
  open: boolean;
  // confirm：正文任务等待确认；edit：填写完成后编辑并重新回填 Word。
  mode: 'confirm' | 'edit';
  review: BusinessFillReview | null;
  autoAnswerAt?: string;
  saving?: boolean;
  onDismiss: () => void;
  onInteraction?: () => void;
  onConfirm: (values: BusinessFillReviewValue[]) => void;
}

// 按模版版式展示副 Agent 填写的商务模版字段值，确认前或填写完成后在原表格、原段落位置修改文字、勾选项和附件图片。
function BusinessFillReviewDialog({
  open,
  mode,
  review,
  autoAnswerAt,
  saving,
  onDismiss,
  onInteraction,
  onConfirm,
}: BusinessFillReviewDialogProps) {
  const [drafts, setDrafts] = useState<Record<string, UnitDraft>>({});
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const [activeChapter, setActiveChapter] = useState(0);
  const interactionReportedRef = useRef(false);
  const paperRef = useRef<HTMLDivElement>(null);
  const lastFocusedKeyRef = useRef('');
  const { enabled: autoAnswerEnabled, saving: autoAnswerSaving, setEnabled: setAutoAnswerEnabled } = useAutoAnswer();
  const units = useMemo(() => review?.units || [], [review]);
  const chapters = useMemo(() => review?.chapters || [], [review]);
  const editing = mode === 'edit';

  useEffect(() => {
    if (!open || !review) return;
    setDrafts(Object.fromEntries(review.units.map((unit) => [unit.key, createDraft(unit)])));
    setActiveChapter(0);
    interactionReportedRef.current = false;
    lastFocusedKeyRef.current = '';
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

  // 图片按所属记录分组。
  const imageGroups = useMemo(() => {
    const groups = new Map<string, BusinessFillReviewImage[]>();
    for (const image of review?.images || []) {
      groups.set(image.group, [...(groups.get(image.group) || []), image]);
    }
    return [...groups.entries()];
  }, [review]);
  const imagesById = useMemo(() => new Map((review?.images || []).map((image) => [image.image_id, image])), [review]);
  const unitsByFieldId = useMemo(
    () => new Map(units.flatMap((unit) => unit.field_ids.map((fieldId) => [fieldId, unit] as const))),
    [units],
  );

  // 各章出现的填写项、填写项在版式中的出现次数与文档顺序，以及首次出现的章节。
  const layoutIndex = useMemo(() => {
    const occurrences = new Map<string, number>();
    const firstChapter = new Map<string, number>();
    const chapterUnits = chapters.map((chapter, chapterIndex) => {
      const chapterKeys = new Map<string, BusinessFillReviewUnit>();
      for (const fieldId of collectFieldIds(chapter.blocks)) {
        const unit = unitsByFieldId.get(fieldId);
        if (!unit) continue;
        occurrences.set(unit.key, (occurrences.get(unit.key) || 0) + 1);
        if (!firstChapter.has(unit.key)) firstChapter.set(unit.key, chapterIndex);
        chapterKeys.set(unit.key, unit);
      }
      return [...chapterKeys.values()];
    });
    const orderedUnits = chapterUnits.flat().filter((unit, index, list) => list.findIndex((item) => item.key === unit.key) === index);
    return { occurrences, firstChapter, chapterUnits, orderedUnits };
  }, [chapters, unitsByFieldId]);

  const draftOf = (unit: BusinessFillReviewUnit) => drafts[unit.key] || createDraft(unit);
  const pendingUnits = layoutIndex.orderedUnits.filter((unit) => isPending(unit, draftOf(unit)));
  // 签章位置不计入；未使用的空行只有填写后才计入。
  const countedUnits = units.filter((unit) => !unit.signature && (!unit.blank || isFilled(unit, draftOf(unit))));
  const filledCount = countedUnits.filter((unit) => isFilled(unit, draftOf(unit))).length;

  // 首次修改字段值时通知 Main 停止本次自动确认。
  const reportInteraction = () => {
    if (interactionReportedRef.current) return;
    interactionReportedRef.current = true;
    onInteraction?.();
  };

  const updateDraft = (key: string, patch: Partial<UnitDraft>) => {
    reportInteraction();
    setDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const buildValues = (): BusinessFillReviewValue[] => units.flatMap<BusinessFillReviewValue>((unit) => {
    const draft = drafts[unit.key];
    if (!draft || unit.signature || !isFilled(unit, draft)) return [];
    if (unit.kind === 'attachment') return [{ key: unit.key, image_id: draft.imageId }];
    if (unit.kind === 'choice') return [{ key: unit.key, selected: draft.selected }];
    return [{ key: unit.key, value: draft.value }];
  });

  // 跳到填写项在版式中的第一处位置并聚焦，短暂高亮便于识别；填写项 key 含分隔符，DOM 中以首个字段 ID 标识。
  const locateUnit = (unit: BusinessFillReviewUnit) => {
    const target = paperRef.current?.querySelector<HTMLElement>(`[data-unit-field="${CSS.escape(unit.field_ids[0])}"]`);
    if (!target) return;
    lastFocusedKeyRef.current = unit.key;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (target.querySelector<HTMLElement>('textarea, input, button') || target).focus({ preventScroll: true });
    target.classList.add('is-located');
    window.setTimeout(() => target.classList.remove('is-located'), 1400);
  };

  // 从最近聚焦的填写项往后找下一个待处理项，到末尾后回到开头。
  const locateNextPending = () => {
    if (!pendingUnits.length) return;
    const currentIndex = layoutIndex.orderedUnits.findIndex((unit) => unit.key === lastFocusedKeyRef.current);
    const next = pendingUnits.find((unit) => layoutIndex.orderedUnits.indexOf(unit) > currentIndex) || pendingUnits[0];
    locateUnit(next);
  };

  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    const fieldId = (event.target as HTMLElement).closest<HTMLElement>('[data-unit-field]')?.dataset.unitField;
    const unit = fieldId ? unitsByFieldId.get(fieldId) : undefined;
    if (unit) lastFocusedKeyRef.current = unit.key;
  };

  const scrollToChapter = (index: number) => {
    paperRef.current?.querySelector(`[data-chapter-index="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // 以纸面顶部为准高亮当前所在章节。
  const trackChapter = () => {
    const container = paperRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top + 32;
    let current = 0;
    container.querySelectorAll<HTMLElement>('[data-chapter-index]').forEach((section, index) => {
      if (section.getBoundingClientRect().top <= top) current = index;
    });
    setActiveChapter(current);
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
        <Dialog.Content className="outline-selection-dialog business-fill-review-dialog" aria-describedby={undefined}>
          <header className="outline-selection-head">
            <Dialog.Title>{editing ? '编辑商务模版字段值' : '确认商务模版字段值'}</Dialog.Title>
            <span aria-live="polite">已填 {filledCount} / {countedUnits.length}</span>
          </header>

          <p className="business-fill-review-notice">
            <InfoCircledIcon aria-hidden="true" />
            <span>本页面格式错位并不代表导出后也错位，请放心填写</span>
          </p>

          <div className="business-fill-review-body">
            <nav className="business-fill-nav" aria-label="商务模版章节">
              {chapters.map((chapter, index) => {
                const chapterUnits = layoutIndex.chapterUnits[index].filter((unit) => !unit.signature);
                const filled = chapterUnits.filter((unit) => isFilled(unit, draftOf(unit))).length;
                const pending = chapterUnits.filter((unit) => isPending(unit, draftOf(unit))).length;
                return (
                  <button
                    key={chapter.id || index}
                    type="button"
                    className={index === activeChapter ? 'is-active' : undefined}
                    onClick={() => scrollToChapter(index)}
                  >
                    <strong>{chapter.title}</strong>
                    <span>{chapterUnits.length ? `已填 ${filled} · 待处理 ${pending}` : '无需填写'}</span>
                    {!chapter.auto_fill && <em>人工填写</em>}
                  </button>
                );
              })}
            </nav>
            <div className="business-fill-paper" ref={paperRef} onScroll={trackChapter} onFocus={trackFocus}>
              {review ? (
                <BusinessFillDocument
                  chapters={chapters}
                  baseSize={review.base_size}
                  unitsByFieldId={unitsByFieldId}
                  occurrences={layoutIndex.occurrences}
                  drafts={drafts}
                  imageGroups={imageGroups}
                  imagesById={imagesById}
                  saving={saving}
                  onDraftChange={updateDraft}
                />
              ) : (
                <div className="business-fill-review-empty">正在读取商务模版...</div>
              )}
            </div>
          </div>

          <footer className="outline-selection-actions">
            <div className="outline-selection-summary">
              {!editing && (
                <div className="outline-selection-auto-answer">
                  <label>
                    <AppSwitch checked={autoAnswerEnabled} disabled={autoAnswerSaving || saving} onCheckedChange={(checked) => void setAutoAnswerEnabled(checked)} />
                    <span>自动确认</span>
                  </label>
                  {autoAnswerAt && (
                    <small>{countdownSeconds} 秒后自动采用副 Agent 的填写结果</small>
                  )}
                </div>
              )}
            </div>
            <div className="outline-selection-buttons">
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button type="button" className="secondary-action business-fill-pending-trigger" disabled={!pendingUnits.length}>
                    {pendingUnits.length ? `待处理 ${pendingUnits.length}` : '无待处理'}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="business-fill-pending-popover"
                    side="top"
                    align="end"
                    sideOffset={8}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <ul>
                      {pendingUnits.map((unit) => (
                        <li key={unit.key}>
                          <Popover.Close asChild>
                            <button type="button" onClick={() => locateUnit(unit)}>
                              <strong>{unit.name}</strong>
                              <span>{chapters[layoutIndex.firstChapter.get(unit.key) ?? 0]?.title}</span>
                              <small>{describeUnitState(unit, draftOf(unit))}</small>
                            </button>
                          </Popover.Close>
                        </li>
                      ))}
                    </ul>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              <button type="button" className="secondary-action" onClick={locateNextPending} disabled={!pendingUnits.length}>
                下一个待处理
              </button>
              <button type="button" className="secondary-action" onClick={() => {
                reportInteraction();
                onDismiss();
              }} disabled={saving}>{editing ? '取消' : '稍后处理'}</button>
              <button
                type="button"
                className="primary-action"
                onClick={() => onConfirm(buildValues())}
                disabled={saving || !review}
              >
                {saving ? '正在保存...' : editing ? '保存并回填' : '确认填写'}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BusinessFillReviewDialog;
