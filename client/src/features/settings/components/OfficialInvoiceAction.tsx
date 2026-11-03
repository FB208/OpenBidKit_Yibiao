import { useEffect, useRef, useState } from 'react';
import type { OfficialInvoiceApplication, OfficialInvoiceInfo, OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, useToast } from '../../../shared/ui';
import { formatFenAsYuan } from './officialDisplay';

const issuedMessages: Record<OfficialInvoiceApplication['mailStatus'], string> = {
  SENT: '该订单已开票，发票已发送至接收邮箱',
  NOT_SENT: '该订单已开票，发票邮件尚未发送',
  FAILED: '该订单已开票，发票邮件发送失败，请联系客服重新发送',
};

/** 检查已保存的开票资料和该订单的申请状态，确认后提交或在驳回后重新提交。 */
export default function OfficialInvoiceAction({ order, isEmailAccount }: { isEmailAccount: boolean; order: OfficialRechargeOrder }) {
  const [info, setInfo] = useState<OfficialInvoiceInfo | null>(null);
  const [rejected, setRejected] = useState<OfficialInvoiceApplication | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // 每次点击重新读取数据库和申请状态，个人资料不要求税号。
  async function open() {
    if (pending.current) return;
    if (!isEmailAccount) {
      showToast('请先在账号处绑定邮箱后再申请开票', 'info');
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const saved = await window.yibiao.officialAccount.getInvoiceInfo();
      if (!active.current) return;
      if (!saved.buyer.trim() || !saved.email.trim() || (saved.titleType === 'enterprise' && !saved.taxNumber.trim())) {
        showToast('请先在“开票信息”中填写完整的开票信息', 'info');
        return;
      }
      if (saved.buyer.trim().length > 200 || (saved.titleType === 'enterprise' && saved.taxNumber.trim().length > 64) || saved.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(saved.email.trim())) {
        showToast('开票信息格式不正确，请先在“开票信息”中检查购买方、公司税号和邮箱', 'error');
        return;
      }
      const application = await window.yibiao.officialAccount.getInvoiceApplication(order.orderNo);
      if (!active.current) return;
      if (application?.status === 'PENDING') {
        showToast('该订单的开票申请正在处理，请耐心等待', 'info');
        return;
      }
      if (application?.status === 'ISSUED') {
        showToast(issuedMessages[application.mailStatus], 'info');
        return;
      }
      setRejected(application);
      setSubmitError('');
      setInfo(saved);
    } catch (error) {
      if (active.current) showToast(error instanceof Error ? error.message : '开票信息读取失败，请重试', 'error');
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  // 关闭弹窗并恢复键盘焦点。
  function close() {
    setInfo(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  // 申请失败保留弹窗；驳回后重新提交带上申请版本。
  async function submit() {
    if (!info || pending.current) return;
    pending.current = true;
    setBusy(true);
    setSubmitError('');
    try {
      await window.yibiao.officialAccount.createInvoiceApplication({
        orderNo: order.orderNo,
        titleType: info.titleType === 'enterprise' ? 'ENTERPRISE' : 'PERSONAL',
        invoiceTitle: info.buyer.trim(),
        taxpayerNo: info.titleType === 'enterprise' ? info.taxNumber.trim() : '',
        receiverEmail: info.email.trim(),
        ...(rejected ? { version: rejected.version } : {}),
      });
      if (!active.current) return;
      close();
      showToast(rejected ? '开票申请已重新提交' : '开票申请已提交', 'success');
    } catch (error) {
      if (active.current) {
        const message = error instanceof Error ? error.message : '开票申请提交失败，请重试';
        setSubmitError(message);
        showToast(message, 'error');
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" className="inline-action" disabled={busy} onClick={() => { void open(); }}>{busy ? '正在处理…' : '开票'}</button>
    {info && <AppDialog open title="申请开票" description={`订单号：${order.orderNo}`} preventClose={busy} onOpenChange={(value) => { if (!value && !busy) close(); }} actions={<>
      <button type="button" className="secondary-action" disabled={busy} onClick={close}>取消</button>
      <button type="button" className="primary-action" disabled={busy} onClick={() => { void submit(); }}>{busy ? '正在提交…' : rejected ? '重新提交' : '提交申请'}</button>
    </>}>
      {rejected && <p role="status">上次申请已驳回{rejected.rejectReason ? `：${rejected.rejectReason}` : ''}。如需修改开票信息，请先到“开票信息”中修改。</p>}
      <dl className="official-order-detail">
        <dt>抬头类型</dt><dd>{info.titleType === 'enterprise' ? '企业' : '个人'}</dd>
        <dt>购买方</dt><dd>{info.buyer.trim()}</dd>
        {info.titleType === 'enterprise' && <><dt>税号</dt><dd>{info.taxNumber.trim()}</dd></>}
        <dt>接收邮箱</dt><dd>{info.email.trim()}</dd>
        <dt>开票金额</dt><dd>¥{formatFenAsYuan(order.payAmountFen)}</dd>
      </dl>
      {submitError && <p role="alert">{submitError}</p>}
    </AppDialog>}
  </>;
}
