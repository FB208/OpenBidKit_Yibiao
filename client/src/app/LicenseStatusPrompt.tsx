import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { OfflineLicenseActivationDialog } from '../shared/ui';
import type { LicenseRuntimeStatus } from '../shared/types';

const officialDownloadUrl = 'https://github.com/FB208/OpenBidKit_Yibiao';

function getLicenseProblem(status: LicenseRuntimeStatus | null) {
  if (!status) return '';
  if (status.status === 'expired') return '授权已过期';
  if (status.status === 'missing' || status.status === 'refresh_failed') return '未检测到授权文件';
  if (status.status === 'invalid' || status.status === 'invalidated' || status.status === 'machine_mismatch') return '授权已失效';
  if (status.sourceTrusted === false) return '来源不可信';
  return '';
}

function shouldShowPrompt(status: LicenseRuntimeStatus | null) {
  if (!status || status.config?.expirePopupEnabled === false) {
    return false;
  }
  return Boolean(getLicenseProblem(status));
}

function LicenseStatusPrompt() {
  const [licenseStatus, setLicenseStatus] = useState<LicenseRuntimeStatus | null>(null);
  const [offlineLicenseDialogOpen, setOfflineLicenseDialogOpen] = useState(false);

  useEffect(() => {
    let disposed = false;

    const checkLicense = async () => {
      try {
        const initialStatus = await window.yibiao?.license?.getStatus();
        if (disposed || !initialStatus) return;

        if (!shouldShowPrompt(initialStatus)) {
          setLicenseStatus(null);
          return;
        }

        const refreshedStatus = await window.yibiao?.license?.refresh?.().catch(() => null);
        const finalStatus = refreshedStatus || initialStatus;
        if (!disposed) {
          setLicenseStatus(shouldShowPrompt(finalStatus) ? finalStatus : null);
        }
      } catch {
        // 授权提醒不能影响主流程。
      }
    };

    void checkLicense();
    return () => {
      disposed = true;
    };
  }, []);

  const problem = getLicenseProblem(licenseStatus);
  const dismissible = licenseStatus?.config?.expirePopupDismissible !== false;
  const open = Boolean(problem);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dismissible) {
          setLicenseStatus(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="license-status-card" onEscapeKeyDown={(event) => !dismissible && event.preventDefault()} onPointerDownOutside={(event) => !dismissible && event.preventDefault()}>
          <Dialog.Title>客户端授权提醒</Dialog.Title>
          <Dialog.Description>
            当前客户端{problem}，请从官方渠道下载可信客户端：
            <a href={officialDownloadUrl} target="_blank" rel="noreferrer">{officialDownloadUrl}</a>
          </Dialog.Description>
          <div className="license-status-actions">
            <button type="button" className="secondary-action" onClick={() => setOfflineLicenseDialogOpen(true)}>离线激活授权</button>
            {dismissible && (
              <button type="button" className="primary-action" onClick={() => setLicenseStatus(null)}>我知道了</button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <OfflineLicenseActivationDialog
        open={offlineLicenseDialogOpen}
        onOpenChange={setOfflineLicenseDialogOpen}
        onActivated={(status) => setLicenseStatus(shouldShowPrompt(status) ? status : null)}
      />
    </Dialog.Root>
  );
}

export default LicenseStatusPrompt;
