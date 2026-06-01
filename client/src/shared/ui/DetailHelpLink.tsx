import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export interface DetailHelpLinkProps {
  title: string;
  children: ReactNode;
  label?: string;
}

export default function DetailHelpLink({ title, children, label = '详细说明' }: DetailHelpLinkProps) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className="detail-help-link" type="button">{label}</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="detail-help-modal" />
        <Dialog.Content className="detail-help-card">
          <div className="detail-help-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="detail-help-close" type="button" aria-label="关闭详细说明">×</Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="detail-help-body">{children}</div>
          </Dialog.Description>
          <div className="detail-help-actions">
            <Dialog.Close className="primary-action" type="button">知道了</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
