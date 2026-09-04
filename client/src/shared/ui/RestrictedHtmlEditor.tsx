import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import {
  parseRestrictedHtml,
  serializeRestrictedHtmlEditor,
  type RestrictedHtmlParseResult,
} from '../bodyHtml/restrictedHtml';

export interface RestrictedHtmlEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

function insertPlainText(text: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (index > 0) fragment.append(document.createElement('br'));
    fragment.append(document.createTextNode(line));
  });
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/** 可视化编辑受限 HTML，并在每次有效修改后回写规范格式。 */
function RestrictedHtmlEditor({
  value,
  onChange,
  className,
  disabled = false,
  placeholder = '点击此处编辑正文...',
}: RestrictedHtmlEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [draftResult, setDraftResult] = useState<RestrictedHtmlParseResult | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editTabId = useId();
  const previewTabId = useId();
  const editPanelId = useId();
  const previewPanelId = useId();
  const deferredValue = useDeferredValue(value);
  const valueResult = useMemo(() => parseRestrictedHtml(deferredValue), [deferredValue]);
  const result = draftResult || valueResult;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.contains(document.activeElement)) return;
    if (editor.innerHTML !== valueResult.previewHtml) editor.innerHTML = valueResult.previewHtml;
    setDraftResult(null);
  }, [mode, valueResult]);

  function emitEditorValue() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = serializeRestrictedHtmlEditor(editor);
    setDraftResult(next);
    if (next.normalizedHtml != null && next.normalizedHtml !== value) onChange(next.normalizedHtml);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    insertPlainText(event.clipboardData.getData('text/plain'));
    emitEditorValue();
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setMode(mode === 'edit' ? 'preview' : 'edit');
    requestAnimationFrame(() => document.getElementById(mode === 'edit' ? previewTabId : editTabId)?.focus());
  }

  const errorCount = result.issues.filter((issue) => issue.level === 'error').length;
  const warningCount = result.issues.length - errorCount;

  return (
    <section className={`restricted-html-editor${className ? ` ${className}` : ''}`} data-disabled={disabled || undefined}>
      <div className="restricted-html-tabs" role="tablist" aria-label="正文编辑模式">
        <button
          id={editTabId}
          type="button"
          role="tab"
          aria-selected={mode === 'edit'}
          aria-controls={editPanelId}
          tabIndex={mode === 'edit' ? 0 : -1}
          onClick={() => setMode('edit')}
          onKeyDown={handleTabKey}
        >
          可视化编辑
        </button>
        <button
          id={previewTabId}
          type="button"
          role="tab"
          aria-selected={mode === 'preview'}
          aria-controls={previewPanelId}
          tabIndex={mode === 'preview' ? 0 : -1}
          onClick={() => setMode('preview')}
          onKeyDown={handleTabKey}
        >
          预览
        </button>
        <span className={`restricted-html-status${errorCount ? ' is-error' : ''}`} role="status" aria-live="polite">
          {errorCount ? `${errorCount} 项结构错误` : warningCount ? `已自动清理 ${warningCount} 项` : '格式有效'}
        </span>
      </div>

      {mode === 'edit' ? (
        <div
          ref={editorRef}
          id={editPanelId}
          role="textbox"
          aria-multiline="true"
          aria-labelledby={editTabId}
          aria-readonly={disabled || undefined}
          className="restricted-html-editable restricted-html-document"
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={emitEditorValue}
          onBlur={emitEditorValue}
          onPaste={handlePaste}
        />
      ) : (
        <div id={previewPanelId} role="tabpanel" aria-labelledby={previewTabId} className="restricted-html-preview">
          {result.previewHtml ? (
            <div className="restricted-html-document" dangerouslySetInnerHTML={{ __html: result.previewHtml }} />
          ) : (
            <p className="restricted-html-empty">暂无正文内容</p>
          )}
        </div>
      )}

      {result.issues.length > 0 && (
        <ul className="restricted-html-issues" aria-label="正文格式问题">
          {result.issues.slice(0, 6).map((issue, index) => (
            <li key={`${issue.blockIndex}-${issue.message}-${index}`} data-level={issue.level}>
              第 {issue.blockIndex + 1} 块：{issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default RestrictedHtmlEditor;
