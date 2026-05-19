import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import { dismissRemoteNotice, fetchRemoteNotice, hasDismissedRemoteNotice, type RemoteNotice } from '../shared/remoteNotice';
import { MarkdownRenderer, useToast } from '../shared/ui';
import { hasPromptedUpdate, showUpdateReadyToast } from '../shared/updateToast';

const updatePollIntervalMs = 30 * 60 * 1000;
const noticeLogPrefix = '[remote-notice]';

declare global {
  interface Window {
    __yibiaoCheckRemoteNotice?: () => void;
  }
}

function UpdateNotifier() {
  const { showToast } = useToast();
  const updateCheckingRef = useRef(false);
  const activeNoticeIdRef = useRef('');
  const [remoteNotice, setRemoteNotice] = useState<RemoteNotice | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);

  const noticeMarkdownComponents: Components = {
    img({ src, alt, ...props }) {
      const imageSrc = String(src || '');
      const imageAlt = String(alt || '公告图片');
      return (
        <img
          {...props}
          src={imageSrc}
          alt={imageAlt}
          className="remote-notice-image"
          role="button"
          tabIndex={0}
          title="点击放大查看"
          onClick={() => imageSrc && setPreviewImage({ src: imageSrc, alt: imageAlt })}
          onKeyDown={(event) => {
            if (!imageSrc || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            setPreviewImage({ src: imageSrc, alt: imageAlt });
          }}
        />
      );
    },
  };

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
    };
  }, [showToast]);

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
          <div className="remote-notice-content">
            <MarkdownRenderer allowRawHtml={false} components={noticeMarkdownComponents}>{remoteNotice?.content || ''}</MarkdownRenderer>
          </div>
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
