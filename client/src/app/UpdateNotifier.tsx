import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { dismissRemoteNotice, fetchRemoteNotice, hasDismissedRemoteNotice, type RemoteNotice } from '../shared/remoteNotice';
import { MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../shared/ui';
import type { PluginUpdateInfo } from '../shared/types/ipc';
import { hasPromptedUpdate, showUpdateReadyToast } from '../shared/updateToast';

const updatePollIntervalMs = 30 * 60 * 1000;
const noticeLogPrefix = '[remote-notice]';

declare global {
  interface Window {
    __yibiaoCheckRemoteNotice?: () => void;
  }
}

function UpdateNotifier() {
  const { showToast, dismissToast } = useToast();
  const updateCheckingRef = useRef(false);
  const pluginUpdateRunningRef = useRef(false);
  const activeNoticeIdRef = useRef('');
  const promptedPluginUpdatesRef = useRef(new Set<string>());
  const [remoteNotice, setRemoteNotice] = useState<RemoteNotice | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);

  const closeRemoteNotice = () => {
    if (remoteNotice?.id) {
      dismissRemoteNotice(remoteNotice.id);
    }
    activeNoticeIdRef.current = '';
    setPreviewImage(null);
    setRemoteNotice(null);
  };

  useEffect(() => {
    let disposed = false;

    const promptPluginUpdates = (updates: PluginUpdateInfo[]) => {
      if (disposed || updates.length === 0) return;
      const signature = updates
        .map((plugin) => `${plugin.id}@${plugin.version}`)
        .sort()
        .join('|');
      if (promptedPluginUpdatesRef.current.has(signature)) return;
      promptedPluginUpdatesRef.current.add(signature);

      const pluginSummary = updates
        .map((plugin) => `${plugin.name} ${plugin.installedVersion} → ${plugin.version}`)
        .join('；');
      showToast(`发现 ${updates.length} 个插件可升级：${pluginSummary}`, 'info', {
        title: '插件更新可用',
        persistent: true,
        actions: [
          {
            label: '升级全部',
            variant: 'primary',
            onClick: async () => {
              if (pluginUpdateRunningRef.current) return;
              pluginUpdateRunningRef.current = true;
              const progressToastId = showToast(`正在升级 ${updates.length} 个插件，请稍候...`, 'info', {
                title: '正在升级插件',
                persistent: true,
              });
              try {
                const result = await window.yibiao?.plugins.updateAll();
                dismissToast(progressToastId);
                window.dispatchEvent(new Event('yibiao:plugins-changed'));
                if (!result || result.results.length === 0) {
                  showToast('插件已是最新版本', 'success');
                  return;
                }

                const succeeded = result.results.filter((item) => item.success);
                const failed = result.results.filter((item) => !item.success);
                if (failed.length === 0) {
                  showToast(`已成功升级 ${succeeded.length} 个插件，无需重启软件。`, 'success');
                  return;
                }

                const failedNames = failed.map((item) => item.name).join('、');
                showToast(`成功 ${succeeded.length} 个，失败 ${failed.length} 个：${failedNames}`, 'error', {
                  title: '插件升级完成',
                });
              } catch (error) {
                dismissToast(progressToastId);
                window.dispatchEvent(new Event('yibiao:plugins-changed'));
                showToast(error instanceof Error ? error.message : '批量升级插件失败', 'error');
              } finally {
                pluginUpdateRunningRef.current = false;
              }
            },
          },
          { label: '稍后' },
        ],
      });
    };

    const unsubscribePluginUpdates = window.yibiao?.onPluginUpdatesAvailable(promptPluginUpdates);

    const checkUpdate = async () => {
      if (updateCheckingRef.current) {
        return;
      }
      updateCheckingRef.current = true;
      try {
        const result = await window.yibiao?.checkUpdate();
        if (!result?.enabled) {
          return;
        }
        if (disposed || !result.updateAvailable || !result.downloaded || !result.version) {
          return;
        }
        if (hasPromptedUpdate(result.version)) {
          return;
        }
        showUpdateReadyToast(showToast, result.version);
      } catch {
        // 自动检查失败不打扰用户，手动检查入口会展示错误。
      } finally {
        updateCheckingRef.current = false;
      }
    };

    const checkRemoteNotice = async () => {
      try {
        console.info(noticeLogPrefix, 'check start');
        const notice = await fetchRemoteNotice();
        const dismissed = notice ? hasDismissedRemoteNotice(notice.id) : false;
        console.info(noticeLogPrefix, 'check result', {
          disposed,
          noticeId: notice?.id || null,
          dismissed,
          activeNoticeId: activeNoticeIdRef.current,
        });

        if (disposed || !notice || dismissed) {
          return;
        }
        if (activeNoticeIdRef.current === notice.id) {
          console.info(noticeLogPrefix, 'skip: notice already active', notice.id);
          return;
        }

        activeNoticeIdRef.current = notice.id;
        console.info(noticeLogPrefix, 'show notice', notice.id);
        setRemoteNotice(notice);
      } catch (error) {
        // 公告检查失败不打扰用户。
        console.info(noticeLogPrefix, 'check failed', error);
      }
    };

    const checkAll = () => {
      void checkUpdate();
      void checkRemoteNotice();
    };

    let timer: number | undefined;
    window.__yibiaoCheckRemoteNotice = () => {
      void checkRemoteNotice();
    };
    checkAll();
    if (!disposed) {
      timer = window.setInterval(() => {
        checkAll();
      }, updatePollIntervalMs);
    }

    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      if (window.__yibiaoCheckRemoteNotice) {
        delete window.__yibiaoCheckRemoteNotice;
      }
      unsubscribePluginUpdates?.();
    };
  }, [dismissToast, showToast]);

  return (
    <Dialog.Root
      open={Boolean(remoteNotice)}
      onOpenChange={(open) => {
        if (!open && remoteNotice) {
          closeRemoteNotice();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="remote-notice-modal" />
        <Dialog.Content className="remote-notice-card">
          <Dialog.Title className="remote-notice-title">{remoteNotice?.title || '公告'}</Dialog.Title>
          <Dialog.Description className="sr-only">远程公告</Dialog.Description>
          {remoteNotice?.updatedAt ? <div className="remote-notice-time">公告时间：{remoteNotice.updatedAt}</div> : null}
          <MarkdownFullscreenViewer className="remote-notice-content" fullscreenClassName="markdown-viewer" title={`${remoteNotice?.title || '公告'}全屏查看`}>
            <MarkdownRenderer
              allowRawHtml={false}
              imageMode="preview"
              imageClassName="remote-notice-image"
              onPreviewImage={(src, alt) => setPreviewImage({ src, alt: alt || '公告图片' })}
            >
              {remoteNotice?.content || ''}
            </MarkdownRenderer>
          </MarkdownFullscreenViewer>
          <div className="remote-notice-actions">
            <button className="primary-action" type="button" onClick={closeRemoteNotice}>知道了</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="remote-notice-preview-modal" />
          <Dialog.Content className="remote-notice-preview-card">
            <Dialog.Title className="sr-only">{previewImage?.alt || '公告图片预览'}</Dialog.Title>
            <Dialog.Description className="sr-only">查看公告中的图片大图。</Dialog.Description>
            <button className="remote-notice-preview-close" type="button" aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}>×</button>
            {previewImage ? <img src={previewImage.src} alt={previewImage.alt} /> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Dialog.Root>
  );
}

export default UpdateNotifier;
