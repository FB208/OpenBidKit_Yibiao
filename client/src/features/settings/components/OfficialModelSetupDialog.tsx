import { ArrowRightIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { AppDialog } from '../../../shared/ui';
import type { TextModelSetupReason } from '../types';

// 在当前页面引导用户选择官方服务或自行配置模型。
export default function OfficialModelSetupDialog({ reason, onClose, onRecharge, onConfigure }: {
  reason: TextModelSetupReason;
  onClose: () => void;
  onRecharge: () => void;
  onConfigure: () => void;
}) {
  const startup = reason === 'startup';

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={startup ? '设置 AI 文本模型' : '官方 API 余额不足'}
      cardClassName="official-model-setup-dialog"
    >
      <div className="official-model-setup-choices">
        <button className="official-model-setup-official" type="button" onClick={onRecharge}>
          <span>
            <strong>{startup ? '没有 API Key 也能用' : '继续使用官方 API'}</strong>
            <small>易标官方 API · 充值即用</small>
          </span>
          <span className="official-model-setup-arrow" aria-hidden="true"><ArrowRightIcon /></span>
        </button>
        <button className="official-model-setup-custom" type="button" onClick={onConfigure}>
          已有 API Key，自己配置
          <ChevronRightIcon aria-hidden="true" />
        </button>
        <button className="text-button official-model-setup-later" type="button" onClick={onClose}>稍后设置</button>
      </div>
    </AppDialog>
  );
}
