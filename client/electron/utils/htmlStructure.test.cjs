const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('cheerio');
const { findHtmlStructureIssues, assertHtmlStructure, closeOpenTemplates, repairHtmlStructure } = require('./htmlStructure.cjs');

const figure = (id, inner = '<img alt="图" data-yb-asset-ref="图片/a.png">') => `<figure id="${id}" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">提示词</template>${inner}<figcaption>${id}图注</figcaption></figure>`;

// 修复结果须能直接通过校验，且 figure 只剩一个直接 img。
function repairClean(html) {
  const { html: repaired, repairs } = repairHtmlStructure(html);
  assert.deepEqual(findHtmlStructureIssues(repaired), [], repaired);
  return { $: load(repaired, null, false), repaired, repairs };
}

test('结构完整的小节不报问题，可省略结束标签的元素不算未闭合', () => {
  const html = `<!-- yibiao:block --><p>正文<p>第二段<ul><li>一<li>二</ul><table><tbody><tr><td>甲<td>乙</table>${figure('ok')}`;
  assert.deepEqual(findHtmlStructureIssues(html), []);
  assert.doesNotThrow(() => assertHtmlStructure(html));
});

test('截断在 figure 或提示词模板中时报告未闭合，并逐项定位行号', () => {
  const openFigure = `<p>正文</p>\n<figure id="cut" data-yb-size="wide"><template data-yb-role="prompt">x</template><img alt="图" data-yb-asset-ref="图片/a.png"><figcaption>未闭合`;
  assert.deepEqual(findHtmlStructureIssues(openFigure), ['第 2 行<figure id="cut"> 缺少结束标签 </figure>', '第 2 行<figcaption> 缺少结束标签 </figcaption>']);
  const openTemplate = '<p>正文</p><figure id="t" data-yb-size="wide"><template data-yb-role="prompt">提示词截断';
  const issues = findHtmlStructureIssues(openTemplate);
  assert.ok(issues.some(issue => issue.includes('<template> 缺少结束标签')));
  assert.ok(issues.some(issue => issue.includes('<figure id="t"> 须直接包含且仅包含一个 img，当前为 0 个')));
  assert.throws(() => assertHtmlStructure(openTemplate), /HTML 结构不完整.*缺少结束标签/);
});

test('未闭合的列表、容器和行内元素都算问题', () => {
  for (const [html, tag] of [['<ul><li>要点', 'ul'], ['<div>容器', 'div'], ['<p><strong>加粗', 'strong'], ['<table><tr><td>格', 'table']]) {
    assert.ok(findHtmlStructureIssues(html).some(issue => issue.includes(`<${tag}> 缺少结束标签`)), html);
  }
});

test('图片被加粗或链接包裹、figure 嵌套、游离图片原位拆分及画框比例缺失均能识别并修复', () => {
  const wrapped = `<p><strong>${figure('bold')}</strong></p>`;
  assert.ok(findHtmlStructureIssues(wrapped).some(issue => issue.includes('<figure id="bold"> 的 img 被其他元素包裹')));
  const fixedWrapped = repairClean(wrapped).$;
  assert.equal(fixedWrapped('figure#bold').children('img').length, 1);

  const nested = `${figure('outer', '<img alt="外" data-yb-asset-ref="图片/a.png">').replace('</figure>', '')}<p>被吞并的正文</p>${figure('inner')}`;
  assert.ok(findHtmlStructureIssues(nested).some(issue => issue.includes('<figure id="inner"> 嵌套在另一个 figure 中')));
  const fixedNested = repairClean(nested).$;
  assert.deepEqual(fixedNested.root().children().toArray().map(node => node.attribs?.id || node.name), ['outer', 'p', 'inner']);
  assert.equal(fixedNested('p').text(), '被吞并的正文', '误入 figure 的正文保留在原顺序');

  const stray = '<p><strong>如下图<img alt="游离" data-yb-asset-ref="图片/a.png">所示</strong></p><p><img alt="甲" data-yb-asset-ref="图片/a.png"><img alt="乙" data-yb-asset-ref="图片/a.png"></p>';
  assert.equal(findHtmlStructureIssues(stray).filter(issue => issue.includes('须放在 figure 内')).length, 3);
  const order = $ => $.root().children().toArray().map(node => node.name === 'figure' ? `图:${$(node).children('img').attr('alt')}` : $(node).text());
  assert.deepEqual(order(repairClean(stray).$), ['如下图', '图:游离', '所示', '图:甲', '图:乙'], '在图片位置拆开段落，图文顺序不变，只剩空白的部分删除');

  const interleaved = '<p id="s_p1">前文<img alt="一" data-yb-asset-ref="图片/a.png">中间<a href="#x"><strong>链接内<img alt="二" data-yb-asset-ref="图片/a.png">链接后</strong></a>后文</p>';
  const fixedInterleaved = repairClean(interleaved).$;
  assert.deepEqual(order(fixedInterleaved), ['前文', '图:一', '中间链接内', '图:二', '链接后后文'], '同段多图与文字交错时逐张拆分');
  assert.deepEqual(fixedInterleaved('p').toArray().map(node => node.attribs.id), ['s_p1', undefined, undefined], '拆出的段落不复制 id');
  assert.deepEqual(fixedInterleaved('a > strong').toArray().map(node => [node.parent.attribs.href, fixedInterleaved(node).text()]), [['#x', '链接内'], ['#x', '链接后']], '行内包裹按原属性拆成前后两段');

  const twoImages = figure('two', '<img alt="一" data-yb-asset-ref="图片/a.png"><img alt="二" data-yb-asset-ref="图片/a.png">').replace(' data-yb-size="wide"', '');
  const twoIssues = findHtmlStructureIssues(twoImages);
  assert.ok(twoIssues.some(issue => issue.includes('当前为 2 个')) && twoIssues.some(issue => issue.includes('缺少合法的 data-yb-size')));
  const fixedTwo = repairClean(twoImages).$;
  assert.deepEqual(fixedTwo('figure').toArray().map(node => [node.attribs['data-yb-size'], fixedTwo(node).children('img').attr('alt')]), [['wide', '一'], ['wide', '二']]);
});

