export const RESTRICTED_HTML_BLOCK_MARKER = '<!-- yibiao:block -->';

const BLOCK_MARKER_PATTERN = /<!--\s*yibiao:block\s*-->/gi;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ROOT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ol', 'ul', 'figure', 'table']);
const INLINE_TAGS = new Set(['strong', 'em', 'u', 'sup', 'sub', 'br']);
const ALLOWED_TAGS = new Set([
  ...ROOT_TAGS,
  ...INLINE_TAGS,
  'li',
  'template',
  'img',
  'figcaption',
  'caption',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'aside',
]);
const DANGEROUS_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'video', 'audio', 'source', 'canvas', 'svg', 'math',
]);
const UNKNOWN_BLOCK_TAGS = new Set([
  'html', 'head', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'blockquote', 'pre',
  'dl', 'dt', 'dd', 'fieldset', 'details', 'summary', 'hr',
]);
const FIGURE_GENERATIONS = new Set(['aiImage', 'mermaid', 'htmlImage']);
const FIGURE_SIZES = new Set(['square', 'wide', 'tall', 'panorama']);
const TABLE_PRESETS = new Set([
  'plain', 'headerRow', 'headerColumn', 'headerRowAndColumn', 'imageText', 'threeImages', 'fourImages',
]);

export interface RestrictedHtmlIssue {
  blockIndex: number;
  level: 'error' | 'warning';
  message: string;
}

export interface RestrictedHtmlBlock {
  index: number;
  id: string;
  kind: string;
  html: string;
  valid: boolean;
  issues: RestrictedHtmlIssue[];
}

export interface RestrictedHtmlParseResult {
  blocks: RestrictedHtmlBlock[];
  issues: RestrictedHtmlIssue[];
  normalizedHtml: string | null;
  previewHtml: string;
}

interface BlockContext {
  index: number;
  issues: RestrictedHtmlIssue[];
}

function addIssue(context: BlockContext, level: RestrictedHtmlIssue['level'], message: string) {
  context.issues.push({ blockIndex: context.index, level, message });
}

function elementChildren(element: ParentNode) {
  return Array.from(element.children);
}

function meaningfulNodes(element: Element) {
  return Array.from(element.childNodes).filter((node) => node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim()));
}

function tagName(element: Element) {
  return element.tagName.toLowerCase();
}

function replaceTag(element: Element, nextTag: string) {
  const replacement = element.ownerDocument.createElement(nextTag);
  for (const attribute of Array.from(element.attributes)) {
    replacement.setAttribute(attribute.name, attribute.value);
  }
  while (element.firstChild) replacement.append(element.firstChild);
  element.replaceWith(replacement);
  return replacement;
}

function unwrapElement(element: Element) {
  element.replaceWith(...Array.from(element.childNodes));
}

function allowedAttributes(element: Element) {
  const tag = tagName(element);
  const names = new Set<string>();
  if (ROOT_TAGS.has(tag)) names.add('id');
  if (tag === 'ol') names.add('start');
  if (tag === 'figure') {
    names.add('data-yb-generation');
    names.add('data-yb-size');
  }
  if (tag === 'template' || tag === 'aside') names.add('data-yb-role');
  if (tag === 'img') {
    names.add('alt');
    names.add('data-yb-asset-ref');
  }
  if (tag === 'table') names.add('data-yb-preset');
  if (tag === 'th' || tag === 'td') {
    names.add('rowspan');
    names.add('colspan');
  }
  if (tag === 'th') names.add('scope');
  return names;
}

