export type GenerationSettingsTab = 'content' | 'existing-plan' | 'knowledge' | 'length' | 'illustration' | 'writing' | 'appearance';

// 生成设置页签顺序同时决定工具条逐项前进与回退的顺序。
export const generationSettingsTabs: Array<{ id: GenerationSettingsTab; label: string }> = [
  { id: 'content', label: '写嘛' },
  { id: 'existing-plan', label: '我有方案' },
  { id: 'knowledge', label: '知识库' },
  { id: 'length', label: '写多少' },
  { id: 'illustration', label: '插图吗' },
  { id: 'writing', label: '怎么写' },
  { id: 'appearance', label: '长嘛样' },
];
