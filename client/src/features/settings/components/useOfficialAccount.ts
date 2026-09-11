import { useEffect, useState } from 'react';
import type { OfficialAccountState } from '../../../shared/types/officialAccount';

// 账户控件和订单页共用同一订阅方式，迟到的初始快照不覆盖新事件。
export function useOfficialAccount() {
  const [account, setAccount] = useState<OfficialAccountState>({ status: 'loading', clientId: '', identityType: null, error: '', email: null, accountId: null, availablePoint: null });
  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = window.yibiao.officialAccount.onStateChanged((state) => {
      receivedEvent = true;
      if (!disposed) setAccount(state);
    });
    void window.yibiao.officialAccount.getState().then((state) => {
      if (!disposed && !receivedEvent) setAccount(state);
    }).catch(() => {
      if (!disposed && !receivedEvent) setAccount((state) => ({ ...state, status: 'signed-out' }));
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return account;
}
