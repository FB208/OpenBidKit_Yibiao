import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useToast } from '../shared/ui';

function GpuHardwareAccelerationPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      const status = await window.yibiao?.getGpuHardwareAccelerationStatus();
      if (!status || cancelled) {
        return;
      }

      if (status.trial && status.currentEnabled) {
        setOpen(true);
      }
    };

    void loadStatus().catch((error) => console.warn('读取 GPU 硬件加速状态失败', error));

    return () => {
      cancelled = true;
    };
  }, []);

  const saveEnabled = async () => {
    try {
      setBusy(true);
      await window.yibiao?.saveGpuHardwareAccelerationPreference(true);
      setOpen(false);
      showToast('GPU 硬件加速已启用', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GPU 硬件加速配置保存失败';
      showToast(message, 'error');
      setBusy(false);
    }
  };

  const disableAndRestart = async () => {
    try {
      setBusy(true);
      await window.yibiao?.relaunchWithGpuHardwareAccelerationDisabled();
    } catch (error) {
      const message = error instanceof Error ? error.message : '切回兼容模式失败';
      setBusy(false);
      showToast(message, 'error');
    }
  };

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="content-regenerate-card gpu-acceleration-card">
          <Dialog.Title>GPU 硬件加速显示正常吗？</Dialog.Title>
          <Dialog.Description className="gpu-acceleration-copy">
            如果当前界面显示正常，请保存启用。
            <br />
            如果出现白屏或闪退，手动重启一下即可回到兼容模式。
          </Dialog.Description>
          <div className="gpu-acceleration-actions">
            <button type="button" className="primary-action" onClick={saveEnabled} disabled={busy}>
              保存启用
            </button>
            <button type="button" className="secondary-action" onClick={disableAndRestart} disabled={busy}>
              不启用并重启
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default GpuHardwareAccelerationPrompt;
