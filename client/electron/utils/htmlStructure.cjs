const { load } = require('cheerio');

// 空元素没有结束标签；可省略结束标签的元素会被后续标签自然结束，不会把后面的小节吞进来。
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const OPTIONAL_END_ELEMENTS = new Set(['p', 'li', 'dt', 'dd', 'rt', 'rp', 'optgroup', 'option', 'colgroup', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const FIGURE_SIZES = new Set(['square', 'wide', 'tall', 'panorama']);
// 这些容器可直接放置块级 figure；段落、标题及加粗、链接等行内包裹中的图片须在图片位置拆开包裹。
const FIGURE_CONTAINERS = new Set(['li', 'td', 'th', 'blockquote', 'div', 'section', 'dd']);
// `</` 后不是标签名时，解析器把它连同到下一个 > 为止的内容当注释丢弃。模型把工具调用标记（如 DSML）混入正文时出现，
// 常见于把 </template> 写错或输出中途结束；注释内的文字跳过。
const INVALID_END_TAG = /<!--[\s\S]*?(?:-->|$)|<\/(?![A-Za-z])[^>]*>?/g;
const stripInvalidEndTags = html => html.replace(INVALID_END_TAG, match => match.startsWith('</') ? '' : match);
const invalidEndTags = html => [...html.matchAll(INVALID_END_TAG)].filter(match => match[0].startsWith('</'));

// 只取属于该 figure 自身的图片，不含嵌套 figure 内的图片。
const ownImages = ($, node) => $(node).find('img').filter((_index, img) => $(img).closest('figure')[0] === node);

function describe(node) {
  const id = node.attribs?.id;
  const at = node.sourceCodeLocation?.startLine;
  return `${at ? `第 ${at} 行` : ''}<${node.name}${id ? ` id="${id}"` : ''}>`;
}

// 找出会让整本 Word 导出报错或丢失内容的结构问题：元素未闭合，以及 figure 与 img 不符合转换要求。
function findHtmlStructureIssues(html) {
  const source = String(html || '');
  const $ = load(source, { sourceCodeLocationInfo: true }, false);
  // 解析器补建的格式元素沿用原标签位置，按源码位置去重，不同元素分别报告。
  const issues = new Map();
  const add = (node, message) => issues.set(`${node.sourceCodeLocation?.startOffset}|${message}`, message);
  // 异常标记通常是其后未闭合问题的起因，排在最前，便于在截取的说明中看到。
  for (const match of invalidEndTags(source)) {
    issues.set(`${match.index}|invalid`, `第 ${source.slice(0, match.index).split('\n').length} 行出现异常结束标记（</ 后不是标签名），多为模型输出异常，标记之后的内容可能缺失`);
  }
  $('*').each((_index, node) => {
    const location = node.sourceCodeLocation;
    if (location?.startTag && !location.endTag && !VOID_ELEMENTS.has(node.name) && !OPTIONAL_END_ELEMENTS.has(node.name)) {
      add(node, `${describe(node)} 缺少结束标签 </${node.name}>`);
    }
  });
  $('figure').each((_index, node) => {
    const figure = $(node);
    if (figure.parents('figure').length) add(node, `${describe(node)} 嵌套在另一个 figure 中`);
    const direct = figure.children('img').length;
    const wrapped = ownImages($, node).length - direct;
    if (direct !== 1) {
      add(node, direct === 0 && wrapped
        ? `${describe(node)} 的 img 被其他元素包裹，须作为 figure 的直接子元素`
        : `${describe(node)} 须直接包含且仅包含一个 img，当前为 ${direct} 个`);
    }
    if (!FIGURE_SIZES.has((figure.attr('data-yb-size') || '').trim())) add(node, `${describe(node)} 缺少合法的 data-yb-size`);
  });
  $('img').each((_index, node) => {
    if (!$(node).closest('figure').length) add(node, `${describe(node)} 须放在 figure 内`);
  });
  return [...issues.values()];
}

// 提示词模板只含文字。模型把 </template> 写成异常标记时，后面的 img、图注乃至本节后续正文都会并入模板；
// 在模板的第一个子元素前补上结束标签并删除其中的异常标记即可无损恢复。逐个修复后重新解析，直到没有可补的模板。
function closeOpenTemplates(html) {
  let source = String(html || '');
  let closed = 0;
  for (;;) {
    const $ = load(source, { sourceCodeLocationInfo: true }, false);
    const target = $('template').toArray().map(node => [node, node.children[0]?.children?.find(child => child.type === 'tag')])
      .find(([node, first]) => node.sourceCodeLocation?.startTag && !node.sourceCodeLocation.endTag
        && first?.sourceCodeLocation?.startOffset >= node.sourceCodeLocation.startTag.endOffset);
    if (!target) return { html: source, closed };
    const [node, first] = target;
    const start = node.sourceCodeLocation.startTag.endOffset;
    const end = first.sourceCodeLocation.startOffset;
    const inner = stripInvalidEndTags(source.slice(start, end));
    const prompt = inner.trimEnd();
    source = `${source.slice(0, start)}${prompt}</template>${inner.slice(prompt.length)}${source.slice(end)}`;
    closed += 1;
  }
}

// 保存前校验：有问题时抛出可直接交给 Agent 修复的说明。
function assertHtmlStructure(html) {
  const issues = findHtmlStructureIssues(html);
  if (issues.length) {
    throw new Error(`HTML 结构不完整，请修正后重新保存：${issues.slice(0, 8).join('；')}${issues.length > 8 ? `；另有 ${issues.length - 8} 处` : ''}。除 img 等空元素外，每个元素都要写出结束标签；每个 figure 以 </figure> 结束，并直接包含一个 img。`);
  }
}

// 游离图片就地放入 figure：图片在段落、标题或行内包裹中时，从图片位置逐层拆开包裹，图片之后的内容移入同名新元素，
// figure 插在前后两部分之间，保持图文顺序；同段多图依次拆分。拆出后只剩空白的部分删除。
function placeFigure($, img, figure) {
  let node = img[0];
  let tail = null;
  while (node.parent?.type === 'tag' && !FIGURE_CONTAINERS.has(node.parent.name)) {
    const parent = node.parent;
    const rest = parent.children.slice(parent.children.indexOf(node) + 1);
    tail = null;
    if (rest.length) {
      const { id: _id, ...attributes } = parent.attribs;
      tail = $(`<${parent.name}></${parent.name}>`).attr(attributes).append(rest);
      $(parent).after(tail);
    }
    node = parent;
  }
  if (node === img[0]) {
    img.replaceWith(figure);
    return;
  }
  $(node).after(figure);
  img.remove();
  for (const part of [$(node), tail].filter(Boolean)) {
    if (!part.text().trim() && !part.find('img, table, figure').length) part.remove();
  }
}

// 整本导出继续时使用：按小节独立解析以补齐未闭合元素，并把 figure 调整为 Word 转换可接受的结构。
// 先补齐提示词模板并删除异常标记，被并入模板的图片和正文回到原位，后续修复不会把它们随 figure 删除。
function repairHtmlStructure(html) {
  const templates = closeOpenTemplates(html);
  const markers = invalidEndTags(templates.html).length;
  const $ = load(stripInvalidEndTags(templates.html), null, false);
  const repairs = [];
  if (templates.closed) repairs.push(`补齐 ${templates.closed} 处提示词结束标签 </template>`);
  if (markers) repairs.push(`删除 ${markers} 处异常结束标记`);
  const label = figure => `figure${figure.attr('id') ? `#${figure.attr('id')}` : ''}`;
  // 文档顺序即由外到内：误入 figure 的正文和嵌套 figure 先移到其后，再轮到被移出的 figure 自身。
  for (const node of $('figure').toArray()) {
    const figure = $(node);
    if (!figure.children('img').length) {
      const wrapped = ownImages($, node).first();
      if (wrapped.length) {
        figure.prepend(wrapped);
        repairs.push(`${label(figure)} 的图片移为直接子元素`);
      }
    }
    if (!FIGURE_SIZES.has((figure.attr('data-yb-size') || '').trim())) {
      figure.attr('data-yb-size', 'wide');
      repairs.push(`${label(figure)} 补充画框比例`);
    }
    // 多出的图片各自拆成同比例的 figure；误入的正文和嵌套 figure 依原顺序移到其后。
    const frame = { 'data-yb-size': figure.attr('data-yb-size'), ...(figure.attr('data-yb-fit') ? { 'data-yb-fit': figure.attr('data-yb-fit') } : {}) };
    const [image, ...extraImages] = figure.children('img').toArray();
    let anchor = figure;
    for (const child of figure.contents().toArray()) {
      if (child === image || ['figcaption', 'template'].includes(child.name)) continue;
      if (child.type === 'text' && !child.data.trim()) continue;
      const moved = extraImages.includes(child) ? $('<figure></figure>').attr(frame).append(child)
        : child.type === 'text' ? $('<p></p>').text(child.data.trim()) : $(child);
      if (child.type === 'text') $(child).remove();
      anchor.after(moved);
      anchor = moved;
    }
    if (anchor !== figure) repairs.push(`${label(figure)} 内的其他内容移到图片之后`);
    if (!image) {
      figure.remove();
      repairs.push(`移除缺少图片的 ${label(figure)}`);
    }
  }
  for (const node of $('img').toArray()) {
    const img = $(node);
    if (img.closest('figure').length) continue;
    placeFigure($, img, $('<figure data-yb-size="wide" data-yb-fit="contain"></figure>').append(img.clone()));
    repairs.push('游离图片放入 figure');
  }
  return { html: $.html(), repairs: [...new Set(repairs)] };
}

module.exports = { findHtmlStructureIssues, assertHtmlStructure, closeOpenTemplates, repairHtmlStructure, ownImages };
