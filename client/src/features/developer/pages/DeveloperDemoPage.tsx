import type { SectionId } from '../../../shared/types/navigation';

type DeveloperDemoSectionId = 'developer-prompt-lab' | 'developer-parser-sandbox' | 'developer-export-preview';

interface DeveloperDemoPageProps {
  sectionId: DeveloperDemoSectionId;
}

interface DeveloperDemoConfig {
  kicker: string;
  title: string;
  description: string;
  accent: string;
  metrics: Array<{ label: string; value: string; detail: string }>;
  steps: Array<{ title: string; text: string }>;
  preview: string[];
}

const demoConfigs: Record<DeveloperDemoSectionId, DeveloperDemoConfig> = {
  'developer-prompt-lab': {
    kicker: 'Prompt Lab',
    title: 'Prompt调试台',
    description: '把 Prompt 版本、变量注入、输出格式和模型反馈集中到同一张观察台，方便定位生成质量波动。',
    accent: '版本化提示词',
    metrics: [
      { label: 'Prompt 片段', value: '18', detail: '系统、任务、格式约束' },
      { label: '变量槽位', value: '42', detail: '招标文件、目录、事实设定' },
      { label: '输出规则', value: '9', detail: 'JSON、Markdown、字数约束' },
    ],
    steps: [
      { title: '选择业务链路', text: '从目录生成、正文生成、查重和废标检查中选择调试目标。' },
      { title: '检查变量注入', text: '对比实际入参、截断策略和敏感字段过滤结果。' },
      { title: '沉淀调试记录', text: '记录模型、温度、输出结构和失败原因，便于复现。' },
    ],
    preview: ['系统 Prompt', '任务 Prompt', '输出 Schema', '模型返回摘要'],
  },
  'developer-parser-sandbox': {
    kicker: 'Parser Sandbox',
    title: '文件解析沙盘',
    description: '用统一视角检查本地解析、MinerU 解析、图片资产导入和 Markdown 清洗结果，降低解析问题排查成本。',
    accent: '解析链路体检',
    metrics: [
      { label: '解析通道', value: '2', detail: '本地解析 / MinerU' },
      { label: '资产批次', value: '7', detail: '图片、表格、附件' },
      { label: '清洗规则', value: '13', detail: '标题、空行、图片引用' },
    ],
    steps: [
      { title: '导入样本文件', text: '选择招标文件、投标文件或历史异常样本。' },
      { title: '对比解析结果', text: '同时查看 Markdown、图片引用、页码和结构化摘要。' },
      { title: '定位异常阶段', text: '把失败点归因到上传、解析、清洗或资产落盘。' },
    ],
    preview: ['原始文件信息', 'Markdown 片段', '图片资产清单', '解析耗时分布'],
  },
  'developer-export-preview': {
    kicker: 'Export Preview',
    title: '导出链路预演',
    description: '预演正文、Markdown、Mermaid 和图片资产进入 Word 导出的完整路径，提前发现样式和资源缺失问题。',
    accent: '导出前检查',
    metrics: [
      { label: '导出目标', value: '3', detail: 'Word、Markdown、图片' },
      { label: '图表转换', value: 'Mermaid', detail: 'Renderer 预览 / Main 转图' },
      { label: '检查项', value: '16', detail: '目录、正文、图片、表格' },
    ],
    steps: [
      { title: '读取权威正文', text: '以 outlineData.outline[*].content 作为导出内容来源。' },
      { title: '转换图表资源', text: '把 Mermaid 和导入图片统一转换为 Word 可用资源。' },
      { title: '输出检查报告', text: '展示缺图、空章节、转换失败和导出耗时。' },
    ],
    preview: ['章节正文', 'Mermaid 图表', '图片资源', '导出进度事件'],
  },
};

export function isDeveloperDemoSection(sectionId: SectionId): sectionId is DeveloperDemoSectionId {
  return sectionId === 'developer-prompt-lab' || sectionId === 'developer-parser-sandbox' || sectionId === 'developer-export-preview';
}

function DeveloperDemoPage({ sectionId }: DeveloperDemoPageProps) {
  const config = demoConfigs[sectionId];

  return (
    <div className="developer-secondary-demo-page">
      <section className="panel developer-secondary-hero">
        <div>
          <span className="section-kicker">{config.kicker}</span>
          <h2>{config.title}</h2>
          <p>{config.description}</p>
        </div>
        <div className="developer-secondary-accent-card">
          <span>演示入口</span>
          <strong>{config.accent}</strong>
          <small>用于观察二级菜单页跳转后的页面承载效果。</small>
        </div>
      </section>

      <div className="developer-secondary-grid">
        <section className="panel developer-secondary-panel">
          <div className="settings-section-title">
            <span />
            <strong>调试指标</strong>
          </div>
          <div className="developer-secondary-metrics">
            {config.metrics.map((metric) => (
              <article key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="panel developer-secondary-panel">
          <div className="settings-section-title">
            <span />
            <strong>预期流程</strong>
          </div>
          <div className="developer-secondary-steps">
            {config.steps.map((step, index) => (
              <article key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="panel developer-secondary-panel developer-secondary-preview">
          <div className="settings-section-title">
            <span />
            <strong>结果预览</strong>
          </div>
          <div className="developer-secondary-preview-list">
            {config.preview.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <p>此页当前只用于二级菜单效果演示，不接入真实业务执行。</p>
        </aside>
      </div>
    </div>
  );
}

export default DeveloperDemoPage;
