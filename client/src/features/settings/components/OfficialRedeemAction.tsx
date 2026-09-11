import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { OfficialAccountState } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';

// 邮箱账户兑换点数；同一账户、同一兑换码失败重试时沿用请求号。
export default function OfficialRedeemAction({ account }: { account: OfficialAccountState }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = useRef(new Map<string, string>());
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { showToast } = useToast();

  // 关闭弹窗并恢复入口焦点。
  function close() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  // 在用户入口检查邮箱登录状态。
  function show() {
    if (account.status !== 'signed-in' || account.identityType !== 'email') {
      showToast(account.identityType === 'anonymous' ? '请先在账号处绑定邮箱后再兑换' : '请先登录邮箱账户后再兑换', 'info');
      return;
    }
    setError('');
    setOpen(true);
  }

  // 校验兑换码后提交一次；失败保留输入，成功由 Main 广播最新余额。
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const normalized = code.trim().toUpperCase();
    setCode(normalized);
    if (!/^[A-Z0-9_-]{1,64}$/.test(normalized)) {
      setError('兑换码只能包含 1～64 位字母、数字、下划线和横线');
      return;
    }
    const key = `${account.accountId}:${normalized}`;
    const requestNo = requests.current.get(key) || crypto.randomUUID();
    requests.current.set(key, requestNo);
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await window.yibiao.officialAccount.redeemCode({ code: normalized, requestNo });
      requests.current.delete(key);
      setCode('');
      close();
      showToast(`兑换成功，获得 ${result.redeemedPoint} 点`, 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '兑换失败，请重试';
      setError(message);
      showToast(message, 'error');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="inline-action" ref={trigger} disabled={account.status === 'loading' || busy} onClick={show}>兑换</button>
    <AppDialog open={open} title="兑换码兑换" description="输入兑换码，为当前邮箱账户增加点数。" cardClassName="official-account-dialog" preventClose={busy} onOpenChange={(value) => { if (!value && !pending.current) close(); }} actions={<>
      <button type="button" className="secondary-action" disabled={busy} onClick={close}>取消</button>
      <button type="submit" form="official-redeem-form" className="primary-action" disabled={busy}>{busy && <InlineSpinner />}{busy ? '正在兑换…' : '兑换'}</button>
    </>}>
      <form id="official-redeem-form" className="official-account-form" onSubmit={submit}>
        <label htmlFor="official-redeem-code">兑换码</label>
        <input id="official-redeem-code" value={code} disabled={busy} autoComplete="off" spellCheck={false} placeholder="请输入兑换码" aria-invalid={!!error} aria-describedby={error ? 'official-redeem-error' : undefined} onChange={(event) => { setCode(event.target.value); setError(''); }} />
        {error && <p id="official-redeem-error" role="alert">{error}</p>}
      </form>
    </AppDialog>
  </>;
}
