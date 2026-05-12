import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import type { SectionId } from '../shared/types/navigation';
import Sidebar from './Sidebar';

interface AppShellProps {
  activeSection: SectionId;
  children: ReactNode;
  developerMode: boolean;
  toolbar?: ReactNode;
  onSectionChange: (section: SectionId) => void;
}

function AppShell({ activeSection, children, developerMode, toolbar, onSectionChange }: AppShellProps) {
  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
      <div className="app-shell">
        <Sidebar activeSection={activeSection} developerMode={developerMode} onSectionChange={onSectionChange} />

        <main className="main-area">
          <section className="content-shell" aria-label="主内容">
            {children}
          </section>
          {toolbar}
        </main>
      </div>
    </Tooltip.Provider>
  );
}

export default AppShell;
