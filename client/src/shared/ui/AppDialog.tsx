import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export interface AppDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 标题上方的小标签文案，例如“切换模式”“结果提醒” */
  kicker?: string;
  title: ReactNode;
  description?: ReactNode;
  /** 弹窗正文（头部与底部操作之间的自定义内容） */
  children?: ReactNode;
  /** 底部操作按钮区，传入按钮元素 */
  actions?: ReactNode;
  /** 追加到卡片上的自定义类名，用于个别弹窗微调宽度或布局 */
  cardClassName?: string;
  /** 禁止 Esc 和点击遮罩关闭（用于执行中、必须选择的场景） */
  preventClose?: boolean;
}

/**
 * 统一的应用弹窗封装：遮罩 + 居中卡片 + kicker/标题/描述头部 + 操作区。
 * 视觉与既有 content-regenerate-* 系列保持一致，进出动画由 shared-dialog.css 统一提供。
 */
export default function AppDialog({
  open,
  onOpenChange,
  kicker,
  title,
  description,
  children,
  actions,
  cardClassName,
  preventClose = false,
}: AppDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-dialog-modal" />
        <Dialog.Content
          className={`app-dialog-card${cardClassName ? ` ${cardClassName}` : ''}`}
          onEscapeKeyDown={preventClose ? (event) => event.preventDefault() : undefined}
          onPointerDownOutside={preventClose ? (event) => event.preventDefault() : undefined}
        >
          <div className="app-dialog-card-head">
            {kicker ? <span className="section-kicker">{kicker}</span> : null}
            <Dialog.Title>{title}</Dialog.Title>
            {description != null ? <Dialog.Description>{description}</Dialog.Description> : null}
          </div>
          {children}
          {actions ? <div className="app-dialog-actions">{actions}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
