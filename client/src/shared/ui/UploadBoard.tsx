import { useRef, useState, type DragEvent, type ReactNode } from 'react';

export interface UploadBoardProps {
  /** 标题上方的步骤标签，例如 STEP 01 */
  kicker?: string;
  title: string;
  /** 标题下方的说明文案 */
  subtitle?: ReactNode;
  /** 标题右侧的附加内容，例如文件统计摘要 */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 上传面板：卡片容器 + 标题区 + 上传行堆栈，供技术方案/查重/废标等 Step01 复用 */
export function UploadBoard({ kicker, title, subtitle, aside, children, className }: UploadBoardProps) {
  return (
    <section className={`upload-board${className ? ` ${className}` : ''}`}>
      <div className="upload-page-title">
        <div>
          {kicker ? <span className="section-kicker">{kicker}</span> : null}
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {aside}
      </div>
      <div className="upload-stack">{children}</div>
    </section>
  );
}

export interface UploadRowProps {
  /** 行序号标签，例如 01 */
  index: string;
  title: string;
  /** 标题下的补充说明，例如“必选，可多份” */
  note?: string;
  /** 右侧操作按钮区 */
  actions: ReactNode;
  children: ReactNode;
  className?: string;
  /** 传入后该行成为拖拽目标：拖入文件时高亮，松开时回调 */
  onDropFiles?: (files: FileList) => void;
  dropDisabled?: boolean;
}

/** 单个上传行：序号标签 + 内容区（文件胶囊/空态）+ 操作按钮 */
export function UploadRow({ index, title, note, actions, children, className, onDropFiles, dropDisabled = false }: UploadRowProps) {
  const [dragOver, setDragOver] = useState(false);
  // 计数进入/离开次数，避免拖过子元素时高亮闪烁
  const dragDepthRef = useRef(0);
  const droppable = Boolean(onDropFiles) && !dropDisabled;

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!droppable || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!droppable || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!droppable) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragOver(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!droppable) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      onDropFiles?.(event.dataTransfer.files);
    }
  };

  return (
    <article
      className={`upload-row${className ? ` ${className}` : ''}${dragOver ? ' is-drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="upload-label">
        <span>{index}</span>
        <strong>{title}</strong>
        {note ? <small>{note}</small> : null}
      </div>
      <div className="upload-content">{children}</div>
      <div className="upload-actions">{actions}</div>
    </article>
  );
}

export interface UploadFilePillProps {
  /** 图标徽标文案，例如 MD / DOCX */
  badge: string;
  name: string;
  /** 名称下方的元信息，例如大小、解析方式、字数 */
  meta?: string;
  onRemove?: () => void;
  removeLabel?: string;
  removeAriaLabel?: string;
  removeDisabled?: boolean;
}

/** 已上传文件胶囊：徽标 + 文件名/元信息 + 可选移除按钮 */
export function UploadFilePill({ badge, name, meta, onRemove, removeLabel = '删除', removeAriaLabel, removeDisabled = false }: UploadFilePillProps) {
  return (
    <article className="upload-file-pill">
      <div className="upload-file-icon">{badge}</div>
      <div className="upload-file-info">
        <strong title={name}>{name}</strong>
        {meta ? <span>{meta}</span> : null}
      </div>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeAriaLabel || `${removeLabel} ${name}`} disabled={removeDisabled}>
          {removeLabel}
        </button>
      ) : null}
    </article>
  );
}

export interface UploadEmptyProps {
  title: string;
  hint?: string;
  /** 可选的引导操作，例如直接触发上传的按钮 */
  children?: ReactNode;
}

/** 上传行空态：标题 + 提示文案 + 可选引导操作 */
export function UploadEmpty({ title, hint, children }: UploadEmptyProps) {
  return (
    <div className="upload-empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {children}
    </div>
  );
}
