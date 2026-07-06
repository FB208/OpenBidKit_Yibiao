import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { LicenseOfflineActivationResult, LicenseRuntimeStatus } from '../types';
import { useToast } from './ToastProvider';

interface OfflineLicenseActivationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActivated?: (status: LicenseRuntimeStatus) => void;
}

type BusyAction = 'file' | 'code' | null;

function OfflineLicenseActivationDialog({ open, onOpenChange, onActivated }: OfflineLicenseActivationDialogProps) {
  const [clientId, setClientId] = useState('');
  const [licenseCode, setLicenseCode] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void window.yibiao?.config.load()
      .then((config) => {
        if (!disposed) {
          setClientId(config?.analytics_client_id || '');
        }
      })
      .catch(() => {
        if (!disposed) {
          setClientId('');
        }
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const handleActivationResult = (result: LicenseOfflineActivationResult | undefined) => {
    if (!result) {
      throw new Error('离线授权激活未返回结果');
    }
    if (result.canceled) {
      showToast(result.message || '已取消选择', 'info');
      return;
    }
    if (!result.success) {
      showToast(result.message || '离线授权激活失败', 'error');
      return;
    }
    showToast(result.message || '离线授权已激活', 'success');
    onActivated?.(result.status);
    onOpenChange(false);
    setLicenseCode('');
  };

  const importOfflineFile = async () => {
    if (busyAction) return;
    try {
      setBusyAction('file');
      const result = await window.yibiao?.license.importOfflineFile();
      handleActivationResult(result);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入离线授权文件失败', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const activateOfflineCode = async () => {
    if (busyAction) return;
    if (!licenseCode.trim()) {
      showToast('请先粘贴离线授权码', 'info');
      return;
    }
    try {
      setBusyAction('code');
      const result = await window.yibiao?.license.activateOfflineCode(licenseCode);
      handleActivationResult(result);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '离线授权码激活失败', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const copyClientId = async () => {
    if (!clientId) {
      showToast('当前 Client ID 仍在读取中', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(clientId);
      showToast('Client ID 已复制', 'success');
    } catch {
      showToast('复制失败，请手动选择 Client ID', 'error');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="offline-license-dialog">
          <Dialog.Title>离线激活授权</Dialog.Title>
          <div className="offline-license-client">
            <span>当前 Client ID</span>
            <code>{clientId || '读取中...'}</code>
            <button type="button" className="secondary-action" onClick={copyClientId}>复制</button>
          </div>
          <div className="offline-license-import">
            <button type="button" className="primary-action" onClick={importOfflineFile} disabled={Boolean(busyAction)}>
              {busyAction === 'file' ? '导入中...' : '导入授权文件'}
            </button>
          </div>
          <label className="offline-license-code-field">
            <span>离线授权码</span>
            <textarea value={licenseCode} onChange={(event) => setLicenseCode(event.target.value)} placeholder="粘贴 Dashboard 生成的离线授权码" />
          </label>
          <div className="offline-license-actions">
            <Dialog.Close asChild>
              <button type="button" className="secondary-action" disabled={Boolean(busyAction)}>取消</button>
            </Dialog.Close>
            <button type="button" className="primary-action" onClick={activateOfflineCode} disabled={Boolean(busyAction)}>
              {busyAction === 'code' ? '激活中...' : '激活授权码'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default OfflineLicenseActivationDialog;
