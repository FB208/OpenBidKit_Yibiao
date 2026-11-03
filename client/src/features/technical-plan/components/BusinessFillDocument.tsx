import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { CSSProperties, ReactNode } from 'react';
import type {
  BusinessFillLayoutBlock,
  BusinessFillLayoutCell,
  BusinessFillLayoutSegment,
  BusinessFillReviewChapter,
  BusinessFillReviewImage,
  BusinessFillReviewUnit,
} from '../types';

export interface UnitDraft {
  value: string;
  selected: string[];
  imageId: string;
}

export function createDraft(unit: BusinessFillReviewUnit): UnitDraft {
  return { value: unit.value || '', selected: unit.selected || [], imageId: unit.image_id || '' };
}

export function isFilled(unit: BusinessFillReviewUnit, draft: UnitDraft) {
  if (unit.kind === 'attachment') return Boolean(draft.imageId);
  if (unit.kind === 'choice' || unit.kind === 'select') return draft.selected.length > 0;
  return Boolean(draft.value.trim());
}

/**
 * 逐行清单表和可重复条目按行（条）决定待处理：有任一格已填的行，空格待处理；一行都没填时只有第一行待处理，其余行为未使用的空行，导出时删除或留空。
 * 签章格子不算已填。与 Main 的 businessTemplateFillTask.cjs findIdleListUnits 同一规则，改动时同步。
 */
export function findIdleListUnitKeys(units: BusinessFillReviewUnit[], isUnitFilled: (unit: BusinessFillReviewUnit) => boolean) {
  const tables = new Map<string, BusinessFillReviewUnit[]>();
  for (const unit of units) {
    if (!unit.table_id || unit.row === undefined) continue;
    tables.set(unit.table_id, [...(tables.get(unit.table_id) || []), unit]);
  }
  const idle = new Set<string>();
  for (const tableUnits of tables.values()) {
    const used = new Set(tableUnits.filter(isUnitFilled).map((unit) => unit.row));
    const kept = used.size ? used : new Set([Math.min(...tableUnits.map((unit) => unit.row as number))]);
    for (const unit of tableUnits) {
      if (!kept.has(unit.row)) idle.add(unit.key);
    }
  }
  return idle;
}

/** 待处理：未填写、不是未使用的空行，也不是线下签章位置；与导出时带“待填写”标记的格子一致。 */
export function isPending(unit: BusinessFillReviewUnit, draft: UnitDraft, idle: boolean) {
  return !isFilled(unit, draft) && !idle && !unit.signature;
}

