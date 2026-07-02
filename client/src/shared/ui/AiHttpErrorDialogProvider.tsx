import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AiHttpErrorPayload } from '../types';
import { useToast } from './ToastProvider';

function isHtmlPayload(error: AiHttpErrorPayload | null) {
  if (!error?.body) return false;
  const contentType = String(error.contentType || '').toLowerCase();
  if (contentType.includes('html')) return true;
  return /<!doctype\s+html|<html[\s>]/i.test(error.body);
}

function formatTitle(error: AiHttpErrorPayload | null) {
  if (!error?.status) return 'AI 服务商返回错误';
  return `AI 服务商返回 HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''} 错误`;
}

function formatSource(source?: string) {
  if (!source) return 'AI 服务';
  if (source === 'text-model') return '文本模型';
  if (source === 'google-image-model') return 'Google 生图模型';
  if (source === 'openai-compatible-image-model') return '生图模型';
  if (source === 'opencode-agent') return 'OpenCode Agent';
  return source;
}

export function AiHttpErrorDialogProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<AiHttpErrorPayload[]>([]);
  const currentError = errors[0] || null;
  const { showToast } = useToast();
  const htmlPayload = useMemo(() => isHtmlPayload(currentError), [currentError]);

  useEffect(() => {
    const unsubscribe = window.yibiao?.ai?.onHttpError?.((event) => {
      setErrors((prev) => [...prev, { ...event, body: String(event.body || '') }]);
    });

    return () => unsubscribe?.();
  }, []);

  const closeCurrent = useCallback(() => {
    setErrors((prev) => prev.slice(1));
  }, []);

  const copyRawBody = useCallback(() => {
    const body = currentError?.body || '';
    if (!body) {
      showToast('当前错误没有原始返回内容', 'info');
      return;
    }

    void navigator.clipboard.writeText(body)
      .then(() => showToast('原始返回内容已复制', 'success'))
      .catch(() => showToast('复制失败，请手动选择内容复制', 'error'));
  }, [currentError?.body, showToast]);

  return (
    <>
      {children}
      <Dialog.Root open={Boolean(currentError)} onOpenChange={(open) => { if (!open) closeCurrent(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="ai-http-error-modal" />
          <Dialog.Content className="ai-http-error-card">
            <div className="ai-http-error-head">
              <div>
                <span>{formatSource(currentError?.source)}</span>
                <Dialog.Title>{formatTitle(currentError)}</Dialog.Title>
              </div>
              <Dialog.Close className="ai-http-error-close" type="button" aria-label="关闭错误详情">×</Dialog.Close>
            </div>
            <Dialog.Description className="ai-http-error-description">
              这是 AI 服务商返回的原始错误内容。HTTP 请求未成功，客户端没有继续解析该响应。
            </Dialog.Description>
            <div className="ai-http-error-meta">
              {currentError?.contentType && <span>{currentError.contentType}</span>}
              {currentError?.createdAt && <span>{new Date(currentError.createdAt).toLocaleString('zh-CN')}</span>}
              {errors.length > 1 && <span>还有 {errors.length - 1} 个错误待查看</span>}
            </div>
            <div className="ai-http-error-preview">
              {htmlPayload ? (
                <iframe
                  title="AI 服务商原始错误页"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={currentError?.body || ''}
                />
              ) : (
                <pre>{currentError?.body || '服务商未返回响应正文。'}</pre>
              )}
            </div>
            <div className="ai-http-error-actions">
              <button type="button" className="secondary-action" onClick={copyRawBody}>复制原始返回</button>
              <Dialog.Close type="button" className="primary-action">关闭</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export default AiHttpErrorDialogProvider;
