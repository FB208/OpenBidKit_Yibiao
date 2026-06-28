import { useEffect, useState } from 'react';
import type { AgentRuntimeStatus } from '../shared/types';

const phaseLabels: Record<string, string> = {
  stopped: 'Agent 已停止',
  starting: 'Agent 正在启动',
  idle: 'Agent 空闲',
  running: 'Agent 任务运行中',
  aborting: 'Agent 正在停止任务',
  unhealthy: 'Agent 服务异常',
  restarting: 'Agent 正在重启',
  closing: 'Agent 正在关闭',
};

function shouldShowStatus(status: AgentRuntimeStatus | null) {
  if (!status) return false;
  return Boolean(
    status.active_task
    || status.restart_pending
    || status.phase === 'starting'
    || status.phase === 'running'
    || status.phase === 'aborting'
    || status.phase === 'unhealthy'
    || status.phase === 'restarting'
    || status.phase === 'closing'
    || status.last_health_error
  );
}

function getTone(status: AgentRuntimeStatus) {
  if (status.phase === 'unhealthy') return 'error';
  if (status.restart_pending || status.last_health_error) return 'warning';
  if (status.active_task || status.phase === 'running') return 'running';
  return 'info';
}

function AgentRuntimeStatusBar() {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.yibiao?.agent.getStatus()
      .then((nextStatus) => {
        if (!disposed) setStatus(nextStatus);
      })
      .catch(() => undefined);

    const unsubscribe = window.yibiao?.agent.onStatus((nextStatus) => {
      setStatus(nextStatus);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  if (!shouldShowStatus(status)) return null;

  const activeTask = status?.active_task || null;
  const title = activeTask?.title || phaseLabels[status?.phase || ''] || 'Agent 状态';
  const message = activeTask?.progress_text || status?.message || '等待 Agent 真实进度';
  const elapsedText = activeTask ? `已运行 ${activeTask.elapsed_seconds}s` : '';
  const idleText = activeTask ? `空闲 ${activeTask.idle_seconds}s` : '';
  const proxyText = status?.proxy ? `模型队列 ${status.proxy.active}/${status.proxy.queued}/${status.proxy.limit}` : '';
  const warningText = status?.last_health_error || (status?.restart_pending ? '配置已变更，Agent 空闲后会自动重启' : '');

  return (
    <div className={`agent-runtime-status-bar is-${getTone(status as AgentRuntimeStatus)}`} role="status" aria-live="polite">
      <span className="agent-runtime-status-dot" aria-hidden="true" />
      <div className="agent-runtime-status-copy">
        <strong>{title}</strong>
        <span>{warningText || message}</span>
      </div>
      <div className="agent-runtime-status-meta">
        {elapsedText && <em>{elapsedText}</em>}
        {idleText && <em>{idleText}</em>}
        {proxyText && <em>{proxyText}</em>}
      </div>
    </div>
  );
}

export default AgentRuntimeStatusBar;