function sanitizeElement(element: Element, context: BlockContext) {
  let current = element;
  let tag = tagName(current);

  if (DANGEROUS_TAGS.has(tag)) {
    addIssue(context, 'error', `禁止使用 <${tag}>`);
    current.remove();
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    if (UNKNOWN_BLOCK_TAGS.has(tag)) {
      addIssue(context, 'error', `不支持块标签 <${tag}>`);
      current.remove();
      return;
    }
    addIssue(context, 'warning', `已移除行内标签 <${tag}>，并保留其中的文字`);
    for (const child of elementChildren(current)) sanitizeElement(child, context);
    unwrapElement(current);
    return;
  }

  if (tag === 'b') current = replaceTag(current, 'strong');
  if (tag === 'i') current = replaceTag(current, 'em');
  tag = tagName(current);

  const whitelist = allowedAttributes(current);
  for (const attribute of Array.from(current.attributes)) {
    if (!whitelist.has(attribute.name.toLowerCase())) {
      current.removeAttribute(attribute.name);
      addIssue(context, 'warning', `已删除 <${tag}> 的属性 ${attribute.name}`);
    }
  }

  for (const child of elementChildren(current)) sanitizeElement(child, context);
}

function onlyWhitespaceTextOutside(element: Element, allowed: Set<string>) {
  return Array.from(element.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) return !node.textContent?.trim();
    return node.nodeType === Node.ELEMENT_NODE && allowed.has(tagName(node as Element));
  });
}

function hasOnlyInlineContent(element: Element): boolean {
  return Array.from(element.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const child = node as Element;
    return INLINE_TAGS.has(tagName(child)) && (tagName(child) === 'br' || hasOnlyInlineContent(child));
  });
}

function positiveIntegerAttribute(element: Element, name: string, context: BlockContext, required = false) {
  const value = element.getAttribute(name);
  if (value == null) {
    if (required) addIssue(context, 'error', `<${tagName(element)}> 缺少 ${name}`);
    return 1;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    addIssue(context, 'error', `<${tagName(element)}> 的 ${name} 必须是正整数`);
    return 1;
  }
  return Number(value);
}

function validateId(element: Element, context: BlockContext, ids: Map<string, number>) {
  const id = element.getAttribute('id') || '';
  if (!ID_PATTERN.test(id)) {
    addIssue(context, 'error', `<${tagName(element)}> 缺少合法 id`);
    return;
  }
  const previous = ids.get(id);
  if (previous != null) {
    addIssue(context, 'error', `id ${id} 与第 ${previous + 1} 个块重复`);
    return;
  }
  ids.set(id, context.index);
}

function validateInlineContainer(element: Element, context: BlockContext) {
  if (!hasOnlyInlineContent(element)) addIssue(context, 'error', `<${tagName(element)}> 包含不允许的子节点`);
}

function validateList(list: Element, context: BlockContext) {
  if (!onlyWhitespaceTextOutside(list, new Set(['li']))) {
    addIssue(context, 'error', `<${tagName(list)}> 只能直接包含 li`);
  }
  if (tagName(list) === 'ol' && list.hasAttribute('start')) positiveIntegerAttribute(list, 'start', context);
  for (const item of elementChildren(list).filter((child) => tagName(child) === 'li')) {
    for (const node of Array.from(item.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        addIssue(context, 'error', 'li 包含不支持的内容');
        continue;
      }
      const child = node as Element;
      const childTag = tagName(child);
      if (INLINE_TAGS.has(childTag)) validateInlineContainer(child, context);
      else if (childTag === 'ol' || childTag === 'ul') validateList(child, context);
      else addIssue(context, 'error', `li 不能包含 <${childTag}>`);
    }
  }
}

