import { useEffect, useState } from 'react';
import type { DeveloperTextTokenStats } from '../../../shared/types/ipc';

const emptyStats: DeveloperTextTokenStats = {
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  cache_ratio: 0,
};

function formatInteger(value: number) {
  return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('zh-CN');
}

function formatPercent(value: number) {
  const percent = (Number(value) || 0) * 100;
  return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

function DeveloperTokenStatsWindow() {
  const [stats, setStats] = useState<DeveloperTextTokenStats>(emptyStats);

  useEffect(() => {
    document.documentElement.classList.add('token-stats-transparent-root');
    document.body.classList.add('token-stats-transparent-root');

    let mounted = true;
    void window.yibiao?.developerTokenStats.get()
      .then((nextStats) => {
        if (mounted && nextStats) {
          setStats(nextStats);
        }
      })
      .catch((error) => {
        if (mounted) {
          console.warn(error instanceof Error ? error.message : '读取 Token 统计失败');
        }
      });

    const unsubscribe = window.yibiao?.developerTokenStats.onChanged((nextStats) => {
      setStats(nextStats);
    }) ?? (() => undefined);

    return () => {
      mounted = false;
      unsubscribe();
      document.documentElement.classList.remove('token-stats-transparent-root');
      document.body.classList.remove('token-stats-transparent-root');
    };
  }, []);

  const resetStats = async () => {
    try {
      const nextStats = await window.yibiao?.developerTokenStats.reset();
      setStats(nextStats || emptyStats);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : '重置 Token 统计失败');
    }
  };

  const statItems = [
    { label: '输入 Token', value: formatInteger(stats.input_tokens), tone: 'primary' },
    { label: '输出 Token', value: formatInteger(stats.output_tokens), tone: 'violet' },
    { label: '总 Token', value: formatInteger(stats.total_tokens), tone: 'dark' },
    { label: '缓存 Token', value: formatInteger(stats.cached_tokens), tone: 'green' },
    { label: '缓存比例', value: formatPercent(stats.cache_ratio), tone: 'amber' },
    { label: '请求次数', value: formatInteger(stats.request_count), tone: 'muted' },
  ];

  return (
    <main className="token-stats-window">
      <section className="token-stats-shell">
        <header className="token-stats-header">
          <div>
            <span>Developer Overlay</span>
            <h1>Token 统计</h1>
          </div>
          <div className="token-stats-actions">
            <button type="button" onClick={resetStats}>重置</button>
            <button type="button" aria-label="关闭 Token 统计小窗" onClick={() => window.close()}>×</button>
          </div>
        </header>

        <div className="token-stats-grid">
          {statItems.map((item) => (
            <div className={`token-stats-card is-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

      </section>
    </main>
  );
}

export default DeveloperTokenStatsWindow;
