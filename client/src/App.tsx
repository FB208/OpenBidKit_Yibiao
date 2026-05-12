import { useEffect, useState } from 'react';
import AppRouter from './app/AppRouter';
import { buildToolbarGroups } from './app/toolbarConfig';
import AppShell from './components/AppShell';
import { FloatingToolbar } from './shared/ui';
import type { SectionId } from './shared/types/navigation';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('technical-plan');
  const [developerMode, setDeveloperMode] = useState(false);
  const toolbarGroups = buildToolbarGroups({ activeSection, developerMode, onSectionChange: setActiveSection });

  useEffect(() => {
    void window.yibiao?.config.load()
      .then((config) => setDeveloperMode(Boolean(config?.developer_mode)))
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    if (!developerMode && activeSection === 'developer-test') {
      setActiveSection('technical-plan');
    }
  }, [activeSection, developerMode]);

  return (
    <AppShell
      activeSection={activeSection}
      developerMode={developerMode}
      toolbar={<FloatingToolbar groups={toolbarGroups} />}
      onSectionChange={setActiveSection}
    >
      <AppRouter activeSection={activeSection} onDeveloperModeChange={setDeveloperMode} />
    </AppShell>
  );
}

export default App;
