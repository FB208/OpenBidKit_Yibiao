import { useEffect, useRef, useState } from 'react';
import type { OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';
import { useOfficialAccount } from './useOfficialAccount';
import OfficialRechargeDialog from './OfficialRechargeDialog';

const paymentLabels = { WAITING: '待支付', SUCCESS: '支付成功', CLOSED: '已关闭' };
const refundLabels = { NONE: '', PENDING: '退款处理中', SUCCESS: '已退款', FAILED: '退款失败' };

// 查询账户订单并订阅后台变化；详情和关单均使用服务端结果。
export default function OfficialOrdersPanel() {
  const account = useOfficialAccount();
  const [orders, setOrders] = useState<OfficialRechargeOrder[]>([]);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<OfficialRechargeOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<OfficialRechargeOrder | null>(null);
  const detailRequest = useRef(0);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const { showToast } = useToast();
  const totalPages = Math.max(1, Math.ceil(orders.length / 5));
  const currentPage = Math.min(page, totalPages);

  useEffect(() => {
    setOrders([]);
    setPage(1);
    setDetail(null);
    setPaymentOrder(null);
    detailRequest.current++;
    if (account.status !== 'signed-in') return;
    let disposed = false;
    const updates = new Map<string, OfficialRechargeOrder>();
    setStatus('loading');
    const unsubscribe = window.yibiao.officialAccount.onRechargeOrderChanged((order) => {
      if (disposed) return;
      updates.set(order.id, order);
      setOrders((current) => current.some((item) => item.id === order.id)
        ? current.map((item) => item.id === order.id ? order : item)
        : [order, ...current]);
      setDetail((current) => current?.id === order.id ? order : current);
    });
    void window.yibiao.officialAccount.getRechargeOrders().then((items) => {
      if (disposed) return;
      const merged = new Map(items.map((item) => [item.id, item]));
      updates.forEach((item, id) => merged.set(id, item));
      setOrders([...merged.values()]);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '订单加载失败', 'error');
    });
    return () => { disposed = true; detailRequest.current++; unsubscribe(); };
  }, [account.status, account.accountId, attempt, showToast]);

  // 先展示所选订单，再查询最新详情；关闭后忽略迟到结果。
  const openDetail = async (order: OfficialRechargeOrder, trigger: HTMLButtonElement) => {
    const request = ++detailRequest.current;
    detailTrigger.current = trigger;
    setDetail(order);
    setDetailLoading(true);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.id);
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
    setResuming(order.id);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.id);
      if (request !== detailRequest.current) return;
      setDetail((current) => current?.id === latest.id ? latest : current);
      if (latest.payStatus !== 'WAITING') showToast(paymentLabels[latest.payStatus], 'info');
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
      const latest = await window.yibiao.officialAccount.closeRechargeOrder(detail.id);
      if (request !== detailRequest.current) return;
      setDetail(latest);
      showToast(latest.payStatus === 'CLOSED' ? '订单已关闭' : paymentLabels[latest.payStatus], 'success');
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '关闭订单失败', 'error');
    } finally {
      setClosing(false);
    }
  };

  if (account.status !== 'signed-in') return <p className="official-api-empty">{account.status === 'loading' ? '正在读取账户…' : '请先在账号处登陆后查看订单'}</p>;

  return (
    <>
      <div className="official-orders-toolbar">
        <span role="status">{status === 'loading' ? '正在加载订单…' : status === 'error' ? '订单加载失败' : `共 ${orders.length} 笔订单`}</span>
        <button type="button" className="inline-action" disabled={status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>{status === 'error' ? '重试' : '刷新'}</button>
      </div>
      <table className="official-api-table official-orders-table" aria-label="订单记录" aria-busy={status === 'loading'}>
        <thead><tr>{['时间', '订单号', '金额', 'e点', '状态', '操作'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {orders.slice((currentPage - 1) * 5, currentPage * 5).map((order) => (
            <tr key={order.id}>
              <td>{order.createTime}</td>
              <td><button type="button" className="official-order-link" onClick={(event) => { void openDetail(order, event.currentTarget); }}>{order.orderNo}</button></td>
              <td>¥{order.payPrice}</td>
              <td>{order.totalPoint}</td>
              <td><span className={`official-order-status is-${order.payStatus.toLowerCase()}`}>{paymentLabels[order.payStatus]}</span>{order.refundStatus !== 'NONE' && <small className="official-order-refund">{refundLabels[order.refundStatus]}</small>}</td>
              <td>{order.payStatus === 'WAITING' && <button type="button" className="inline-action" disabled={!!resuming} onClick={(event) => { void resumePayment(order, event.currentTarget); }}>{resuming === order.id ? '正在读取…' : '继续支付'}</button>}</td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={6} className="official-api-empty">{status === 'loading' ? <InlineSpinner /> : status === 'error' ? '请重试加载订单' : '暂无订单'}</td></tr>}
        </tbody>
      </table>
      {status === 'ready' && orders.length > 0 && (
        <nav className="official-orders-toolbar" aria-label="订单分页">
          <button type="button" className="inline-action" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span role="status">第 {currentPage} / {totalPages} 页 · 每页 5 条</span>
          <button type="button" className="inline-action" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </nav>
      )}
      {detail && (
        <AppDialog open onOpenChange={(open) => { if (!open) closeDetail(); }} title="订单详情" description={detail.orderNo} cardClassName="official-order-dialog" preventClose={closing || !!resuming} actions={(
          <>
            <button type="button" className="secondary-action" disabled={closing || !!resuming} onClick={closeDetail}>关闭</button>
            {detail.payStatus === 'WAITING' && <>
              <button type="button" className="secondary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void closeOrder(); }}>{closing ? '正在关闭…' : '关闭订单'}</button>
              <button type="button" className="primary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void resumePayment(detail); }}>{resuming ? '正在读取…' : '继续支付'}</button>
            </>}
          </>
        )}>
          <dl className="official-order-detail" aria-busy={detailLoading}>
            <dt>商品</dt><dd>{detail.optionName} × {detail.quantity}</dd>
            <dt>金额</dt><dd>¥{detail.payPrice}</dd>
            <dt>e点</dt><dd>{detail.totalPoint}</dd>
            <dt>创建时间</dt><dd>{detail.createTime}</dd>
            <dt>支付完成时间</dt><dd>{detail.finishTime || '—'}</dd>
            <dt>支付状态</dt><dd>{paymentLabels[detail.payStatus]}{detailLoading && <InlineSpinner />}</dd>
            {detail.refundStatus !== 'NONE' && <><dt>退款状态</dt><dd>{refundLabels[detail.refundStatus]}</dd></>}
          </dl>
        </AppDialog>
      )}
      {paymentOrder && <OfficialRechargeDialog initialOrder={paymentOrder} onClose={closeDetail} onViewOrders={closeDetail} />}
    </>
  );
}
