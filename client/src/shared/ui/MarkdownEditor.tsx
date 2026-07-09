import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type RefObject } from 'react';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  fullscreenTitle?: string;
  fullscreenDescription?: string;
}

const toolbarActions = [
  { id: 'bold', label: '加粗', title: '加粗', prefix: '**', suffix: '**', content: <strong>B</strong> },
  { id: 'italic', label: '斜体', title: '斜体', prefix: '*', suffix: '*', content: <em>I</em> },
  { id: 'heading', label: '标题', title: '标题', prefix: '## ', suffix: '', content: 'H' },
  { id: 'quote', label: '引用', title: '引用', prefix: '> ', suffix: '', content: '❝' },
  { id: 'unordered-list', label: '无序列表', title: '无序列表', prefix: '- ', suffix: '', content: '•' },
  { id: 'ordered-list', label: '有序列表', title: '有序列表', prefix: '1. ', suffix: '', content: '1.' },
];

function MarkdownEditor({
  value,
  onChange,
  placeholder = '输入 Markdown 内容...',
  className,
  disabled = false,
  fullscreenTitle = 'Markdown 全屏编辑',
  fullscreenDescription = '全屏编辑当前 Markdown 内容。',
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);

  function insertMarkdown(targetRef: RefObject<HTMLTextAreaElement | null>, prefix: string, suffix = '') {
    const textarea = targetRef.current;
    if (!textarea || disabled) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const scrollTop = textarea.scrollTop;
    const selected = value.slice(start, end) || '文本';
    const next = value.slice(0, start) + prefix + selected + suffix + value.slice(end);
    onChange(next);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.scrollTop = scrollTop;
      textarea.selectionStart = start + prefix.length;
      textarea.selectionEnd = start + prefix.length + selected.length;
    });
  }

  function renderToolbarButtons(targetRef: RefObject<HTMLTextAreaElement | null>) {
    return toolbarActions.map((action) => (
      <button
        type="button"
        title={action.title}
        aria-label={action.label}
        disabled={disabled}
        onClick={() => insertMarkdown(targetRef, action.prefix, action.suffix)}
        key={action.id}
      >
        {action.content}
      </button>
    ));
  }

  return (
    <Dialog.Root>
      <div className={`markdown-editor${className ? ` ${className}` : ''}`}>
        <div className="markdown-editor-toolbar" aria-label="Markdown 编辑工具栏">
          {renderToolbarButtons(textareaRef)}
          <span className="markdown-editor-toolbar-spacer" />
          <Dialog.Trigger asChild>
            <button type="button" className="markdown-editor-fullscreen-trigger" disabled={disabled} aria-label="全屏编辑" title="全屏编辑">
              全屏
            </button>
          </Dialog.Trigger>
        </div>
        <textarea
          ref={textareaRef}
          className="markdown-editor-textarea"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="markdown-fullscreen-overlay" />
        <Dialog.Content
          className="markdown-editor-fullscreen-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => fullscreenTextareaRef.current?.focus());
          }}
        >
          <Dialog.Title className="markdown-fullscreen-title">{fullscreenTitle}</Dialog.Title>
          <Dialog.Description className="markdown-fullscreen-description">{fullscreenDescription}</Dialog.Description>
          <Dialog.Close className="markdown-fullscreen-close" type="button">退出全屏</Dialog.Close>
          <div className="markdown-editor markdown-editor-fullscreen-body">
            <div className="markdown-editor-toolbar" aria-label="Markdown 全屏编辑工具栏">
              {renderToolbarButtons(fullscreenTextareaRef)}
            </div>
            <textarea
              ref={fullscreenTextareaRef}
              className="markdown-editor-textarea"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={placeholder}
              disabled={disabled}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default MarkdownEditor;