/** 填写项当前状态的说明，已填写时为空（值含页码引用时说明导出时换成页码）。 */
export function describeUnitState(unit: BusinessFillReviewUnit, draft: UnitDraft, idle: boolean) {
  if (unit.signature) return '线下签字盖章';
  if (unit.link?.form === 'same') return `随“${unit.link.source_name}”自动填写`;
  if (unit.link) return `按“${unit.link.source_name}”自动换算大写，${unit.link.source_name}须填写金额数字`;
  if (isFilled(unit, draft)) return /\{\{\s*页码/.test(draft.value) ? '导出时把 {{页码:编号}} 换成该小节的实际页码' : '';
  if (idle) return unit.entry ? '未使用的条目，输入内容即启用' : '未使用的空行，输入内容即启用';
  if (unit.unresolved_reason) return unit.unresolved_reason;
  return unit.fill_by === 'manual' ? '待人工填写' : '待填写';
}

/** 按文档顺序列出版式中的字段 ID；块级字段的内部段落只用于原样展示，不另计字段。 */
export function collectFieldIds(blocks: BusinessFillLayoutBlock[], output: string[] = []) {
  for (const block of blocks) {
    if (block.type === 'field' && block.field_id) output.push(block.field_id);
    for (const segment of block.segments || []) {
      if (segment.field_id) output.push(segment.field_id);
    }
    for (const row of block.rows || []) {
      for (const cell of row.cells) collectFieldIds(cell.blocks, output);
    }
  }
  return output;
}

/** 资信库图片选择弹层内容，按所属记录分组；clearLabel 存在时提供“不选择”。附件字段和证明材料共用。 */
export function BusinessImagePickerContent({ imageGroups, selectedId, clearLabel, onSelect }: {
  imageGroups: Array<[string, BusinessFillReviewImage[]]>;
  selectedId?: string;
  clearLabel?: string;
  onSelect: (imageId: string) => void;
}) {
  return (
    <Popover.Content className="business-fill-image-popover" side="bottom" align="start" sideOffset={6}>
      {clearLabel && (
        <Popover.Close asChild>
          <button type="button" className="secondary-action" onClick={() => onSelect('')}>{clearLabel}</button>
        </Popover.Close>
      )}
      {imageGroups.map(([group, images]) => (
        <section key={group}>
          <strong>{group}</strong>
          <div>
            {images.map((item) => (
              <Popover.Close asChild key={item.image_id}>
                <button
                  type="button"
                  className={item.image_id === selectedId ? 'is-selected' : undefined}
                  onClick={() => onSelect(item.image_id)}
                >
                  <img src={item.asset_url} alt={item.name} />
                  <span>{item.label} · {item.name}</span>
                </button>
              </Popover.Close>
            ))}
          </div>
        </section>
      ))}
    </Popover.Content>
  );
}

type FieldVariant = 'inline' | 'cell' | 'block';

interface BusinessFillDocumentProps {
  chapters: BusinessFillReviewChapter[];
  baseSize: number;
  unitsByFieldId: Map<string, BusinessFillReviewUnit>;
  occurrences: Map<string, number>;
  drafts: Record<string, UnitDraft>;
  /** 逐行清单表中未使用、导出时留空的填写项。 */
  idleKeys: Set<string>;
  imageGroups: Array<[string, BusinessFillReviewImage[]]>;
  imagesById: Map<string, BusinessFillReviewImage>;
  /** 规则和页码编制的字段，只读显示。 */
  ruleFieldIds?: Set<string>;
  saving?: boolean;
  onDraftChange: (key: string, patch: Partial<UnitDraft>) => void;
}

function isEmptyParagraph(block: BusinessFillLayoutBlock) {
  return block.type === 'paragraph' && !block.segments?.length && !block.label;
}

// 单元格里只有一个字段时，编辑框铺满单元格。
function soleCellField(cell: BusinessFillLayoutCell) {
  const blocks = cell.blocks.filter((block) => !isEmptyParagraph(block));
  if (blocks.length !== 1) return '';
  const [block] = blocks;
  if (block.type === 'field') return block.field_id || '';
  return block.type === 'paragraph' && block.segments?.length === 1 && !block.label ? block.segments[0].field_id || '' : '';
}

// 按模版版式还原商务模版：段落和表格照原样排列，字段位置换成可编辑控件，同名字段共用一份草稿。
function BusinessFillDocument({
  chapters,
  baseSize,
  unitsByFieldId,
  occurrences,
  drafts,
  idleKeys,
  imageGroups,
  imagesById,
  ruleFieldIds,
  saving,
  onDraftChange,
}: BusinessFillDocumentProps) {
  const paragraphStyle = (block: BusinessFillLayoutBlock): CSSProperties | undefined => {
    const style: CSSProperties = {};
    if (block.align) style.textAlign = block.align;
    if (block.indent?.first_line) style.textIndent = `${block.indent.first_line}em`;
    if (block.indent?.left) style.marginLeft = `${Math.max(0, block.indent.left)}em`;
    if (block.size) style.fontSize = `${Math.min(2, Math.max(0.75, block.size / baseSize))}em`;
    return Object.keys(style).length ? style : undefined;
  };

  // 择一只保留一项，再点已选项取消选择。
  const toggleOption = (unit: BusinessFillReviewUnit, draft: UnitDraft, option: string) => {
    const checked = draft.selected.includes(option);
    onDraftChange(unit.key, {
      selected: unit.kind === 'select'
        ? (checked ? [] : [option])
        : (checked ? draft.selected.filter((item) => item !== option) : [...draft.selected, option]),
    });
  };

  const renderEditor = (unit: BusinessFillReviewUnit, draft: UnitDraft) => {
    if (unit.signature) return <span className="business-fill-signature">线下签章</span>;
    if (unit.kind === 'choice' || unit.kind === 'select') {
      return (
        <span className="business-fill-options">
          {(unit.options || []).map((option) => (
            <label key={option}>
              <input
                type={unit.kind === 'select' ? 'radio' : 'checkbox'}
                name={unit.kind === 'select' ? unit.key : undefined}
                checked={draft.selected.includes(option)}
                onClick={unit.kind === 'select' ? () => toggleOption(unit, draft, option) : undefined}
                onChange={unit.kind === 'select' ? () => undefined : () => toggleOption(unit, draft, option)}
                disabled={saving}
              />
              <span>{option}</span>
            </label>
          ))}
        </span>
      );
    }
    if (unit.kind === 'attachment') {
      const image = imagesById.get(draft.imageId);
      return (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="business-fill-attachment" disabled={saving} aria-label={`${unit.name}的图片`}>
              {image ? <img src={image.asset_url} alt={image.name} /> : null}
              <span>{image ? `${image.label} · ${image.name}` : `选择图片：${unit.name}`}</span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <BusinessImagePickerContent
              imageGroups={imageGroups}
              selectedId={draft.imageId}
              clearLabel="不选择"
              onSelect={(imageId) => onDraftChange(unit.key, { imageId })}
            />
          </Popover.Portal>
        </Popover.Root>
      );
    }
    return (
      <textarea
        value={draft.value}
        rows={1}
        placeholder={unit.name}
        aria-label={unit.name}
        onChange={(event) => onDraftChange(unit.key, { value: event.target.value })}
        readOnly={Boolean(unit.link)}
        disabled={saving}
      />
    );
  };

  const renderField = (fieldId: string, variant: FieldVariant, key?: number) => {
    const unit = unitsByFieldId.get(fieldId);
    if (!unit) return ruleFieldIds?.has(fieldId) ? <span key={key} className="business-fill-signature">规则和页码编制</span> : null;
    const draft = drafts[unit.key] || createDraft(unit);
    const filled = isFilled(unit, draft);
    const idle = idleKeys.has(unit.key);
    const state = unit.signature ? 'is-signature'
      : filled ? 'is-filled'
        : idle ? 'is-blank'
          : unit.fill_by === 'manual' ? 'is-manual' : 'is-unresolved';
    const note = describeUnitState(unit, draft, idle);
    const count = occurrences.get(unit.key) || 0;
    return (
      <Tooltip.Root key={key}>
        <Tooltip.Trigger asChild>
          <span className={`business-fill-field is-${variant} ${state}`} data-unit-field={unit.field_ids[0]}>
            {renderEditor(unit, draft)}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content business-fill-tooltip" side="top" align="start" sideOffset={6}>
            <strong>{unit.name}</strong>
            {unit.subject && <span>对象：{unit.subject}</span>}
            {unit.instruction && <span>{unit.instruction}</span>}
            {note && <span>{note}</span>}
            {count > 1 && <span>共 {count} 处，修改任意一处会同步其他位置</span>}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    );
  };

  const renderSegments = (segments: BusinessFillLayoutSegment[]) => segments.map((segment, index) => {
    if (segment.field_id) return renderField(segment.field_id, 'inline', index);
    if (segment.break) return <br key={index} />;
    if (segment.tab) return <span key={index} className="business-fill-tab" />;
    const className = [segment.bold && 'is-bold', segment.underline && 'is-underline'].filter(Boolean).join(' ');
    return <span key={index} className={className || undefined}>{segment.text}</span>;
  });

  const renderTable = (block: BusinessFillLayoutBlock, key: number) => {
    const columns = block.columns || [];
    return (
      <div key={key} className="business-fill-table-wrap">
        <table className={block.borders ? 'has-borders' : undefined} style={{ minWidth: `${Math.max(1, columns.length) * 4.5}em` }}>
          <colgroup>
            {columns.map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}
          </colgroup>
          <tbody>
            {(block.rows || []).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.cells.map((cell, cellIndex) => {
                  const fieldId = soleCellField(cell);
                  return (
                    <td
                      key={cellIndex}
                      colSpan={cell.col_span}
                      rowSpan={cell.row_span}
                      className={cell.borders === false ? 'no-borders' : undefined}
                    >
                      {fieldId ? renderField(fieldId, 'cell') : renderBlocks(cell.blocks, true)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // 连续空段只保留一个，单元格内的空段不占位。
  function renderBlocks(blocks: BusinessFillLayoutBlock[], inCell = false): ReactNode[] {
    const nodes: ReactNode[] = [];
    let previousEmpty = false;
    blocks.forEach((block, index) => {
      if (block.type === 'table') {
        nodes.push(renderTable(block, index));
        previousEmpty = false;
        return;
      }
      if (block.type === 'field') {
        nodes.push(<div key={index} className="business-fill-block-field">{block.field_id ? renderField(block.field_id, 'block') : null}</div>);
        previousEmpty = false;
        return;
      }
      const empty = isEmptyParagraph(block);
      if (empty && (previousEmpty || inCell)) return;
      previousEmpty = empty;
      nodes.push(
        <p key={index} className={empty ? 'is-empty' : undefined} style={paragraphStyle(block)}>
          {block.label && <span className="business-fill-label">{block.label}</span>}
          {renderSegments(block.segments || [])}
        </p>,
      );
    });
    return nodes;
  }

  return (
    <div className="business-fill-pages">
      {chapters.map((chapter, index) => (
        <section key={chapter.id || index} className="business-fill-page" data-chapter-index={index} aria-label={chapter.title}>
          {renderBlocks(chapter.blocks)}
        </section>
      ))}
    </div>
  );
}

export default BusinessFillDocument;
