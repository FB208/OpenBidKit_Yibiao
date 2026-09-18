import { useEffect, useRef, useState } from 'react';
import type { OfficialRechargeOption, OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';

// 新充值查询商品，继续支付复用同一扫码面板；关闭后忽略迟到结果。
export default function OfficialRechargeDialog({ onClose, onViewOrders, initialOrder }: {
  onClose: () => void;
  onViewOrders: () => void;
  initialOrder?: OfficialRechargeOrder;
}) {
  const [options, setOptions] = useState<OfficialRechargeOption[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(initialOrder ? 'ready' : 'loading');
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [order, setOrder] = useState<OfficialRechargeOrder | null>(initialOrder || null);
  const [qrCode, setQrCode] = useState<string | null>(initialOrder?.qrCode || null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [creationFailed, setCreationFailed] = useState(false);
  const creating = useRef(false);
  const mounted = useRef(false);
  const { showToast } = useToast();
  const selected = options.find((item) => item.id === selectedId);
  const isSuccess = order?.payStatus === 'SUCCESS';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (initialOrder && attempt === 0) return;
    let disposed = false;
    void window.yibiao.officialAccount.getRechargeOptions().then((items) => {
      if (disposed) return;
      setOptions(items);
      setSelectedId(items[0]?.id || '');
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '充值商品加载失败', 'error');
    });
    return () => { disposed = true; };
  }, [attempt, initialOrder, showToast]);

  useEffect(() => {
    if (!order) return;
    let lastStatus = order.payStatus;
    return window.yibiao.officialAccount.onRechargeOrderChanged((next) => {
      if (next.id !== order.id) return;
      setOrder(next);
      if (next.payStatus === 'SUCCESS' && lastStatus !== 'SUCCESS') showToast('充值成功', 'success');
      lastStatus = next.payStatus;
    });
  }, [order?.id, showToast]);

  // 显式点击才创建一份订单；同步锁阻止连续点击重复下单。
  const createOrder = async () => {
    if (!selected || creating.current) return;
    creating.current = true;
    setSubmitting(true);
    setCreationFailed(false);
    try {
      const created = await window.yibiao.officialAccount.createRechargeOrder({ optionId: selected.id });
      if (!mounted.current) return;
      setOrder(created);
      setQrCode(created.qrCode);
    } catch (error) {
      if (!mounted.current) return;
      setCreationFailed(true);
      showToast(error instanceof Error ? error.message : '创建充值订单失败', 'error');
    } finally {
      creating.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  // 手动查询复用后台订单通知和余额刷新流程，不等待下一次轮询。
  const checkPayment = async () => {
    if (!order || checkingPayment) return;
    setCheckingPayment(true);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.id);
      if (mounted.current && latest.payStatus === 'WAITING') showToast('暂未查询到付款结果，请稍后再试', 'info');
    } catch (error) {
      if (mounted.current) showToast(error instanceof Error ? error.message : '查询订单状态失败', 'error');
    } finally {
      if (mounted.current) setCheckingPayment(false);
    }
  };

  // 完成本次支付后重新获取可购买套餐，首充商品等状态由服务端决定。
  const resetProducts = () => {
    setOrder(null);
    setQrCode(null);
    setCreationFailed(false);
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      kicker="易标官方API"
      title={isSuccess ? '充值成功' : '充值'}
      description={isSuccess ? 'e点已入账，开始下一份精彩。' : order?.payStatus === 'CLOSED' ? '可重新选择充值套餐。' : undefined}
      cardClassName={`donation-dialog-card official-recharge-dialog${isSuccess ? ' is-success' : ''}`}
      preventClose={submitting}
      actions={(
        <>
          {!order && status === 'error' && (
            <button type="button" className="primary-action" onClick={() => { setStatus('loading'); setAttempt((value) => value + 1); }}>重试</button>
          )}
          <button type="button" className={isSuccess ? 'primary-action donation-submit' : 'secondary-action'} disabled={submitting} onClick={onClose}>{isSuccess ? '完成' : '关闭'}</button>
          {creationFailed && <button type="button" className="secondary-action" onClick={onViewOrders}>查看订单</button>}
          {order?.payStatus === 'WAITING' && (
            <button type="button" className="primary-action donation-submit" disabled={checkingPayment} onClick={() => { void checkPayment(); }}>
              {checkingPayment ? '正在查询…' : '完成付款'}
            </button>
          )}
          {order && order.payStatus !== 'WAITING' && <button type="button" className={isSuccess ? 'secondary-action' : 'primary-action donation-submit'} onClick={resetProducts}>继续充值</button>}
          {!order && status === 'ready' && selected && (
            <button type="button" className="primary-action donation-submit" disabled={submitting} onClick={() => { void createOrder(); }}>
              {submitting ? '正在生成二维码…' : `微信支付 ¥${selected.price}`}
            </button>
          )}
        </>
      )}
    >
      <div className="official-recharge-body" aria-busy={status === 'loading'}>
        {order ? (
          isSuccess ? (
            <div className="official-recharge-success" role="status">
              <div className="official-recharge-success-art" aria-hidden="true">
                <span className="official-recharge-success-orbit" />
                <span className="official-recharge-success-sparks" />
                <span className="official-recharge-success-medal">
                  <svg viewBox="0 0 40 40" fill="none"><path d="m11 20 6 6 13-13" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
              </div>
              <div className="official-recharge-success-credit">
                <span>本次到账</span>
                <p><strong>+{order.totalPoint}</strong><span>e点</span></p>
              </div>
              <div className="official-recharge-success-receipt">
                <span>{order.optionName}</span>
                <span>实付 <strong>¥{order.payPrice}</strong></span>
              </div>
            </div>
          ) : order.payStatus === 'WAITING' && qrCode ? (
            <div className="donation-payment-panel">
              <div className="donation-qr-wrap"><img src={qrCode} alt="微信充值支付二维码" /></div>
              <div className="donation-payment-copy">
                <span>微信扫码支付</span>
                <strong>¥{order.payPrice}</strong>
                <p>{order.optionName} · {order.totalPoint} e点</p>
                <p role="status">正在等待支付结果…</p>
                <small>订单号：{order.orderNo}</small>
              </div>
            </div>
          ) : (
            <div className="donation-expired-panel" role="status">
              <strong>{order.payStatus === 'CLOSED' ? '订单已关闭' : '未获取到支付二维码'}</strong>
              <p>{order.optionName} · ¥{order.payPrice} · {order.totalPoint} e点</p>
              {order.payStatus === 'WAITING' && <button type="button" className="inline-action" onClick={onViewOrders}>查看订单</button>}
            </div>
          )
        ) : status !== 'ready' || options.length === 0 ? (
          <div className="official-recharge-status" role="status">
            {status === 'loading' && <InlineSpinner />}
            {status === 'loading' ? '正在加载商品…' : status === 'error' ? '商品加载失败，请重试' : '暂无可购买商品'}
          </div>
        ) : (
          <fieldset className="official-recharge-products" disabled={submitting}>
            <legend className="sr-only">充值商品</legend>
            {options.map((option) => (
              <label className={`official-recharge-product${selectedId === option.id ? ' is-selected' : ''}`} key={option.id}>
                <input type="radio" name="official-recharge-option" value={option.id} checked={selectedId === option.id} onChange={() => setSelectedId(option.id)} />
                <span className="official-recharge-name">{option.name}</span>
                <span className="official-recharge-price">¥ <strong>{option.price}</strong></span>
                <span className="official-recharge-points">{option.pointValue} e点</span>
              </label>
            ))}
          </fieldset>
        )}
        {creationFailed && <p className="donation-error">未获取到支付二维码，请在订单页确认本次订单状态。</p>}
      </div>
    </AppDialog>
  );
}
