import { assertReady, buildRangeQuery, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { renderTable } from '../render.js';
import { state } from '../state.js';

const pageLabels = {
  'bid-generation': '内容生成',
  'technical-plan': '投标文件',
  'existing-plan-expansion': '投标文件 - 已有方案扩写',
  'technical-plan/document-analysis': '投标文件 - 上传招标文件',
  'technical-plan/generation-settings': '投标文件 - 生成设置',
  'technical-plan/bid-analysis': '投标文件 - 招标文件解析',
  'technical-plan/outline-generation': '投标文件 - 目录生成',
  'technical-plan/global-facts': '投标文件 - 全局事实设定',
  'technical-plan/content-edit': '投标文件 - 生成正文',
  'technical-plan/expand': '投标文件 - 扩写改写',
  'existing-plan-expansion/document-analysis': '已有方案扩写 - 选择标书',
  'existing-plan-expansion/generation-settings': '已有方案扩写 - 生成设置',
  'existing-plan-expansion/bid-analysis': '已有方案扩写 - 招标文件解析',
  'existing-plan-expansion/outline-generation': '已有方案扩写 - 目录生成',
  'existing-plan-expansion/global-facts': '已有方案扩写 - 全局事实设定',
  'existing-plan-expansion/content-edit': '已有方案扩写 - 生成正文',
  'existing-plan-expansion/expand': '已有方案扩写 - 扩写改写',
  'feasibility-report': '可行性研究报告',
  'feasibility-report/materials': '可行性研究报告 - 项目资料',
  'feasibility-report/sources': '可行性研究报告 - 项目资料文件',
  'feasibility-report/analysis': '可行性研究报告 - 资料分析',
  'feasibility-report/outline': '可行性研究报告 - 报告目录',
  'feasibility-report/parameters': '可行性研究报告 - 关键参数',
  'feasibility-report/content': '可行性研究报告 - 正文生成',
  'business-bid': '商务标（历史）',
  'knowledge-base': '知识库',
  'resource-download': '资源下载',
  resources: '精选资源',
  'knowledge-base/library': '知识库 - 文档列表',
  'knowledge-base/viewer/items': '知识库 - 知识条目',
  'knowledge-base/viewer/markdown': '知识库 - Markdown 原文',
  'knowledge-base/viewer/analysis': '知识库 - 分析调试',
  'bid-check': '标书检查',
  'duplicate-check': '标书查重',
  'duplicate-check/upload': '标书查重 - 选择标书',
  'duplicate-check/analysis/metadata': '标书查重 - 元数据结果',
  'duplicate-check/analysis/outline': '标书查重 - 目录结果',
  'duplicate-check/analysis/content': '标书查重 - 正文结果',
  'duplicate-check/analysis/image': '标书查重 - 图片结果',
  'rejection-check': '废标项检查',
  'rejection-check/documents/tender': '废标项检查 - 招标文件',
  'rejection-check/documents/bid': '废标项检查 - 投标文件',
  'rejection-check/items/analysis': '废标项检查 - 解析结果',
  'rejection-check/items/custom': '废标项检查 - 自定义检查项',
  'rejection-check/results/rejection': '废标项检查 - 废标项结果',
  'rejection-check/results/typo': '废标项检查 - 错别字结果',
  'rejection-check/results/logic': '废标项检查 - 逻辑谬误结果',
  'blind-check': '暗标合规检查',
  'blind-check/upload': '暗标合规检查 - 选择标书',
  'blind-check/preset/page': '暗标合规检查 - 格式要求·页面',
  'blind-check/preset/body': '暗标合规检查 - 格式要求·正文',
  'blind-check/preset/headings': '暗标合规检查 - 格式要求·标题与目录',
  'blind-check/preset/table': '暗标合规检查 - 格式要求·表格与图片',
  'blind-check/preset/checks': '暗标合规检查 - 格式要求·检查项（旧）',
  'blind-check/preset/privacy': '暗标合规检查 - 格式要求·身份与痕迹',
  'blind-check/preset/source': '暗标合规检查 - 格式要求·AI 提取说明',
  'blind-check/results/all': '暗标合规检查 - 全部结果',
  'blind-check/results/privacy': '暗标合规检查 - 隐私与匿名',
  'blind-check/results/structure': '暗标合规检查 - 结构',
  'blind-check/results/page': '暗标合规检查 - 页面',
  'blind-check/results/paragraph': '暗标合规检查 - 段落',
  'blind-check/results/font': '暗标合规检查 - 字体',
  'blind-check/results/text': '暗标合规检查 - 标点空格',
  'blind-check/results/table': '暗标合规检查 - 表格',
  'blind-check/results/consistency': '暗标合规检查 - 一致性',
  'blind-check/results/image': '暗标合规检查 - 图片',
  'blind-check/results/clauses': '暗标合规检查 - 招标条款对照（旧）',
  'blind-check/results/review': '暗标合规检查 - AI 复核与招标条款对照（旧）',
  'blind-check/results/other': '暗标合规检查 - 其他',
  'blind-check/fix': '暗标合规检查 - 自动修复',
  'template-settings': '模版设置',
  'my-templates': '模版设置 - 我的模板',
  'my-templates/edit': '模版设置 - 编辑模板',
  'new-template': '模版设置 - 新建模板',
  'export-format': '模版设置 - 新建模板',
  'bid-opportunity': '投标机会',
  'plugin-manager': '插件管理',
  'developer-test': '测试页',
  'developer-json-test': '测试页 - Json请求测试',
  'developer-multimodal-test': '测试页 - 多模态测试',
  'developer-prompt-lab': '测试页 - Prompt调试台',
  'developer-parser-sandbox': '测试页 - 文件解析沙盘',
  'developer-export-preview': '测试页 - 导出链路预演',
  'developer-agent-test': '测试页 - 智能体链路测试',
  'developer-expansion-replace-test': '测试页 - 扩写替换测试',
  'developer-layout-budget-test': '测试页 - 版面预算正文测试',
  settings: '设置',
  changelog: '更新日志',
  notice: '公告',
};

function getPageLabel(page) {
  return pageLabels[page] || '未知页面';
}

export async function loadTraffic() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const range = state.trafficRange.value;
  const { projectName } = getEncodedProjectAndDays();
  const summary = await requestJson(`/api/traffic?projectName=${projectName}&${buildRangeQuery(range)}`);
  const pages = (summary.pages || []).map((row) => ({
    ...row,
    pageLabel: getPageLabel(row.page),
  }));

  renderTable(state.pagesTable, pages, [
    { key: 'pageLabel', label: '功能名称' },
    { key: 'page', label: '路由', code: true },
    { key: 'count', label: range === 'history' ? '累计访问量' : '访问量' },
  ], '暂无页面访问数据');

  renderTable(state.versionsTable, summary.versions || [], [
    { key: 'version', label: '版本', code: true },
    { key: 'count', label: range === 'history' ? '累计事件数' : '事件数' },
    { key: 'clients', label: '客户端数' },
  ], '暂无版本数据');
}
