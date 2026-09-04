import type { AppMenuItem, SectionId } from '../shared/types/navigation';

const githubStarNotice = {
  message: '正在开发中，在github给作者点个star，可以加速开发。',
  actionLabel: '点此直达',
  externalUrl: 'https://github.com/FB208/OpenBidKit_Yibiao',
};

export const appMenuItems: AppMenuItem[] = [
  {
    id: 'bid-generation',
    label: '内容生成',
    description: '标书与可研报告内容编制',
    children: [
      {
        id: 'technical-plan',
        label: '投标文件',
        description: '根据招标文件生成技术方案、商务标等投标内容，或导入已有方案继续优化扩写',
        icon: 'document',
      },
      {
        id: 'feasibility-report',
        label: '可行性研究报告',
        description: '根据项目资料编制可行性研究报告',
        icon: 'document',
        badge: 'Beta',
      },
    ],
  },
  {
    id: 'template-settings',
    label: '模版设置',
    description: '标书导出模板与排版配置',
  },
  {
    id: 'knowledge-base',
    label: '知识库',
    description: '素材、模板和案例资产',
    children: [
      {
        id: 'document-knowledge-base',
        label: '文档知识库',
        description: '管理文档资料、案例素材和可复用知识条目',
        icon: 'document',
      },
      {
        id: 'credential-library',
        label: '资信库',
        description: '管理单家企业的资质、人员、业绩和财务资料',
        icon: 'shield',
      },
      {
        id: 'image-knowledge-base',
        label: '图片知识库',
        description: '管理图片素材、图示和视觉参考资料',
        icon: 'file',
        notice: githubStarNotice,
      },
    ],
  },
  {
    id: 'bid-check',
    label: '标书检查',
    description: '查重、废标项与合规检查',
    children: [
      {
        id: 'duplicate-check',
        label: '标书查重',
        description: '相似度与重复表达检测',
        icon: 'compare',
      },
      {
        id: 'rejection-check',
        label: '废标项检查',
        description: '硬性条款与响应完整性',
        icon: 'shield',
      },
      {
        id: 'ai-evaluation',
        label: 'AI评标',
        description: '模拟AI评标，对标书进行打分，出具评标报告',
        icon: 'tool',
        notice: githubStarNotice,
      },
    ],
  },
  {
    id: 'bid-opportunity',
    label: '投标机会',
    description: '机会发现与线索跟踪',
    notice: githubStarNotice,
  },
  {
    id: 'plugin-manager',
    label: '插件管理',
    description: '安装和管理插件，扩展软件功能',
  },
  {
    id: 'resources',
    label: '资源下载',
    description: '投标相关资料、工具下载',
  },
];

const developerMenuItems: AppMenuItem[] = [
  {
    id: 'developer-test',
    label: '测试页',
    description: '开发者验证与问题复现',
    children: [
      {
        id: 'developer-json-test',
        label: 'Json请求测试',
        description: '通过通用 AI 请求验证模型 JSON 响应和修复流程。',
        icon: 'code',
      },
      {
        id: 'developer-multimodal-test',
        label: '多模态测试',
        description: '上传图片并使用自定义提示词验证文本模型的图片理解能力。',
        icon: 'code',
      },
      {
        id: 'developer-prompt-lab',
        label: 'Prompt调试台',
        description: '集中观察 Prompt 版本、变量注入和输出约束，便于后续调参。',
        icon: 'prompt',
      },
      {
        id: 'developer-parser-sandbox',
        label: '文件解析沙盘',
        description: '模拟本地解析、MinerU 解析和图片资产入库的调试入口。',
        icon: 'file',
      },
      {
        id: 'developer-export-preview',
        label: '导出链路预演',
        description: '预览 Word、Markdown、Mermaid 图片转换的导出检查路径。',
        icon: 'export',
      },
      {
        id: 'developer-expansion-replace-test',
        label: '扩写替换测试',
        description: '使用真实扩写 patch 应用逻辑，复现 replace 锚点未命中后的追加问题。',
        icon: 'tool',
      },
      {
        id: 'developer-agent-test',
        label: 'Pi Agent 链路测试',
        description: '验证 Pi Agent 的状态、自检、任务输出和诊断。',
        icon: 'tool',
      },
    ],
  },
];

export function getAppMenuItems(developerMode: boolean): AppMenuItem[] {
  return developerMode ? [...appMenuItems, ...developerMenuItems] : appMenuItems;
}

export function getSectionOrder(developerMode: boolean): SectionId[] {
  return getAppMenuItems(developerMode).flatMap((item) => [item.id, ...(item.children?.map((child) => child.id) ?? [])]);
}

export function getAppMenuItemById(id: SectionId, developerMode: boolean): AppMenuItem | undefined {
  return getAppMenuItems(developerMode).find((item) => item.id === id);
}

export function getParentMenuItemBySection(section: SectionId, developerMode: boolean): AppMenuItem | undefined {
  return getAppMenuItems(developerMode).find((item) => item.id === section || item.children?.some((child) => child.id === section));
}
