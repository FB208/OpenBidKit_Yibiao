import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPageRequest, TextModelSetupReason } from '../features/settings/types';
import type { SectionId } from '../shared/types/navigation';
import type { OfficialAccountState } from '../shared/types/officialAccount';
import { useToast } from '../shared/ui';

// 同一轮并发请求会集中返回余额不足，冷却期内只弹出一次。
const BALANCE_PROMPT_COOLDOWN_MS = 5 * 60 * 1000;

function parseAvailablePoint(state: OfficialAccountState) {
  return state.availablePoint === null ? Number.NaN : Number(state.availablePoint);
}

// 官方余额不足时在原页面显示引导，选择自行配置才跳到文本模型设置。
export function useTextModelSetupRedirect(requestSectionChange: (section: SectionId) => Promise<boolean>) {
  const [settingsRequest, setSettingsRequest] = useState<SettingsPageRequest | null>(null);
  const [setupDialog, setSetupDialog] = useState<TextModelSetupReason | 'recharge' | null>(null);
  const { showToast } = useToast();
  const redirectRef = useRef<(request: SettingsPageRequest) => void>(() => undefined);

  // 跳转使用应用最新的离页检查，且在设置页挂载时已带上目标分类。
  useEffect(() => {
    redirectRef.current = (request) => {
      setSettingsRequest(request);
      void requestSectionChange('settings').then((allowed) => {
        if (!allowed) setSettingsRequest(null);
      });
    };
  });

  useEffect(() => {
    let disposed = false;
    let balanceRedirectAt = 0;
    let startupBalanceCheck = false;
    let accountEventReceived = false;
    let latestAccount: OfficialAccountState | null = null;
    let lastAvailablePoint = Number.NaN;

    const openForBalance = (reason: TextModelSetupReason) => {
      if (disposed || Date.now() - balanceRedirectAt < BALANCE_PROMPT_COOLDOWN_MS) return;
      balanceRedirectAt = Date.now();
      setSetupDialog((current) => current ?? reason);
    };

    // 启动余额只判断一次；未登录或余额未知时不跳转，由联网提示和账户页处理。
    const checkStartupBalance = () => {
      if (!startupBalanceCheck || !latestAccount || latestAccount.status === 'loading') return;
      startupBalanceCheck = false;
      if (latestAccount.status === 'signed-in' && parseAvailablePoint(latestAccount) <= 0) openForBalance('startup');
    };

    const handleAccountState = (state: OfficialAccountState) => {
      const availablePoint = parseAvailablePoint(state);
      // 充值或兑换到账后余额上升，允许下一次余额不足重新跳转。
      if (availablePoint > lastAvailablePoint) balanceRedirectAt = 0;
      if (Number.isFinite(availablePoint)) lastAvailablePoint = availablePoint;
      latestAccount = state;
      checkStartupBalance();
    };

    const unsubscribeAccount = window.yibiao.officialAccount.onStateChanged((state) => {
      accountEventReceived = true;
      handleAccountState(state);
    });
    void window.yibiao.officialAccount.getState().then((state) => {
      if (!disposed && !accountEventReceived) handleAccountState(state);
    }).catch(() => undefined);
    const unsubscribeBalance = window.yibiao.ai.onBalanceInsufficient(() => {
      if (latestAccount?.status !== 'signed-out') openForBalance('balance-insufficient');
    });

    void window.yibiao.config.load()
      .then((config) => {
        if (disposed) return;
        if (config.text_model_provider === 'official') {
          startupBalanceCheck = true;
          checkStartupBalance();
        } else if (!config.api_key || !config.model_name || !config.base_url) {
          showToast('文本模型尚未配置，请先完成设置', 'info');
          redirectRef.current({ tab: 'text-model' });
        }
      })
      .catch((error) => console.warn('读取文本模型配置失败', error));

    return () => {
      disposed = true;
      unsubscribeAccount();
      unsubscribeBalance();
    };
  }, []);

  const clearSettingsRequest = useCallback(() => setSettingsRequest(null), []);
  const dismissSetup = useCallback(() => setSetupDialog(null), []);
  const configureTextProvider = () => {
    dismissSetup();
    redirectRef.current({ tab: 'text-model', focusTextProvider: true });
  };

  // 订单在当前使用官方 API 的模型设置中查看。
  const viewOfficialOrders = async () => {
    dismissSetup();
    try {
      const config = await window.yibiao.config.load();
      redirectRef.current({
        tab: config.text_model_provider === 'official' ? 'text-model' : 'image-model',
        showOfficialOrders: true,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开订单页失败', 'error');
    }
  };

  return {
    settingsRequest, clearSettingsRequest, setupDialog, dismissSetup, configureTextProvider, viewOfficialOrders,
    openSetupRecharge: () => setSetupDialog('recharge'),
  };
}