// 模型把 </template> 写成工具调用标记时，图片、图注和后续正文都会并入模板。
const MARKER = '</｜｜DSML｜｜ parameter>';
const markedFigure = id => `<!-- yibiao:block -->\n<figure id="${id}" data-yb-generation="aiImage" data-yb-size="square">\n  <template data-yb-role="prompt">${id}提示词。${MARKER}\n  <img alt="${id}" data-yb-asset-ref="图片/${id}.png">\n  <figcaption>${id}图注</figcaption>\n</figure>\n\n<!-- yibiao:block -->\n<p>${id}后续正文</p>\n`;

test('提示词结束标签写成异常标记时报告问题，并在第一个子元素前无损补齐', () => {
  const html = `<!-- yibiao:block -->\n<p>前文</p>\n\n${markedFigure('a')}${markedFigure('b')}`;
  const issues = findHtmlStructureIssues(html);
  assert.ok(issues.includes('第 6 行<template> 缺少结束标签 </template>'), issues.join('\n'));
  assert.ok(issues.includes('第 6 行出现异常结束标记（</ 后不是标签名），多为模型输出异常，标记之后的内容可能缺失'));
  assert.throws(() => assertHtmlStructure(html), /异常结束标记/);
  const expected = html.replaceAll(`${MARKER}\n`, '</template>\n');
  assert.deepEqual(closeOpenTemplates(html), { html: expected, closed: 2 }, '同一小节多处均补齐，结果与手工修正一致');
  assert.deepEqual(findHtmlStructureIssues(expected), []);
  const { $, repairs } = repairClean(html);
  assert.deepEqual($('figure > img').toArray().map(node => node.attribs.alt), ['a', 'b']);
  assert.deepEqual($('figure > figcaption').toArray().map(node => $(node).text()), ['a图注', 'b图注']);
  assert.deepEqual($('p').toArray().map(node => $(node).text()), ['前文', 'a后续正文', 'b后续正文'], '图片和后续正文不随 figure 删除');
  assert.deepEqual(repairs, ['补齐 2 处提示词结束标签 </template>']);
  const intact = `<!-- yibiao:block --><p>正文</p>${figure('ok')}`;
  assert.deepEqual(closeOpenTemplates(intact), { html: intact, closed: 0 }, '结构完整时不改变内容');
  const truncated = '<figure data-yb-size="wide"><template data-yb-role="prompt">提示词截断';
  assert.deepEqual(closeOpenTemplates(truncated), { html: truncated, closed: 0 }, '模板内没有子元素时不补齐');
});

test('正文中途出现异常标记时逐行报告，修复删除标记，注释中的文字不算', () => {
  const html = `<!-- yibiao:block -->\n<p>抚育施工与人${MARKER}\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
  assert.deepEqual(findHtmlStructureIssues(html).map(issue => issue.match(/^第 (\d+) 行出现异常结束标记/)?.[1]), ['2', '3', '4']);
  const { $, repaired, repairs } = repairClean(html);
  assert.equal($('p').text().trim(), '抚育施工与人');
  assert.ok(!repaired.includes('DSML'));
  assert.deepEqual(repairs, ['删除 3 处异常结束标记']);
  assert.deepEqual(findHtmlStructureIssues('<!-- 说明 </｜注释内 --><p>正文</p>'), []);
});

test('缺少图片的 figure 修复时移除，其他正文保留并补齐闭合', () => {
  const { $, repairs } = repairClean('<p>正文</p><figure id="empty" data-yb-size="wide"><template data-yb-role="prompt">提示词截断');
  assert.equal($('figure').length, 0);
  assert.equal($('p').text(), '正文');
  assert.ok(repairs.includes('移除缺少图片的 figure#empty'));
  const intact = `<!-- yibiao:block --><p>正文</p>${figure('ok')}`;
  const { repaired } = repairClean(intact);
  assert.equal(repaired, intact, '结构完整时修复不改变内容');
});
