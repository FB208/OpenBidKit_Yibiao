import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceDatabasePhase, WorkspaceDatabaseStatus } from '../shared/types';

interface WorkspaceDatabaseGateProps {
  children: ReactNode;
}

const phaseLabels: Record<WorkspaceDatabasePhase, string> = {
  checking: '正在检查本地数据库',
  repairing: '正在修复本地数据库结构',
  'backing-up': '正在备份本地数据库',
  upgrading: '正在升级本地数据库',
  ready: '本地数据库已就绪',
  error: '本地数据库初始化失败',
};

function WorkspaceDatabaseGate({ children }: WorkspaceDatabaseGateProps) {
  const [status, setStatus] = useState<WorkspaceDatabaseStatus | null>(null);
  const [showGate, setShowGate] = useState(false);

  useEffect(() => {
    const database = window.yibiao?.database;
    if (!database) {
      setStatus({ phase: 'ready', ready: true, message: '本地数据库已就绪' });
      return;
    }

    let mounted = true;
    const unsubscribe = database.onStatus((nextStatus) => {
      if (mounted) setStatus(nextStatus);
    });

    database.getStatus()
      .then((nextStatus) => {
        if (mounted) setStatus(nextStatus);
      })
      .catch((error) => {
        if (!mounted) return;
        setStatus({
          phase: 'error',
          ready: false,
          message: error?.message || '读取本地数据库状态失败',
        });
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const ready = status?.ready === true || status?.phase === 'ready';
  const failed = status?.phase === 'error';

  useEffect(() => {
    if (ready) {
      setShowGate(false);
      return undefined;
    }
    if (failed) {
      setShowGate(true);
      return undefined;
    }

    const timer = window.setTimeout(() => setShowGate(true), 150);
    return () => window.clearTimeout(timer);
  }, [failed, ready]);

  if (ready) {
    return <>{children}</>;
  }

  if (!showGate) {
    return null;
  }

  const title = status ? phaseLabels[status.phase] : '正在准备本地数据库';
  const message = status?.message || '正在检查并升级本地数据库，请稍候';

  return (
    <div className="workspace-database-gate" role="status" aria-live="polite">
      <div className="workspace-database-card">
        <div className={failed ? 'workspace-database-mark is-error' : 'workspace-database-mark'}>
          {failed ? '!' : <span />}
        </div>
        <div className="workspace-database-copy">
          <p className="workspace-database-eyebrow">本地工作区</p>
          <h1>{title}</h1>
          <p>{message}</p>
          {!failed && <small>完成前请不要关闭应用，数据库就绪后会自动进入工作台。</small>}
          {failed && <small>请重启应用重试；如果仍然失败，请联系技术支持并保留错误信息。</small>}
        </div>
      </div>
    </div>
  );
}

export default WorkspaceDatabaseGate;
