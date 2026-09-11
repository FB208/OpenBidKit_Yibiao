import { useEffect, useRef, useState } from 'react';
import type { OfficialInvoiceInfo, OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, useToast } from '../../../shared/ui';

/** 检查已保存的开票资料，填写备注后提交单笔订单申请。 */
export default function OfficialInvoiceAction({ order, isEmailAccount, onSubmitted }: { isEmailAccount: boolean; order: OfficialRechargeOrder; onSubmitted: () => void }) {
  const [info, setInfo] = useState<OfficialInvoiceInfo | null>(null);
  const [remark, setRemark] = useState('');
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

  // 每次点击重新读取数据库，个人资料不要求税号。
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
      setRemark('');
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

  // 申请失败保留备注，成功后刷新订单列表。
  async function submit() {
    if (!info || pending.current) return;
    pending.current = true;
    setBusy(true);
    setSubmitError('');
    try {
      await window.yibiao.officialAccount.createInvoiceApplication({
        rechargeOrderId: order.id,
        titleType: info.titleType === 'enterprise' ? 'ENTERPRISE' : 'PERSONAL',
        invoiceTitle: info.buyer.trim(),
        taxpayerNo: info.titleType === 'enterprise' ? info.taxNumber.trim() : '',
        receiverEmail: info.email.trim(),
        remark: remark.trim(),
      });
      if (!active.current) return;
      close();
      showToast('开票申请已提交', 'success');
      onSubmitted();
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
      <button type="button" className="primary-action" disabled={busy} onClick={() => { void submit(); }}>{busy ? '正在提交…' : '提交申请'}</button>
    </>}>
      <label className="settings-row official-invoice-remark">
        <div className="settings-row-copy"><strong>备注（可空）</strong><span>最多 500 字</span></div>
        <textarea value={remark} maxLength={500} rows={4} disabled={busy} onChange={(event) => setRemark(event.target.value)} />
      </label>
      {submitError && <p role="alert">{submitError}</p>}
    </AppDialog>}
  </>;
}
