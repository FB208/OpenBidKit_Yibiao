import * as Toast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick?: () => void | Promise<void>;
  close?: boolean;
  variant?: 'primary' | 'secondary';
}

export interface ToastOptions {
  title?: string;
  duration?: number;
  persistent?: boolean;
  actions?: ToastAction[];
}

interface ToastItem {
  id: number;
  title?: string;
  message: string;
  type: ToastType;
  duration: number;
  actions?: ToastAction[];
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, options?: ToastOptions) => number;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastId = 0;

const toastTitleMap: Record<ToastType, string> = {
  success: '完成',
  error: '出错了',
  info: '提示',
};

const getToastDuration = (type: ToastType) => (type === 'error' ? 5000 : 2000);
const persistentToastDuration = 2147483647;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info', options: ToastOptions = {}) => {
    const id = ++toastId;
    setToasts((prev) => [
      ...prev,
      {
        id,
        title: options.title,
        message,
        type,
        duration: options.persistent ? persistentToastDuration : options.duration || getToastDuration(type),
        actions: options.actions,
      },
    ]);
    return id;
  }, []);

  const handleActionClick = useCallback((item: ToastItem, action: ToastAction) => {
    const shouldClose = action.close !== false;
    try {
      const result = action.onClick?.();
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>)
          .catch((error) => console.warn('Toast 操作执行失败', error))
          .finally(() => {
            if (shouldClose) {
              dismissToast(item.id);
            }
          });
        return;
      }
    } catch (error) {
      console.warn('Toast 操作执行失败', error);
    }

    if (shouldClose) {
      dismissToast(item.id);
    }
  }, [dismissToast]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((item) => (
          <Toast.Root
            className={`app-toast is-${item.type}${item.actions?.length ? ' has-actions' : ''}`}
            duration={item.duration}
            key={item.id}
            onOpenChange={(open) => {
              if (!open) {
                dismissToast(item.id);
              }
            }}
          >
            <Toast.Title className="app-toast-title">{item.title || toastTitleMap[item.type]}</Toast.Title>
            <Toast.Description className="app-toast-description">{item.message}</Toast.Description>
            {item.actions?.length ? (
              <div className="app-toast-actions">
                {item.actions.map((action) => (
                  <button
                    type="button"
                    className={`app-toast-action is-${action.variant || 'secondary'}`}
                    key={action.label}
                    onClick={() => handleActionClick(item, action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
            <Toast.Close className="app-toast-close" aria-label="关闭提示">×</Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className="app-toast-viewport" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }

  return context;
}
