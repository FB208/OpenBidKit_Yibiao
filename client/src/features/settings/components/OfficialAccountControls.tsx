import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { OfficialEmailPurpose } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, InputWithAction, useToast } from '../../../shared/ui';
import OfficialRedeemAction from './OfficialRedeemAction';
import OfficialRechargeDialog from './OfficialRechargeDialog';
import { useOfficialAccount } from './useOfficialAccount';

// 展示官方账户及余额，并共用邮箱验证码弹窗完成登陆和绑定。
export default function OfficialAccountControls({ onViewOrders }: { onViewOrders: () => void }) {
  const account = useOfficialAccount();
  const [purpose, setPurpose] = useState<OfficialEmailPurpose | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'submit' | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const rechargeAfterLogin = useRef(false);
  const rechargeButton = useRef<HTMLButtonElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const accountRow = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const { showToast } = useToast();
  const binding = purpose === 'BIND';
  const title = binding ? '绑定邮箱' : '邮箱登陆';

  useEffect(() => {
    if (account.status === 'signed-out') setRechargeOpen(false);
  }, [account.status]);

  useEffect(() => {
    if (!resendAt) return;
    // 以截止时间计算倒计时，切换窗口或休眠后不会累积误差。
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (!remaining) setResendAt(0);
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  // 结束邮箱操作；从充值进入时继续展示商品，取消则回到原入口。
  const closeDialog = (continueToRecharge = false) => {
    const returnToRecharge = rechargeAfterLogin.current;
    rechargeAfterLogin.current = false;
    setPurpose(null);
    setCode('');
    if (continueToRecharge) setRechargeOpen(true);
    else requestAnimationFrame(() => (returnToRecharge ? rechargeButton.current : accountButton.current || accountRow.current)?.focus());
  };

  // 已登录账户直接查看商品，未登录则先完成邮箱登陆。
  const openRecharge = () => {
    if (account.status === 'loading') return;
    if (account.status === 'signed-in') setRechargeOpen(true);
    else {
      rechargeAfterLogin.current = true;
      setCode('');
      setPurpose('LOGIN');
    }
  };

  // 卸载商品弹窗使其请求结果失效，并恢复充值按钮焦点。
  const closeRecharge = () => {
    setRechargeOpen(false);
    requestAnimationFrame(() => rechargeButton.current?.focus());
  };

  // 只验证邮箱字段，获取验证码时不要求用户提前填写验证码。
  const sendEmailCode = async () => {
    if (busy || remainingSeconds || !purpose || !emailInput.current?.reportValidity()) return;
    const normalizedEmail = email.trim().toLowerCase();
    setEmail(normalizedEmail);
    setBusy('send');
    try {
      await window.yibiao.officialAccount.sendEmailCode({ email: normalizedEmail, purpose });
      setRemainingSeconds(60);
      setResendAt(Date.now() + 60000);
      showToast('验证码已发送，请查看邮箱', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '验证码发送失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 登陆和绑定直接生效，不参与设置页的保存草稿。
  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !purpose) return;
    const credentials = { email: email.trim().toLowerCase(), code };
    setEmail(credentials.email);
    setBusy('submit');
    try {
      await (binding
        ? window.yibiao.officialAccount.bindEmail(credentials)
        : window.yibiao.officialAccount.loginWithEmail(credentials));
      showToast(binding ? '邮箱绑定成功' : '登陆成功', 'success');
      closeDialog(rechargeAfterLogin.current && !binding);
    } catch (error) {
      showToast(error instanceof Error ? error.message : `${title}失败`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-copy"><strong>账号</strong></div>
        <div className="official-api-account-row" ref={accountRow} tabIndex={-1}>
          <span className="official-api-account">{account.status === 'signed-in' && account.identityType === 'email' ? account.email : account.clientId || '—'}</span>
          {!(account.status === 'signed-in' && account.identityType === 'email') && (
            <button
              type="button"
              className="inline-action"
              ref={accountButton}
              disabled={account.status === 'loading'}
              onClick={() => { setCode(''); setPurpose(account.identityType === 'anonymous' ? 'BIND' : 'LOGIN'); }}
            >
              {account.status === 'loading' && <InlineSpinner />}
              {account.identityType === 'anonymous' ? '绑定邮箱' : '登陆'}
            </button>
          )}
        </div>
      </div>
      {account.error && <p className="official-api-empty" role="status">{account.error}</p>}
      <div className="settings-row">
        <div className="settings-row-copy"><strong>余额</strong></div>
        <div className="official-api-balance-row">
          <span className="official-api-balance">
            <span className="official-api-balance-value">{account.availablePoint ?? '—'}</span>
            <small>e点</small>
          </span>
          <div className="official-api-balance-actions">
            <button type="button" className="inline-action" ref={rechargeButton} disabled={account.status === 'loading'} onClick={openRecharge}>充值</button>
            <OfficialRedeemAction account={account} />
          </div>
        </div>
      </div>
      {rechargeOpen && <OfficialRechargeDialog onClose={closeRecharge} onViewOrders={() => { closeRecharge(); onViewOrders(); }} />}
      <AppDialog
        open={purpose !== null}
        onOpenChange={(open) => { if (!open) closeDialog(); }}
        title={title}
        description={binding ? '使用邮箱验证码绑定当前账户。' : '使用邮箱验证码登陆官方账户。'}
        cardClassName="official-account-dialog"
        preventClose={busy !== null}
        actions={(
          <>
            <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => closeDialog()}>取消</button>
            <button type="submit" form="official-account-form" className="primary-action" disabled={busy !== null}>
              {busy === 'submit' && <InlineSpinner />}
              {binding ? '绑定邮箱' : '登陆'}
            </button>
          </>
        )}
      >
        <form id="official-account-form" className="official-account-form" onSubmit={submitEmail}>
          <label htmlFor="official-account-email">邮箱</label>
          <input
            id="official-account-email"
            ref={emailInput}
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            placeholder="请输入邮箱地址"
            disabled={busy !== null}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setEmail((value) => value.trim().toLowerCase())}
          />
          <label htmlFor="official-account-code">验证码</label>
          <InputWithAction
            id="official-account-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            placeholder="请输入 6 位数字验证码"
            disabled={busy !== null}
            onChange={(event) => setCode(event.target.value)}
            actionLabel={busy === 'send' ? '发送中…' : remainingSeconds ? `${remainingSeconds} 秒后重发` : '获取验证码'}
            actionDisabled={busy !== null || remainingSeconds > 0}
            onAction={() => { void sendEmailCode(); }}
          />
        </form>
      </AppDialog>
    </>
  );
}
