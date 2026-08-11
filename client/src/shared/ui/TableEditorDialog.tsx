import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import {
  detectTable,
  gridToMarkdown,
  htmlTableToGrid,
  markdownTableToGrid,
  replaceFirstTable,
  type GridCell,
  type GridModel,
} from '../markdown/tableConverter';

interface TableEditorDialogProps {
  open: boolean;
  value: string;
  onCancel: () => void;
  onConfirm: (nextValue: string) => void;
}

function createEmptyGrid(rows = 3, cols = 3): GridModel {
  return {
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ text: '' }) as GridCell),
    ),
  };
}

function cloneGrid(grid: GridModel): GridModel {
  return { rows: grid.rows.map((row) => row.map((cell) => ({ ...cell }))) };
}

export default function TableEditorDialog({ open, value, onCancel, onConfirm }: TableEditorDialogProps) {
  const [grid, setGrid] = useState<GridModel>(() => createEmptyGrid());
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState('');
  const initialValueRef = useRef(value);

  useEffect(() => {
    if (!open) return;
    initialValueRef.current = value;
    const detected = detectTable(value);
    setGrid(detected ? detected.grid : createEmptyGrid());
    setSelected(null);
    setPasteOpen(false);
    setPasteText('');
    setPasteError('');
  }, [open, value]);

  const colCount = grid.rows[0]?.length ?? 0;

  const updateCell = (r: number, c: number, text: string) => {
    setGrid((prev) => {
      const next = cloneGrid(prev);
      next.rows[r][c] = { text };
      return next;
    });
    setSelected({ r, c });
  };

  const addRowAtBottom = () => {
    setGrid((prev) => ({ rows: [...prev.rows, Array.from({ length: colCount }, () => ({ text: '' }) as GridCell)] }));
  };

  const addColAtRight = () => {
    setGrid((prev) => ({ rows: prev.rows.map((row) => [...row, { text: '' }]) }));
  };

  const deleteRow = (r: number) => {
    if (grid.rows.length <= 1) return;
    setGrid((prev) => ({ rows: prev.rows.filter((_, i) => i !== r) }));
    setSelected(null);
  };

  const deleteCol = (c: number) => {
    if (colCount <= 1) return;
    setGrid((prev) => ({ rows: prev.rows.map((row) => row.filter((_, i) => i !== c)) }));
    setSelected(null);
  };

  const insertRowBelow = (r: number) => {
    setGrid((prev) => {
      const rows = prev.rows.slice();
      rows.splice(r + 1, 0, Array.from({ length: colCount }, () => ({ text: '' }) as GridCell));
      return { rows };
    });
  };

  const insertColRight = (c: number) => {
    setGrid((prev) => ({
      rows: prev.rows.map((row) => {
        const nextRow = row.slice();
        nextRow.splice(c + 1, 0, { text: '' });
        return nextRow;
      }),
    }));
  };

  const handlePasteParse = () => {
    const text = pasteText.trim();
    if (!text) {
      setPasteError('请先粘贴表格内容');
      return;
    }
    let parsed: GridModel | null = null;
    if (/<table/i.test(text)) {
      parsed = htmlTableToGrid(text);
    }
    if (!parsed) parsed = markdownTableToGrid(text);
    if (parsed) {
      setGrid(parsed);
      setSelected(null);
      setPasteOpen(false);
      setPasteText('');
      setPasteError('');
    } else {
      setPasteError('未能识别为表格，请粘贴 Word/网页 表格或 Markdown 管道表');
    }
  };

  const handleConfirm = () => {
    const next = replaceFirstTable(initialValueRef.current, gridToMarkdown(grid));
    onConfirm(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="table-editor-overlay" />
        <Dialog.Content className="table-editor-dialog" aria-describedby={undefined}>
          <div className="table-editor-head">
            <div>
              <span>可视化表格编辑</span>
              <Dialog.Title>可视化表格编辑</Dialog.Title>
              <Dialog.Description>
                在网格中修改单元格，确认后自动转换为标准 Markdown 表格（合并单元格会展开为独立格子）。
              </Dialog.Description>
            </div>
            <button type="button" className="secondary-action" onClick={onCancel}>取消</button>
          </div>

          <div className="table-editor-toolbar">
            <button type="button" onClick={addRowAtBottom}>添加行（末尾）</button>
            <button type="button" onClick={addColAtRight}>添加列（末尾）</button>
            <button type="button" disabled={!selected} onClick={() => selected && insertRowBelow(selected.r)}>在下方插入行</button>
            <button type="button" disabled={!selected} onClick={() => selected && insertColRight(selected.c)}>在右侧插入列</button>
            <button type="button" className="is-danger" disabled={!selected || grid.rows.length <= 1} onClick={() => selected && deleteRow(selected.r)}>删除选中行</button>
            <button type="button" className="is-danger" disabled={!selected || colCount <= 1} onClick={() => selected && deleteCol(selected.c)}>删除选中列</button>
            <span className="table-editor-toolbar-spacer" />
            <button type="button" onClick={() => { setPasteOpen((v) => !v); setPasteError(''); }}>从 Word/网页粘贴</button>
          </div>

          {pasteOpen && (
            <div className="table-editor-paste">
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder="粘贴从 Word / 网页复制的表格，或 Markdown 管道表"
                rows={4}
              />
              <div className="table-editor-paste-actions">
                <button type="button" className="primary-action" onClick={handlePasteParse}>解析粘贴的表格</button>
                {pasteError && <span className="table-editor-paste-error">{pasteError}</span>}
              </div>
            </div>
          )}

          <div className="table-editor-grid-wrap">
            <table className="table-editor-grid">
              <tbody>
                {grid.rows.map((row, r) => (
                  <tr key={r} className={r === 0 ? 'is-header' : ''}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={selected?.r === r && selected?.c === c ? 'is-selected' : ''}
                        onClick={() => setSelected({ r, c })}
                      >
                        <input
                          type="text"
                          value={cell.text}
                          placeholder={r === 0 ? '表头' : ''}
                          onChange={(event) => updateCell(r, c, event.target.value)}
                          onFocus={() => setSelected({ r, c })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-editor-actions">
            <button type="button" className="secondary-action" onClick={onCancel}>取消</button>
            <button type="button" className="primary-action" onClick={handleConfirm}>确认并转换为 Markdown</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
