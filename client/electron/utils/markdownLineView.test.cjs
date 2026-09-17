const test = require('node:test');
const assert = require('node:assert/strict');
const { numberMarkdownLines } = require('./markdownLineView.cjs');

// 还原行号视图，验证展示分片没有改变任何原文字符。
function restoreNumberedView(view) {
  const lines = [];
  for (const displayLine of String(view).split('\n')) {
    const match = /^L(\d+)(?:\[(\d+)\/(\d+)\])? \| (.*)$/u.exec(displayLine);
    assert.ok(match, `无法识别行号视图：${displayLine}`);
    const lineIndex = Number(match[1]) - 1;
    lines[lineIndex] = `${lines[lineIndex] || ''}${match[4]}`;
  }
  return lines.join('\n');
}

test('普通文本保持原有行号格式并统一换行', () => {
  const source = '第一行\r\n\r第二行\n第三行';
  const view = numberMarkdownLines(source);
  assert.equal(view, 'L000001 | 第一行\nL000002 | \nL000003 | 第二行\nL000004 | 第三行');
  assert.equal(restoreNumberedView(view), '第一行\n\n第二行\n第三行');
});

test('超长中文和 emoji 分片后仍逐字一致', () => {
  const source = `开始${'参数😀'.repeat(30)}结束`;
  const view = numberMarkdownLines(source, { maxLineChars: 24 });
  assert.match(view, /^L000001\[1\/\d+\] \| /u);
  assert.equal(restoreNumberedView(view), source);
  for (const displayLine of view.split('\n')) {
    const content = displayLine.replace(/^L\d+\[\d+\/\d+\] \| /u, '');
    assert.doesNotMatch(content, /[\uD800-\uDBFF]$/u);
    assert.doesNotMatch(content, /^[\uDC00-\uDFFF]/u);
  }

  const minimumView = numberMarkdownLines('😀😀', { maxLineChars: 1 });
  assert.equal(restoreNumberedView(minimumView), '😀😀');
  assert.ok(minimumView.split('\n').every(line => !/[\uD800-\uDBFF]$/u.test(line) && !/\| [\uDC00-\uDFFF]/u.test(line)));

  const fractionalLimitView = numberMarkdownLines('小数上限不会死循环', { maxLineChars: 0.5 });
  assert.equal(restoreNumberedView(fractionalLimitView), '小数上限不会死循环');
});

test('Markdown 表格和图片在长行视图中保持完整', () => {
  const image = '![现场图](yibiao-asset://imported-images/方案/现场.png)';
  const source = `| 名称 | ${'设备参数'.repeat(20)} | ${image} |`;
  const view = numberMarkdownLines(source, { maxLineChars: 30 });
  assert.equal(restoreNumberedView(view), source);
  assert.ok(view.split('\n').some(line => line.includes(image)), 'Markdown 图片不得被拆开');
  assert.ok(view.split('\n').every(line => line.startsWith('L000001[')), '表格行分片必须保持同一真实行号');

  const complexImages = [
    '![嵌套地址](assets/a(b)c.png "现场图")',
    "![撇号地址](assets/team's-photo.png)",
    '![转义\\]说明][现场图片]',
    '![快捷引用]',
  ];
  const complexSource = `开头 ${complexImages.join(' 中间 ')} 结尾`;
  const complexView = numberMarkdownLines(complexSource, { maxLineChars: 12 });
  assert.equal(restoreNumberedView(complexView), complexSource);
  for (const complexImage of complexImages) {
    assert.ok(complexView.split('\n').some(line => line.includes(complexImage)), `复杂 Markdown 图片不得被拆开：${complexImage}`);
  }
});

test('HTML 表格和图片在长行视图中保持完整', () => {
  const image = '<img src="yibiao-asset://imported-images/方案/设备.png" alt="1 > 0 的设备">';
  const source = `<table><tr><td>${'技术参数'.repeat(40)}</td><td>${image}</td></tr></table>`;
  const view = numberMarkdownLines(source, { maxLineChars: 40 });
  assert.equal(restoreNumberedView(view), source);
  assert.ok(view.split('\n').some(line => line.includes(image)), 'HTML 图片标签不得被拆开');
  assert.ok(view.split('\n').every(line => !/<[^>]*$/u.test(line.replace(/^L\d+\[\d+\/\d+\] \| /u, ''))), 'HTML 标签不得从中间拆开');

  const compactTable = `<table><tr>${'<td></td>'.repeat(100)}</tr></table>`;
  const compactView = numberMarkdownLines(compactTable, { maxLineChars: 40 });
  assert.ok(compactView.includes('\n'), '连续 HTML 标签组成的超长表格也应分片');
  assert.equal(restoreNumberedView(compactView), compactTable);

  const defaultLimitTable = `<table><tr><td>${'参数'.repeat(13000)}</td></tr></table>`;
  const defaultLimitView = numberMarkdownLines(defaultLimitTable);
  assert.ok(defaultLimitView.includes('\n'), '默认配置应拆分两万字符以上的单行表格');
  assert.equal(restoreNumberedView(defaultLimitView), defaultLimitTable);
});
