import type { ReactNode } from 'react';
import { DocumentParseNoticeProvider, ToastProvider } from '../../shared/ui';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <DocumentParseNoticeProvider>{children}</DocumentParseNoticeProvider>
    </ToastProvider>
  );
}

export default AppProviders;