function validateFigure(figure: Element, context: BlockContext, ids: Map<string, number>) {
  validateId(figure, context, ids);
  const generation = figure.getAttribute('data-yb-generation') || '';
  if (!FIGURE_GENERATIONS.has(generation)) addIssue(context, 'error', 'figure 缺少合法 data-yb-generation');
  const size = figure.getAttribute('data-yb-size') || '';
  if (!FIGURE_SIZES.has(size)) addIssue(context, 'error', 'figure 缺少合法 data-yb-size');
  if (!onlyWhitespaceTextOutside(figure, new Set(['template', 'img', 'figcaption']))) {
    addIssue(context, 'error', 'figure 只能包含 template、img 和 figcaption');
  }
  const templates = elementChildren(figure).filter((child) => tagName(child) === 'template');
  const images = elementChildren(figure).filter((child) => tagName(child) === 'img');
  const captions = elementChildren(figure).filter((child) => tagName(child) === 'figcaption');
  if (templates.length !== 1) addIssue(context, 'error', 'figure 必须包含一个配图提示 template');
  if (images.length !== 1) addIssue(context, 'error', 'figure 必须包含一个 img');
  if (captions.length > 1) addIssue(context, 'error', 'figure 最多包含一个 figcaption');
  const prompt = templates[0];
  if (prompt) {
    if (prompt.getAttribute('data-yb-role') !== 'prompt') addIssue(context, 'error', 'template 的 data-yb-role 必须为 prompt');
    const promptContent = prompt instanceof HTMLTemplateElement ? prompt.content : prompt;
    if (elementChildren(promptContent).length || !promptContent.textContent?.trim()) {
      addIssue(context, 'error', '配图提示 template 只能包含非空文字');
    }
  }
  const image = images[0];
  if (image) {
    if (!image.getAttribute('alt')?.trim()) addIssue(context, 'error', 'img 必须包含非空 alt');
    const assetRef = image.getAttribute('data-yb-asset-ref');
    if (assetRef != null && !isWorkspaceRelativeAssetRef(assetRef)) {
      addIssue(context, 'error', 'data-yb-asset-ref 必须是工作区内的相对路径');
    }
  }
  if (captions[0]) validateInlineContainer(captions[0], context);
}

