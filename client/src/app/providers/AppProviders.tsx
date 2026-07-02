import type { ReactNode } from 'react';
import { AiHttpErrorDialogProvider, DocumentParseNoticeProvider, ToastProvider } from '../../shared/ui';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <AiHttpErrorDialogProvider>
        <DocumentParseNoticeProvider>{children}</DocumentParseNoticeProvider>
      </AiHttpErrorDialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
