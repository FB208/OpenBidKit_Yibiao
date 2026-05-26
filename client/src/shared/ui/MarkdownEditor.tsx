import { useRef } from 'react';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

const toolbarActions = [
  { id: 'bold', label: '加粗', title: '加粗', prefix: '**', suffix: '**', content: <strong>B</strong> },
  { id: 'italic', label: '斜体', title: '斜体', prefix: '*', suffix: '*', content: <em>I</em> },
  { id: 'heading', label: '标题', title: '标题', prefix: '## ', suffix: '', content: 'H' },
  { id: 'quote', label: '引用', title: '引用', prefix: '> ', suffix: '', content: '❝' },
  { id: 'unordered-list', label: '无序列表', title: '无序列表', prefix: '- ', suffix: '', content: '•' },
  { id: 'ordered-list', label: '有序列表', title: '有序列表', prefix: '1. ', suffix: '', content: '1.' },
];

function MarkdownEditor({ value, onChange, placeholder = '输入 Markdown 内容...', className, disabled = false }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertMarkdown(prefix: string, suffix = '') {
    const textarea = textareaRef.current;
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

  return (
    <div className={`markdown-editor${className ? ` ${className}` : ''}`}>
      <div className="markdown-editor-toolbar" aria-label="Markdown 编辑工具栏">
        {toolbarActions.map((action) => (
          <button
            type="button"
            title={action.title}
            aria-label={action.label}
            disabled={disabled}
            onClick={() => insertMarkdown(action.prefix, action.suffix)}
            key={action.id}
          >
            {action.content}
          </button>
        ))}
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
  );
}

export default MarkdownEditor;
