import { useEffect, useState } from 'react';
import AppRouter from './app/AppRouter';
import UpdateNotifier from './app/UpdateNotifier';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('technical-plan');
  const [developerMode, setDeveloperMode] = useState(false);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
  }, [activeSection]);

  useEffect(() => {
    if (!developerMode && activeSection === 'developer-test') {
      setActiveSection('technical-plan');
    }
  }, [activeSection, developerMode]);

  return (
    <>
      <UpdateNotifier />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        onSectionChange={setActiveSection}
      >
        <AppRouter activeSection={activeSection} onDeveloperModeChange={setDeveloperMode} />
      </AppShell>
    </>
  );
}

export default App;
