import type { ReactNode } from 'react';
import { AgentQuestionDialogProvider, AiHttpErrorDialogProvider, DocumentParseNoticeProvider, ToastProvider } from '../../shared/ui';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <AgentQuestionDialogProvider>
        <AiHttpErrorDialogProvider>
          <DocumentParseNoticeProvider>{children}</DocumentParseNoticeProvider>
        </AiHttpErrorDialogProvider>
      </AgentQuestionDialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
