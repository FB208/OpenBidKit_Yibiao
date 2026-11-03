import { useEffect, useRef, useState } from 'react';
import type { OfficialAccountState, OfficialPage, OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';
import { useOfficialAccount } from './useOfficialAccount';
import OfficialRechargeDialog from './OfficialRechargeDialog';
import OfficialInvoiceAction from './OfficialInvoiceAction';
import OfficialSourceSelect from './OfficialSourceSelect';
import { formatFenAsYuan } from './officialDisplay';

const paymentLabels = { WAITING: '待支付', PAID: '支付成功', CLOSED: '已关闭' };
const refundLabels = { NONE: '', PENDING: '退款处理中', SUCCESS: '已退款', FAILED: '退款失败' };
const columns = ['时间', '订单号', '金额', 'e点', '状态', '操作'];

// 账户或身份变化时重新挂载列表，清除前一身份的订单、来源和页码。
export default function OfficialOrdersPanel() {
  const account = useOfficialAccount();
  if (account.status !== 'signed-in' || !account.identityType) {
    return <p className="official-api-empty">{account.status === 'loading' ? '正在读取账户…' : '请先在账号处登陆后查看订单'}</p>;
  }
  return <OrdersList key={`${account.identityType}:${account.accountId ?? account.email}`} account={account} />;
}

// 按来源分页查询订单并订阅后台变化；详情和关单均使用服务端结果。
function OrdersList({ account }: { account: OfficialAccountState }) {
  const [page, setPage] = useState(1);
  const [source, setSource] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<OfficialPage<OfficialRechargeOrder> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<OfficialRechargeOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<OfficialRechargeOrder | null>(null);
  const detailRequest = useRef(0);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const view = useRef({ data, ready: false, latest: true });
  const { showToast } = useToast();
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  useEffect(() => {
    view.current = { data, ready: status === 'ready', latest: page === 1 && !source };
  });

  useEffect(() => () => { detailRequest.current++; }, []);

  useEffect(() => {
    let disposed = false;
    setStatus('loading');
    setData(null);
    void window.yibiao.officialAccount.getRechargeOrders({ current: page, sourceAccountId: source || undefined }).then((result) => {
      if (disposed) return;
      // 刷新后数据减少时，重新查询最后一页。
      const lastPage = Math.max(1, Math.ceil(result.total / result.size));
      if (page > lastPage) { setPage(lastPage); return; }
      setData(result);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '订单加载失败', 'error');
    });
    return () => { disposed = true; };
  }, [page, source, attempt, showToast]);

  // 当前页已有的订单就地更新；只有本机刚创建的订单在查看当前账户第一页时插到最前，其余不在本页的通知忽略。加载中的事件来自本次查询本身，忽略。
  useEffect(() => window.yibiao.officialAccount.onRechargeOrderChanged((order, created) => {
    setDetail((current) => current?.orderNo === order.orderNo ? order : current);
    const { data: current, ready, latest } = view.current;
    if (!current || !ready) return;
    if (current.records.some((item) => item.orderNo === order.orderNo)) {
      setData({ ...current, records: current.records.map((item) => item.orderNo === order.orderNo ? order : item) });
    } else if (created && latest) {
      setData({ ...current, total: current.total + 1, records: [order, ...current.records].slice(0, current.size) });
    }
  }), []);

  // 先展示所选订单，再查询最新详情；关闭后忽略迟到结果。
  const openDetail = async (order: OfficialRechargeOrder, trigger: HTMLButtonElement) => {
    const request = ++detailRequest.current;
    detailTrigger.current = trigger;
    setDetail(order);
    setDetailLoading(true);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.orderNo);
      if (request === detailRequest.current) setDetail(latest);
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '订单详情加载失败', 'error');
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  // 关闭详情并恢复到列表中的订单入口。
  const closeDetail = () => {
    detailRequest.current++;
    setDetail(null);
    setPaymentOrder(null);
    requestAnimationFrame(() => detailTrigger.current?.focus());
  };

  // 重查待支付状态后再打开本机缓存的二维码，不创建新订单。
  const resumePayment = async (order: OfficialRechargeOrder, trigger?: HTMLButtonElement) => {
    if (resuming) return;
    const request = ++detailRequest.current;
    if (trigger) detailTrigger.current = trigger;
    setResuming(order.orderNo);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.orderNo);
      if (request !== detailRequest.current) return;
      setDetail((current) => current?.orderNo === latest.orderNo ? latest : current);
      if (latest.status !== 'WAITING') showToast(paymentLabels[latest.status], 'info');
      else if (!latest.qrCode) showToast('本机没有可用的支付二维码，可能未保存或已清理。可关闭该订单后重新充值。', 'info');
      else { setDetail(null); setPaymentOrder(latest); }
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '支付二维码加载失败', 'error');
    } finally {
      setResuming(null);
    }
  };

  // 明确关单操作，拒绝时由 Main 重查状态，页面保留订单详情。
  const closeOrder = async () => {
    if (!detail || closing) return;
    const request = detailRequest.current;
    setClosing(true);
    try {
      const latest = await window.yibiao.officialAccount.closeRechargeOrder(detail.orderNo);
      if (request !== detailRequest.current) return;
      setDetail(latest);
      showToast(latest.status === 'CLOSED' ? '订单已关闭' : paymentLabels[latest.status], 'success');
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '关闭订单失败', 'error');
    } finally {
      setClosing(false);
    }
  };

  return (
    <>
      <div className="official-orders-toolbar">
        <span role="status">{status === 'loading' ? '正在加载订单…' : status === 'error' ? '订单加载失败' : `共 ${data?.total ?? 0} 笔订单`}</span>
        <div className="official-orders-toolbar-actions">
          <OfficialSourceSelect account={account} value={source} defaultLabel="当前团队订单" disabled={status === 'loading'} onChange={(value) => { setSource(value); setPage(1); }} />
          <button type="button" className="inline-action" disabled={status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>{status === 'loading' ? <><InlineSpinner />加载中…</> : status === 'error' ? '重试' : '刷新'}</button>
        </div>
      </div>
      <table className="official-api-table official-orders-table" aria-label="订单记录" aria-busy={status === 'loading'}>
        <thead><tr>{columns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {status === 'loading' && <tr><td colSpan={columns.length}><div className="official-table-loading" role="status"><InlineSpinner /><span>正在加载订单…</span></div></td></tr>}
          {status !== 'loading' && data?.records.map((order) => (
            <tr key={order.orderNo}>
              <td>{order.createTime}</td>
              <td><button type="button" className="official-order-link" onClick={(event) => { void openDetail(order, event.currentTarget); }}>{order.orderNo}</button></td>
              <td>¥{formatFenAsYuan(order.payAmountFen)}</td>
              <td>{order.rechargePoint}</td>
              <td><span className={`official-order-status is-${order.status.toLowerCase()}`}>{paymentLabels[order.status]}</span>{order.refundStatus !== 'NONE' && <small className="official-order-refund">{refundLabels[order.refundStatus]}</small>}</td>
              <td>{order.status === 'WAITING' && <button type="button" className="inline-action" disabled={!!resuming} onClick={(event) => { void resumePayment(order, event.currentTarget); }}>{resuming === order.orderNo ? '正在读取…' : '继续支付'}</button>}
                {order.status === 'PAID' && order.refundStatus === 'NONE' && <OfficialInvoiceAction isEmailAccount={account.identityType === 'email'} order={order} />}
              </td>
            </tr>
          ))}
          {status !== 'loading' && !data?.records.length && <tr><td colSpan={columns.length} className="official-api-empty">{status === 'error' ? '请重试加载订单' : '暂无订单'}</td></tr>}
        </tbody>
      </table>
      {status === 'ready' && data && data.total > 0 && (
        <nav className="official-orders-toolbar" aria-label="订单分页">
          <button type="button" className="inline-action" disabled={data.current <= 1} onClick={() => setPage(data.current - 1)}>上一页</button>
          <span role="status">第 {data.current} / {totalPages} 页 · 每页 {data.size} 条</span>
          <button type="button" className="inline-action" disabled={data.current >= totalPages} onClick={() => setPage(data.current + 1)}>下一页</button>
        </nav>
      )}
      {detail && (
        <AppDialog open onOpenChange={(open) => { if (!open) closeDetail(); }} title="订单详情" description={detail.orderNo} cardClassName="official-order-dialog" preventClose={closing || !!resuming} actions={(
          <>
            <button type="button" className="secondary-action" disabled={closing || !!resuming} onClick={closeDetail}>关闭</button>
            {detail.status === 'WAITING' && <>
              <button type="button" className="secondary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void closeOrder(); }}>{closing ? '正在关闭…' : '关闭订单'}</button>
              <button type="button" className="primary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void resumePayment(detail); }}>{resuming ? '正在读取…' : '继续支付'}</button>
            </>}
          </>
        )}>
          <dl className="official-order-detail" aria-busy={detailLoading}>
            <dt>商品</dt><dd>{detail.productName}</dd>
            <dt>金额</dt><dd>¥{formatFenAsYuan(detail.payAmountFen)}</dd>
            <dt>e点</dt><dd>{detail.rechargePoint}</dd>
            <dt>创建时间</dt><dd>{detail.createTime}</dd>
            <dt>支付完成时间</dt><dd>{detail.paidTime || '—'}</dd>
            <dt>支付状态</dt><dd>{paymentLabels[detail.status]}{detailLoading && <InlineSpinner />}</dd>
            {detail.refundStatus !== 'NONE' && <><dt>退款状态</dt><dd>{refundLabels[detail.refundStatus]}</dd></>}
          </dl>
        </AppDialog>
      )}
      {paymentOrder && <OfficialRechargeDialog initialOrder={paymentOrder} onClose={closeDetail} onViewOrders={closeDetail} />}
    </>
  );
}