/** 校验图片资产引用，只允许使用正斜杠表示的工作区相对路径。 */
function isWorkspaceRelativeAssetRef(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function tableRows(table: Element) {
  const rows: Element[] = [];
  for (const section of elementChildren(table).filter((child) => ['thead', 'tbody'].includes(tagName(child)))) {
    rows.push(...elementChildren(section).filter((child) => tagName(child) === 'tr'));
  }
  return rows;
}

function sectionRows(section: Element) {
  return elementChildren(section).filter((child) => tagName(child) === 'tr');
}

function rowCells(row: Element) {
  return elementChildren(row).filter((child) => ['th', 'td'].includes(tagName(child)));
}

function validateTableGrid(table: Element, context: BlockContext) {
  const carry: number[] = [];
  let expectedColumns: number | null = null;
  for (const row of tableRows(table)) {
    let column = 0;
    for (const cell of rowCells(row)) {
      while ((carry[column] || 0) > 0) column += 1;
      const colspan = positiveIntegerAttribute(cell, 'colspan', context);
      const rowspan = positiveIntegerAttribute(cell, 'rowspan', context);
      for (let offset = 0; offset < colspan; offset += 1) {
        if ((carry[column + offset] || 0) > 0) addIssue(context, 'error', '表格合并单元格发生重叠');
        if (rowspan > 1) carry[column + offset] = rowspan;
      }
      column += colspan;
    }
    let width = column;
    while ((carry[width] || 0) > 0) width += 1;
    if (expectedColumns == null) expectedColumns = width;
    else if (width !== expectedColumns) addIssue(context, 'error', '表格各行逻辑列数不一致');
    for (let index = 0; index < carry.length; index += 1) carry[index] = Math.max(0, (carry[index] || 0) - 1);
  }
  if (carry.some((remaining) => remaining > 0)) addIssue(context, 'error', 'rowspan 超出表格末行');
}

function directFigure(cell: Element) {
  const nodes = meaningfulNodes(cell);
  return nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE && tagName(nodes[0] as Element) === 'figure'
    ? nodes[0] as Element
    : null;
}

function validateImagePreset(table: Element, preset: string, context: BlockContext) {
  const tbody = elementChildren(table).find((child) => tagName(child) === 'tbody');
  const rows = tbody ? elementChildren(tbody).filter((child) => tagName(child) === 'tr') : [];
  const expectedRows = preset === 'fourImages' ? 2 : 1;
  const expectedCells = preset === 'threeImages' ? 3 : 2;
  if (rows.length !== expectedRows || rows.some((row) => rowCells(row).length !== expectedCells)) {
    addIssue(context, 'error', `${preset} 的行列结构不符合规范`);
    return;
  }
  for (const [rowIndex, row] of rows.entries()) {
    for (const [cellIndex, cell] of rowCells(row).entries()) {
      if (cell.hasAttribute('rowspan') || cell.hasAttribute('colspan')) addIssue(context, 'error', `${preset} 禁止合并单元格`);
      if (preset === 'imageText' && (rowIndex !== 0 || cellIndex === 1)) continue;
      const figure = directFigure(cell);
      if (!figure) addIssue(context, 'error', `${preset} 的图片单元格必须只包含一个 figure`);
      else if (preset !== 'imageText' && !elementChildren(figure).some((child) => tagName(child) === 'figcaption')) {
        addIssue(context, 'error', `${preset} 的每张图片都必须包含图注`);
      }
    }
  }
}

function validateTable(table: Element, context: BlockContext, ids: Map<string, number>) {
  validateId(table, context, ids);
  const preset = table.getAttribute('data-yb-preset') || '';
  if (!TABLE_PRESETS.has(preset)) addIssue(context, 'error', 'table 缺少合法 data-yb-preset');
  if (!onlyWhitespaceTextOutside(table, new Set(['caption', 'thead', 'tbody']))) {
    addIssue(context, 'error', 'table 只能直接包含 caption、thead 和 tbody');
  }
  const captions = elementChildren(table).filter((child) => tagName(child) === 'caption');
  const heads = elementChildren(table).filter((child) => tagName(child) === 'thead');
  const bodies = elementChildren(table).filter((child) => tagName(child) === 'tbody');
  if (captions.length > 1 || heads.length > 1 || bodies.length !== 1) addIssue(context, 'error', 'table 的 caption、thead 或 tbody 数量不符合规范');
  if (bodies[0] && sectionRows(bodies[0]).length === 0) addIssue(context, 'error', 'tbody 至少包含一行');
  for (const caption of captions) validateInlineContainer(caption, context);
  for (const section of [...heads, ...bodies]) {
    if (!onlyWhitespaceTextOutside(section, new Set(['tr']))) addIssue(context, 'error', `<${tagName(section)}> 只能包含 tr`);
    for (const row of elementChildren(section).filter((child) => tagName(child) === 'tr')) {
      if (!onlyWhitespaceTextOutside(row, new Set(['th', 'td']))) addIssue(context, 'error', 'tr 只能包含 th 或 td');
      for (const cell of rowCells(row)) {
        positiveIntegerAttribute(cell, 'rowspan', context);
        positiveIntegerAttribute(cell, 'colspan', context);
        const scope = cell.getAttribute('scope');
        if (scope && (tagName(cell) !== 'th' || !['row', 'col'].includes(scope))) addIssue(context, 'error', 'scope 只能在 th 上使用 row 或 col');
        for (const child of elementChildren(cell)) {
          const childTag = tagName(child);
          if (INLINE_TAGS.has(childTag) || childTag === 'p') validateInlineContainer(child, context);
          else if (childTag === 'ol' || childTag === 'ul') validateList(child, context);
          else if (childTag === 'figure') validateFigure(child, context, ids);
          else if (childTag === 'table') validateTable(child, context, ids);
          else addIssue(context, 'error', `单元格不能包含 <${childTag}>`);
        }
      }
    }
  }
  const firstHeadCells = heads[0] ? sectionRows(heads[0]).flatMap(rowCells) : [];
  const bodyRows = bodies[0] ? sectionRows(bodies[0]) : [];
  if (preset === 'headerRow' || preset === 'headerRowAndColumn') {
    if (!heads[0] || firstHeadCells.some((cell) => tagName(cell) !== 'th' || cell.getAttribute('scope') !== 'col')) {
      addIssue(context, 'error', `${preset} 的表头必须使用 th scope="col"`);
    }
  }
  if (preset === 'headerColumn' || preset === 'headerRowAndColumn') {
    if (bodyRows.some((row) => {
      const first = rowCells(row)[0];
      return !first || tagName(first) !== 'th' || first.getAttribute('scope') !== 'row';
    })) addIssue(context, 'error', `${preset} 的首列必须使用 th scope="row"`);
  }
  if (['imageText', 'threeImages', 'fourImages'].includes(preset)) validateImagePreset(table, preset, context);
  validateTableGrid(table, context);
}

function validateBlock(root: Element, aside: Element | null, context: BlockContext, ids: Map<string, number>) {
  const tag = tagName(root);
  if (/^h[1-6]$/.test(tag)) {
    validateId(root, context, ids);
    if (elementChildren(root).length || !root.textContent?.trim()) addIssue(context, 'error', '标题只能包含非空纯文本');
  } else if (tag === 'p') {
    validateId(root, context, ids);
    validateInlineContainer(root, context);
    if (!root.textContent?.trim()) addIssue(context, 'error', '段落不能为空');
  } else if (tag === 'ol' || tag === 'ul') {
    validateId(root, context, ids);
    validateList(root, context);
  } else if (tag === 'figure') {
    validateFigure(root, context, ids);
  } else if (tag === 'table') {
    validateTable(root, context, ids);
  }
  if (aside) {
    if (tag !== 'table' || aside.getAttribute('data-yb-role') !== 'table-notes') addIssue(context, 'error', 'aside 只能作为表格后的 table-notes');
    if (!onlyWhitespaceTextOutside(aside, new Set(['p']))) addIssue(context, 'error', '表注 aside 只能包含 p');
    for (const paragraph of elementChildren(aside)) validateInlineContainer(paragraph, context);
  }
}

function parseFragment(fragment: string, index: number, ids: Map<string, number>): RestrictedHtmlBlock {
  const context: BlockContext = { index, issues: [] };
  const document = new DOMParser().parseFromString(fragment, 'text/html');
  for (const child of elementChildren(document.body)) sanitizeElement(child, context);
  const roots = elementChildren(document.body);
  const root = roots[0] || null;
  const aside = roots.length === 2 && tagName(roots[1]) === 'aside' ? roots[1] : null;
  if (!root || !ROOT_TAGS.has(tagName(root))) addIssue(context, 'error', '片段缺少合法主块');
  if (roots.length !== (aside ? 2 : 1)) addIssue(context, 'error', '每个片段只能包含一个主块，表格可额外包含一个表注');
  if (root && ROOT_TAGS.has(tagName(root))) validateBlock(root, aside, context, ids);
  const html = root ? [root.outerHTML, aside?.outerHTML].filter(Boolean).join('\n') : '';
  return {
    index,
    id: root?.getAttribute('id') || '',
    kind: root ? tagName(root) : 'invalid',
    html,
    valid: !context.issues.some((issue) => issue.level === 'error'),
    issues: context.issues,
  };
}

/** 解析、清洗并校验一段易标受限 HTML。 */
export function parseRestrictedHtml(source: string): RestrictedHtmlParseResult {
  const raw = String(source || '');
  const markerMatches = raw.match(BLOCK_MARKER_PATTERN) || [];
  const pieces = raw.split(BLOCK_MARKER_PATTERN);
  const globalIssues: RestrictedHtmlIssue[] = [];
  if (pieces[0]?.trim()) globalIssues.push({ blockIndex: 0, level: 'error', message: '首个正文块前缺少 yibiao:block 分隔注释' });
  const fragments = pieces.slice(markerMatches.length ? 1 : 0).filter((piece) => piece.trim());
  if (!markerMatches.length && raw.trim()) {
    fragments.splice(0, fragments.length, raw);
  }
  const ids = new Map<string, number>();
  const blocks = fragments.map((fragment, index) => parseFragment(fragment, index, ids));
  if (!raw.trim()) return { blocks: [], issues: [], normalizedHtml: '', previewHtml: '' };
  if (!blocks.length) globalIssues.push({ blockIndex: 0, level: 'error', message: '没有可解析的正文块' });
  const issues = [...globalIssues, ...blocks.flatMap((block) => block.issues)];
  const validBlocks = blocks.filter((block) => block.valid);
  const normalized = validBlocks.map((block) => `${RESTRICTED_HTML_BLOCK_MARKER}\n${block.html}`).join('\n\n');
  return {
    blocks,
    issues,
    normalizedHtml: issues.some((issue) => issue.level === 'error') ? null : normalized,
    previewHtml: validBlocks.map((block) => block.html).join('\n'),
  };
}

function createEditorId(element: Element, used: Set<string>) {
  const prefix = tagName(element) === 'table' ? 'tbl' : tagName(element) === 'figure' ? 'fig' : tagName(element).replace(/[^a-z0-9]/g, '') || 'p';
  let id = `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  while (used.has(id)) id = `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  used.add(id);
  return id;
}

function ensureEditorIds(root: HTMLElement) {
  const used = new Set<string>();
  const elements = Array.from(root.querySelectorAll('[id], h1, h2, h3, h4, h5, h6, p, ol, ul, figure, table, div'));
  for (const element of elements) {
    const tag = tagName(element);
    const requiresId = ROOT_TAGS.has(tag) || tag === 'div';
    if (!requiresId) continue;
    const current = element.getAttribute('id') || '';
    if (ID_PATTERN.test(current) && !used.has(current)) used.add(current);
    else element.setAttribute('id', createEditorId(element, used));
  }
}

function normalizeEditorArtifacts(root: HTMLElement) {
  for (const element of Array.from(root.querySelectorAll('b'))) replaceTag(element, 'strong');
  for (const element of Array.from(root.querySelectorAll('i'))) replaceTag(element, 'em');
  for (const element of Array.from(root.querySelectorAll('div'))) replaceTag(element, 'p');
  for (const element of Array.from(root.querySelectorAll('span, font, s, strike, del'))) unwrapElement(element);
  for (const child of Array.from(root.children)) {
    if (tagName(child) === 'p' && !child.textContent?.trim() && !child.querySelector('table, ol, ul, figure')) child.remove();
  }
  for (const child of Array.from(root.children)) {
    if (tagName(child) === 'br') child.remove();
  }
}

/** 将可视化编辑区域重新序列化为受限 HTML。 */
export function serializeRestrictedHtmlEditor(root: HTMLElement): RestrictedHtmlParseResult {
  ensureEditorIds(root);
  const clone = root.cloneNode(true) as HTMLElement;
  normalizeEditorArtifacts(clone);
  const fragments: string[] = [];
  let currentTableIndex = -1;
  for (const node of Array.from(clone.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (!text) continue;
      const paragraph = clone.ownerDocument.createElement('p');
      paragraph.id = createEditorId(paragraph, new Set());
      paragraph.textContent = text;
      fragments.push(paragraph.outerHTML);
      currentTableIndex = -1;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    if (tagName(element) === 'aside' && currentTableIndex >= 0) {
      fragments[currentTableIndex] += `\n${element.outerHTML}`;
      currentTableIndex = -1;
      continue;
    }
    fragments.push(element.outerHTML);
    currentTableIndex = tagName(element) === 'table' ? fragments.length - 1 : -1;
  }
  return parseRestrictedHtml(fragments.map((fragment) => `${RESTRICTED_HTML_BLOCK_MARKER}\n${fragment}`).join('\n\n'));
}
