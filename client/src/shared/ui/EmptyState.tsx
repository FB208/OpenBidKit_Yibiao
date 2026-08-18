import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  /** 标题下的说明文案 */
  hint?: ReactNode;
  /** 可选的引导操作，例如直达主操作的按钮 */
  children?: ReactNode;
  className?: string;
}

/** 统一空态卡片：虚线边框居中样式，可嵌入引导按钮 */
export default function EmptyState({ title, hint, children, className }: EmptyStateProps) {
  return (
    <div className={`yb-empty-state${className ? ` ${className}` : ''}`}>
      <strong>{title}</strong>
      {hint != null ? <span>{hint}</span> : null}
      {children}
    </div>
  );
}
