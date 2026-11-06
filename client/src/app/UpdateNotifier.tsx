import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import NoticeMediaContent from '../features/notice/components/NoticeMediaContent';
import { useAutomaticNotice } from '../features/notice/hooks/useAutomaticNotice';
import { ImagePreviewDialog, MarkdownFullscreenViewer, MarkdownRenderer, useToast, type PreviewImage } from '../shared/ui';
import type { PluginUpdateInfo } from '../shared/types/ipc';
import { hasPromptedUpdate, showUpdateReadyToast } from '../shared/updateToast';

const updatePollIntervalMs = 30 * 60 * 1000;

declare global {
  interface Window {
    __yibiaoCheckRemoteNotice?: () => void;
  }
}

interface UpdateNotifierProps {
  noticeEnabled: boolean;
}

// 软件／插件更新保持原流程，自动公告使用统一的类型与媒体准备入口。
function UpdateNotifier({ noticeEnabled }: UpdateNotifierProps) {
  const { showToast, dismissToast } = useToast();
  const updateCheckingRef = useRef(false);
  const pluginUpdateRunningRef = useRef(false);
  const promptedPluginUpdatesRef = useRef(new Set<string>());
  const { notice: remoteNotice, prepared, remainingSeconds, closing, close } = useAutomaticNotice(noticeEnabled);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  // 切换或关闭公告时同时收起旧正文的图片预览。
  useEffect(() => { setPreviewImage(null); }, [remoteNotice?.id]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

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

    void checkUpdate();
    if (!disposed) {
      timer = window.setInterval(() => {
        void checkUpdate();
      }, updatePollIntervalMs);
    }

    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      unsubscribePluginUpdates?.();
    };
  }, [dismissToast, showToast]);

  return (
    <Dialog.Root
      open={noticeEnabled && Boolean(remoteNotice)}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="remote-notice-modal" />
        <Dialog.Content
          className={`remote-notice-card${remoteNotice?.noticeType === 'image' ? ' remote-notice-card--media' : ''}`}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className={remoteNotice?.noticeType === 'image' ? 'sr-only' : 'remote-notice-title'}>{remoteNotice?.title || '公告'}</Dialog.Title>
          {/* 图片公告只展示媒体，标题保留给屏幕阅读器。 */}
          <Dialog.Description className="sr-only">远程公告</Dialog.Description>
          {remoteNotice?.noticeType !== 'image' && remoteNotice?.updatedAt ? <div className="remote-notice-time">公告时间：{remoteNotice.updatedAt}</div> : null}
          {remoteNotice?.noticeType === 'image' ? (
            <NoticeMediaContent key={remoteNotice.id} media={remoteNotice.media} title={remoteNotice.title} prepared={prepared} />
          ) : (
          <MarkdownFullscreenViewer className="markdown-viewer remote-notice-content" fullscreenClassName="markdown-viewer" title={`${remoteNotice?.title || '公告'}全屏查看`}>
            <MarkdownRenderer
              allowRawHtml={false}
              imageMode="preview"
              imageClassName="remote-notice-image"
              onPreviewImage={(src, alt) => setPreviewImage({ src, alt: alt || '公告图片' })}
            >
              {remoteNotice?.content || ''}
            </MarkdownRenderer>
          </MarkdownFullscreenViewer>
          )}
          <div className="remote-notice-actions">
            <button className="primary-action" type="button" disabled={remainingSeconds !== 0 || closing} onClick={() => { void close().catch((error) => showToast(error instanceof Error ? error.message : '关闭公告失败', 'error')); }}>
              {remainingSeconds > 0 ? `${remainingSeconds} 秒后可关闭` : remoteNotice?.noticeType === 'image' ? '关闭公告' : '知道了'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
    </Dialog.Root>
  );
}

export default UpdateNotifier;
