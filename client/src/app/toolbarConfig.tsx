import {
  ToolbarArrowLeftIcon,
  ToolbarArrowRightIcon,
} from '../shared/ui';
import type { FloatingToolbarGroup } from '../shared/ui';
import type { SectionId } from '../shared/types/navigation';
import { getSectionOrder } from './menuConfig';

interface BuildToolbarGroupsOptions {
  activeSection: SectionId;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

export function buildToolbarGroups({
  activeSection,
  developerMode,
  onSectionChange,
}: BuildToolbarGroupsOptions): FloatingToolbarGroup[] {
  if (activeSection === 'settings' || activeSection === 'technical-plan' || activeSection === 'developer-test') {
    return [];
  }

  const sectionOrder = getSectionOrder(developerMode);
  const activeIndex = sectionOrder.indexOf(activeSection);
  const goToSection = (offset: number) => {
    const nextSection = sectionOrder[activeIndex + offset];
    if (nextSection) {
      onSectionChange(nextSection);
    }
  };

  return [
    {
      id: 'page-navigation',
      actions: [
        {
          id: 'previous',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一个页面' : '切换到上一个页面',
          onClick: () => goToSection(-1),
        },
        {
          id: 'next',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          disabled: activeIndex >= sectionOrder.length - 1,
          tooltip: activeIndex >= sectionOrder.length - 1 ? '当前已经是最后一个页面' : '切换到下一个页面',
          onClick: () => goToSection(1),
        },
      ],
    },
  ];
}
