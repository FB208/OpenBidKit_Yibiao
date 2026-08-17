import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

const advertisementImageUrl = 'https://oss.agnet.top/keep/2026/08/13/20260813233857994.png';
const advertisementTargetUrl = 'https://s.markup.com.cn/jl';
const closeDelaySeconds = 8;

interface StartupAdvertisementDialogProps {
  onClosed: () => void;
}

// 软件每次启动时展示固定广告，并在倒计时结束后开放关闭操作。
function StartupAdvertisementDialog({ onClosed }: StartupAdvertisementDialogProps) {
  const [open, setOpen] = useState(true);
  const [remainingSeconds, setRemainingSeconds] = useState(closeDelaySeconds);

  useEffect(() => {
    const closeAvailableAt = Date.now() + closeDelaySeconds * 1000;
    const timer = window.setInterval(() => {
      const nextRemainingSeconds = Math.max(0, Math.ceil((closeAvailableAt - Date.now()) / 1000));
      setRemainingSeconds(nextRemainingSeconds);
      if (nextRemainingSeconds === 0) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  const canClose = remainingSeconds === 0;

  const openAdvertisement = () => {
    void window.yibiao?.openExternal(advertisementTargetUrl);
  };

  const finishClosing = () => {
    setOpen(false);
    onClosed();
  };

  const closeAdvertisement = () => {
    openAdvertisement();
    finishClosing();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && canClose) finishClosing();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="startup-advertisement-modal" />
        <Dialog.Content
          className="startup-advertisement-card"
          onEscapeKeyDown={(event) => !canClose && event.preventDefault()}
          onPointerDownOutside={(event) => !canClose && event.preventDefault()}
        >
          <Dialog.Title className="sr-only">启动广告</Dialog.Title>
          <Dialog.Description className="sr-only">点击广告图片将在系统默认浏览器中打开活动页面。</Dialog.Description>
          <div className="startup-advertisement-scroll">
            <button type="button" className="startup-advertisement-link" onClick={openAdvertisement} aria-label="在浏览器中打开广告页面">
              <img src={advertisementImageUrl} alt="启动广告" />
            </button>
          </div>
          <div className="startup-advertisement-actions">
            <button type="button" className="primary-action" disabled={!canClose} onClick={closeAdvertisement}>
              {canClose ? '关闭广告' : `${remainingSeconds} 秒后可关闭`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default StartupAdvertisementDialog;
