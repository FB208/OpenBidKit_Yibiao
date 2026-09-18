import { useEffect, useState } from 'react';
import type { OfficialTransactionsPage } from '../../../shared/types/officialAccount';
import { InlineSpinner, useToast } from '../../../shared/ui';
import { useOfficialAccount } from './useOfficialAccount';

const consumeLabels = { AI_SETTLE: '文本消费' };
const columns = ['消费时间', '请求编号', '类型', '消耗 e点', '结算后余额 e点', '说明'];

// 账户或身份变化时重新挂载列表，清除前一身份的数据和页码。
export default function OfficialTransactionsPanel() {
  const account = useOfficialAccount();
  if (account.status !== 'signed-in' || !account.identityType) {
    return <p className="official-api-empty">{account.status === 'loading' ? '正在读取账户…' : '请先在账号处登录后查看流水'}</p>;
  }
  return <TransactionsList key={`${account.accountId}:${account.identityType}`} identityType={account.identityType} />;
}

// 服务端分页查询；页面卸载和翻页后忽略迟到响应。
function TransactionsList({ identityType }: { identityType: 'anonymous' | 'email' }) {
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<OfficialTransactionsPage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const { showToast } = useToast();

  useEffect(() => {
    let disposed = false;
    setStatus('loading');
    setData(null);
    void window.yibiao.officialAccount.getTransactions(page).then((result) => {
      if (disposed) return;
      // 刷新后数据减少时，重新查询最后一页。
      const lastPage = Math.max(1, Math.ceil(result.total / result.size));
      if (page > lastPage) { setPage(lastPage); return; }
      setData(result);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '流水加载失败，请重试', 'error');
    });
    return () => { disposed = true; };
  }, [page, attempt, showToast]);

  return (
    <>
      <div className="official-orders-toolbar">
        <span role="status">{status === 'loading' ? '正在加载流水…' : status === 'error' ? '流水加载失败' : `${identityType === 'email' ? '当前账户消费流水' : '当前设备消费流水'} · 共 ${data?.total ?? 0} 条`}</span>
        <button type="button" className="inline-action" disabled={status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>{status === 'loading' ? <><InlineSpinner />加载中…</> : status === 'error' ? '重试' : '刷新'}</button>
      </div>
      <table className="official-api-table official-orders-table" aria-label="流水记录" aria-busy={status === 'loading'}>
        <thead><tr>{columns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {status === 'loading' && <tr><td colSpan={columns.length}><div className="official-table-loading" role="status"><InlineSpinner /><span>正在加载流水…</span></div></td></tr>}
          {status !== 'loading' && data?.records.map((record) => (
            <tr key={record.recordId}>
              <td>{record.consumeTime}</td><td>{record.requestNo || '—'}</td>
              <td>{consumeLabels[record.consumeType]}</td><td>{record.consumePoint}</td>
              <td>{record.availableAfter}</td><td>{record.remark || '—'}</td>
            </tr>
          ))}
          {status !== 'loading' && !data?.records.length && <tr><td colSpan={columns.length} className="official-api-empty">{status === 'error' ? '请重试加载流水' : '暂无流水'}</td></tr>}
        </tbody>
      </table>
      {status === 'ready' && data && data.total > 0 && (
        <nav className="official-orders-toolbar" aria-label="流水分页">
          <button type="button" className="inline-action" disabled={data.current <= 1} onClick={() => setPage(data.current - 1)}>上一页</button>
          <span role="status">第 {data.current} / {Math.max(1, Math.ceil(data.total / data.size))} 页 · 每页 {data.size} 条</span>
          <button type="button" className="inline-action" disabled={data.current * data.size >= data.total} onClick={() => setPage(data.current + 1)}>下一页</button>
        </nav>
      )}
    </>
  );
}
