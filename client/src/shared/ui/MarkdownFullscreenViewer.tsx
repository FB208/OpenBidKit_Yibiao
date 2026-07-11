import * as Dialog from '@radix-ui/react-dialog';
import type { CSSProperties, ReactNode } from 'react';

export interface MarkdownFullscreenViewerProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  description?: string;
  buttonLabel?: string;
  disabled?: boolean;
  showFullscreen?: boolean;
  fullscreenClassName?: string;
  fullscreenStyle?: CSSProperties;
  fullscreenChildren?: ReactNode;
}

function MarkdownFullscreenViewer({
  children,
  className = 'markdown-viewer',
  style,
  title = 'Markdown 全屏预览',
  description = '全屏查看当前 Markdown 内容。',
  buttonLabel = '全屏',
  disabled = false,
  showFullscreen = true,
  fullscreenClassName,
  fullscreenStyle,
  fullscreenChildren,
}: MarkdownFullscreenViewerProps) {
  const normalClassName = className;
  const dialogContentClassName = fullscreenClassName || className || 'markdown-viewer';
  const dialogStyle = fullscreenStyle || style;

  return (
    <Dialog.Root>
      <div className="markdown-fullscreen-frame">
        <div className={normalClassName} style={style}>{children}</div>
        {showFullscreen && (
          <Dialog.Trigger asChild>
            <button type="button" className="markdown-fullscreen-trigger" disabled={disabled} aria-label={buttonLabel} title={buttonLabel}>
              {buttonLabel}
            </button>
          </Dialog.Trigger>
        )}
      </div>
      {showFullscreen && (
        <Dialog.Portal>
          <Dialog.Overlay className="markdown-fullscreen-overlay" />
          <Dialog.Content className="markdown-fullscreen-dialog">
            <Dialog.Title className="markdown-fullscreen-title">{title}</Dialog.Title>
            <Dialog.Description className="markdown-fullscreen-description">{description}</Dialog.Description>
            <Dialog.Close className="markdown-fullscreen-close" type="button">退出全屏</Dialog.Close>
            <div className="markdown-fullscreen-content">
              <div className={dialogContentClassName} style={dialogStyle}>{fullscreenChildren || children}</div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}

export default MarkdownFullscreenViewer;
