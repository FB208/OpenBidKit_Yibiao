import { useState, type ReactNode } from 'react';
import ProgressBar, { type ProgressBarTone } from './ProgressBar';

export type TaskProgressStatus = 'idle' | 'running' | 'success' | 'error';

export interface TaskProgressPanelProps {
  status: TaskProgressStatus;
  /** 面板标题，例如“查重分析”“废标项检查” */
  title: string;
  /** 当前阶段/进度文案 */
  message?: ReactNode;
  /** 进度百分比 0-100 */
  progress: number;
  tone?: ProgressBarTone;
  /** 失败时的重试回调；提供后错误态会在面板内直接展示重试按钮 */
  onRetry?: () => void;
  retryLabel?: string;
  /** 可折叠详情（日志、子任务状态列表等） */
  details?: ReactNode;
  /** 详情折叠按钮文案 */
  detailsLabel?: string;
  /** 详情默认是否展开 */
  detailsDefaultOpen?: boolean;
  className?: string;
}

const statusLabels: Record<TaskProgressStatus, string> = {
  idle: '待开始',
  running: '进行中',
  success: '已完成',
  error: '失败',
};

/**
 * 统一长任务反馈面板：阶段文案 + 统一进度条 + 可折叠详情。
 * 查重、废标检查等长任务用它替代各自的迷你进度条实现；
 * 任务失败时面板内直接提供重试入口，而不是只弹 Toast。
 */
export default function TaskProgressPanel({
  status,
  title,
  message,
  progress,
  tone = 'primary',
  onRetry,
  retryLabel = '重试',
  details,
  detailsLabel = '详情',
  detailsDefaultOpen = false,
  className,
}: TaskProgressPanelProps) {
  const [detailsOpen, setDetailsOpen] = useState(detailsDefaultOpen);

  return (
    <section className={`yb-task-progress is-${status}${className ? ` ${className}` : ''}`} aria-live="polite">
      <div className="yb-task-progress-head">
        <strong>{title}</strong>
        <em className="yb-task-progress-status">{statusLabels[status]}</em>
        <span className="yb-task-progress-spacer" />
        {status === 'error' && onRetry ? (
          <button type="button" className="secondary-action yb-task-progress-retry" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
        {details ? (
          <button
            type="button"
            className="yb-task-progress-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((prev) => !prev)}
          >
            {detailsOpen ? `收起${detailsLabel}` : `展开${detailsLabel}`}
          </button>
        ) : null}
      </div>
      <ProgressBar
        value={status === 'success' ? 100 : progress}
        label={`${title}进度 ${Math.round(progress)}%`}
        tone={status === 'error' ? 'warning' : tone}
        active={status === 'running'}
      />
      {message ? <p className="yb-task-progress-message">{message}</p> : null}
      {details && detailsOpen ? <div className="yb-task-progress-details">{details}</div> : null}
    </section>
  );
}
