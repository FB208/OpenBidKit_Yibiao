const MERMAID_DIAGRAM_TYPES = new Set(['process', 'hierarchy', 'responsibility']);
const MERMAID_DIAGRAM_TYPE_LABELS = {
  process: '流程图',
  hierarchy: '层级图',
  responsibility: '职责关系图',
};
const SUPPORTED_MERMAID_SYNTAX_PATTERN = /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/i;

// 归一化 Mermaid 业务图表类型。
function normalizeMermaidDiagramType(value) {
  const type = String(value || '').trim();
  return MERMAID_DIAGRAM_TYPES.has(type) ? type : '';
}

// 返回 Mermaid 业务图表类型的中文名称。
function getMermaidDiagramTypeLabel(value) {
  const type = normalizeMermaidDiagramType(value);
  return type ? MERMAID_DIAGRAM_TYPE_LABELS[type] : '';
}

// 确保业务图表类型属于当前支持范围。
function assertSupportedMermaidDiagramType(value) {
  const type = normalizeMermaidDiagramType(value);
  if (!type) {
    throw new Error('Mermaid 图表类型无效，仅支持流程图、层级图和职责关系图');
  }
  return type;
}

// 确保 Mermaid 代码使用受支持的 flowchart 语法。
function assertSupportedMermaidSyntax(code) {
  const normalized = String(code || '').trim();
  if (!SUPPORTED_MERMAID_SYNTAX_PATTERN.test(normalized)) {
    throw new Error('仅支持流程图、层级图和职责关系图，且必须使用 flowchart TD/TB/LR/RL/BT 语法');
  }
  return normalized;
}

module.exports = {
  assertSupportedMermaidDiagramType,
  assertSupportedMermaidSyntax,
  getMermaidDiagramTypeLabel,
  normalizeMermaidDiagramType,
};
