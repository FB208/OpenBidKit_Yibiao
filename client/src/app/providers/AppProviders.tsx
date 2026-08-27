import type { ReactNode } from 'react';
import { AgentQuestionDialogProvider, AiHttpErrorDialogProvider, DocumentParseNoticeProvider, DonationPromptProvider, ToastProvider } from '../../shared/ui';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <DonationPromptProvider>
        <AgentQuestionDialogProvider>
          <AiHttpErrorDialogProvider>
            <DocumentParseNoticeProvider>{children}</DocumentParseNoticeProvider>
          </AiHttpErrorDialogProvider>
        </AgentQuestionDialogProvider>
      </DonationPromptProvider>
    </ToastProvider>
  );
}

export default AppProviders;
