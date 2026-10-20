// 正文新增配图的生成方式；用户关闭的方式不出现在 Agent 可见的提示词、参考材料、工具和校验中，Agent 不知道就不会编排。
const IMAGE_KINDS = [
  { kind: 'ai', generation: 'aiImage', label: 'AI 图片', optionKey: 'useAiImages' },
  { kind: 'html', generation: 'htmlImage', label: 'HTML 图片', optionKey: 'useHtmlImages' },
  { kind: 'mermaid', generation: 'mermaid', label: 'Mermaid 图片', optionKey: 'useMermaidImages' },
];
// 原方案复用图片的格式标记，不对应任何生成方式。
const ORIGINAL_GENERATION = 'original';
const BLOCK_MARKER = '<!-- yibiao:block -->';

// 配图比例为 0 即无图，视为全部关闭；单节修改同样遵守。
function resolveImageKinds(options) {
  if (!(Number(options?.imageQuantity) > 0)) return [];
  return IMAGE_KINDS.filter(item => options?.[item.optionKey] === true).map(item => item.kind);
}

const enabledKinds = kinds => IMAGE_KINDS.filter(item => kinds.includes(item.kind));

// 新增图片允许填写的 data-yb-generation；原图标记另行判断。
function allowedImageGenerations(kinds) {
  return new Set(enabledKinds(kinds).map(item => item.generation));
}

// 提示词中的类型名称，如“AI 图片（aiImage）、HTML 图片（htmlImage）”。
function imageKindNames(kinds) {
  return enabledKinds(kinds).map(({ label, generation }) => `${label}（${generation}）`).join('、');
}

function imageGenerationList(kinds) {
  return enabledKinds(kinds).map(item => item.generation).join('/');
}

function imageKindList(kinds) {
  return enabledKinds(kinds).map(item => item.kind).join('/');
}

// 渲染资源中的条件段和占位符：<!-- @if html,mermaid -->…<!-- @endif --> 任一开启即保留，!ai 表示未开启时保留；不支持嵌套。
function renderImageKindText(text, kinds) {
  const enabled = new Set(kinds);
  return String(text)
    .replace(/<!-- @if (!?)([a-z,]+) -->([\s\S]*?)<!-- @endif -->/g, (_match, negate, names, body) => {
      const hit = names.split(',').some(name => enabled.has(name));
      return (negate ? !hit : hit) ? body : '';
    })
    .replaceAll('{{kinds}}', imageKindList(kinds))
    .replaceAll('{{generations}}', imageGenerationList(kinds))
    .replaceAll('{{kind_mapping}}', enabledKinds(kinds).map(({ kind, generation }) => `${kind} 对应 ${generation}`).join('，'))
    .replace(/\n{3,}/g, '\n\n');
}

// 对照表只保留开启的生成方式；Mermaid 关闭而 HTML 开启时，原 Mermaid 类型改由 HTML 绘制并补入 HTML 允许类型。
function buildImageTypeTable(text, kinds) {
  const enabled = new Set(kinds);
  const remapMermaid = !enabled.has('mermaid') && enabled.has('html');
  const remappedHtmlTypes = [];
  const lines = String(text).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(.+)=(ai|html|mermaid)$/);
    if (!match || enabled.has(match[2])) return [line];
    if (match[2] === 'mermaid' && remapMermaid) {
      remappedHtmlTypes.push(match[1]);
      return [`${match[1]}=html`];
    }
    return [];
  });
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { content: `${content || '本轮不新增配图。'}\n`, remappedHtmlTypes };
}

// 样张按与对照表相同的规则改写图片类型；仍含未开启类型的块整块删除，样张只示范结构。
function filterTemplateSample(html, kinds) {
  const allowed = allowedImageGenerations(kinds);
  const remapMermaid = !kinds.includes('mermaid') && kinds.includes('html');
  const [head, ...blocks] = String(html).split(BLOCK_MARKER);
  const kept = blocks
    .map(block => remapMermaid ? block.replace(/data-yb-generation="mermaid"/g, 'data-yb-generation="htmlImage"') : block)
    .filter(block => [...block.matchAll(/data-yb-generation="([^"]*)"/g)].every(([, generation]) => allowed.has(generation)));
  return [head, ...kept].join(BLOCK_MARKER);
}

module.exports = {
  IMAGE_KINDS, ORIGINAL_GENERATION, resolveImageKinds, allowedImageGenerations, imageKindNames, imageGenerationList, imageKindList,
  renderImageKindText, buildImageTypeTable, filterTemplateSample,
};
