const assert = require('node:assert/strict');
const { readOoxmlPart } = require('@docx-editor.dev/core/store');

// 使用固定行高创建段落，换行用于区分首段完整保留与仅保留首行。
function paragraph(text, lineHeight = 10, keepNext = false) {
  const runs = text.split('\n').map((line) => `<w:t>${line}</w:t>`).join('<w:br/>');
  return `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="0" w:after="0" w:line="${lineHeight * 20}" w:lineRule="exact"/></w:pPr><w:r>${runs}</w:r></w:p>`;
}

// 清除单元格内边距，让每个分页场景只由内容高度决定；height 用于覆盖 w:trHeight。
function row(contents, cantSplit = false, height) {
  const margins = ['top', 'left', 'bottom', 'right'].map((side) => `<w:${side} w:w="0" w:type="dxa"/>`).join('');
  const cells = contents.map((content) => `<w:tc><w:tcPr><w:tcMar>${margins}</w:tcMar></w:tcPr>${content}</w:tc>`).join('');
  const trHeight = height ? `<w:trHeight w:val="${height.valuePt * 20}" w:hRule="${height.rule}"/>` : '';
  return `<w:tr><w:trPr>${cantSplit ? '<w:cantSplit/>' : ''}${trHeight}</w:trPr>${cells}</w:tr>`;
}

// 创建无边框表格；同一构造同时用于章节外框和嵌套业务表。
function table(rows, columns = 1) {
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${6000 / columns}"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

// 从真实分页结果递归提取文字，包含章节单元格中的嵌套表格。
function fragmentText(fragments) {
  return fragments.map((fragment) => fragment.kind === 'paragraph'
    ? fragment.lines.map((line) => line.spans.map((span) => span.text).join('')).join('\n')
    : fragment.rows.map((item) => item.cells.map((cell) => fragmentText(cell.blocks || cell.fragments || [])).join('\n')).join('\n')).join('\n');
}

// 使用公开 OOXML 解析与无 DOM 排版接口运行一个小型文档。
function layoutBody(api, body) {
  const result = readOoxmlPart(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`, {
    name: '/word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  });
  assert.equal(result.ok, true, '定向检查文档应能被真实 OOXML 解析器读取');
  const layout = api.layoutSemanticDocument(result.part, 0, {
    geometry: { width: 300, height: 100, margin: { top: 0, right: 0, bottom: 0, left: 0 } },
    measurer: api.createFixedMeasurer(5, 10),
  });
  return layout;
}

function paginate(api, body) {
  return layoutBody(api, body).pages.map((page) => fragmentText(page.fragments));
}

// 取指定页上所有表格行的高度，用于校验 w:trHeight 约束是否保留。
function rowHeights(layout, page) {
  return layout.pages[page].fragments
    .filter((fragment) => fragment.kind === 'table')
    .flatMap((fragment) => fragment.rows.map((item) => item.box.height));
}

// 按唯一文字标记断言所在页，并同时防止内容丢失或重复。
function expectPage(pages, text, page, message) {
  const actual = pages.flatMap((content, index) => content.includes(text) ? [index] : []);
  assert.deepEqual(actual, [page], `${message}；实际分页：${JSON.stringify(pages)}`);
}

// 同一组真实布局检查覆盖可拆行、禁拆行和标题的纵向/横向关联。
function checkPagination(api, label) {
  const body = Array.from({ length: 8 }, (_, index) => paragraph(`正文${index}`)).join('');
  let pages = paginate(api, paragraph('前置内容', 60) + table([row([body])]));
  expectPage(pages, '正文0', 0, `${label}：可拆正文应先使用当前页`);
  expectPage(pages, '正文7', 1, `${label}：剩余正文应自然续页`);

  // 最小行高放不下当前页剩余空间时必须整体换页，否则行会缩水成内容高度。
  const atLeastLayout = layoutBody(api, paragraph('前置内容', 65)
    + table([row([paragraph('最小行高内容')], false, { valuePt: 80, rule: 'atLeast' })]));
  pages = atLeastLayout.pages.map((page) => fragmentText(page.fragments));
  expectPage(pages, '最小行高内容', 1, `${label}：最小行高放不下剩余空间时应整体换页`);
  assert.deepEqual(rowHeights(atLeastLayout, 1), [80], `${label}：换页后应保留 atLeast 最小行高`);

  // 最小行高本身放得下时仍要流式拆分，避免上一条换页规则误伤可拆行。
  pages = paginate(api, paragraph('前置内容', 60)
    + table([row([body], false, { valuePt: 10, rule: 'atLeast' })]));
  expectPage(pages, '正文0', 0, `${label}：最小行高放得下时可拆行应先使用当前页`);
  expectPage(pages, '正文7', 1, `${label}：最小行高放得下时剩余正文应自然续页`);

  // 固定行高会压缩单元格容量，关联块放不下时应退回原排版裁切，不能整格丢字。
  const exactLayout = layoutBody(api, table([row([paragraph('固定行高标题', 10, true) + paragraph('固定行高正文', 30)],
    false, { valuePt: 20, rule: 'exact' })]));
  pages = exactLayout.pages.map((page) => fragmentText(page.fragments));
  expectPage(pages, '固定行高标题', 0, `${label}：固定行高行的关联标题不应被整体丢弃`);
  assert.equal(pages.some((page) => page.includes('固定行高正文')), false,
    `${label}：超出固定行高的正文应被裁切；实际分页：${JSON.stringify(pages)}`);
  assert.deepEqual(rowHeights(exactLayout, 0), [20], `${label}：固定行高应保持 exact 高度`);

  pages = paginate(api, paragraph('前置内容', 60) + table([row([body], true)]));
  expectPage(pages, '正文0', 1, `${label}：CantSplit 行应整体换页`);
  expectPage(pages, '正文7', 1, `${label}：CantSplit 行不可拆成多页`);

  // 页面高 100、重复表头高 20，85 高的关联块必须允许拆分，不能挤掉续页表头。
  const header = row([paragraph('重复表头', 20)]).replace('<w:trPr>', '<w:trPr><w:tblHeader/>');
  const linkedBody = paragraph(Array.from({ length: 7 }, (_, index) => `关联正文${index}`).join('\n'));
  pages = paginate(api, table([header, row([paragraph('关联标题', 15, true) + linkedBody])]));
  assert.deepEqual(pages.map((page) => page.includes('重复表头')), [true, true], `${label}：两页都应保留重复表头`);
  expectPage(pages, '关联标题', 0, `${label}：关联块超过扣除表头后的容量时应正常开始排版`);
  expectPage(pages, '关联正文0', 0, `${label}：正文应利用首页剩余空间`);
  expectPage(pages, '关联正文6', 1, `${label}：剩余正文应在重复表头下续排`);

  pages = paginate(api, paragraph('前置内容', 65) + table([
    row([paragraph('独立标题', 10, true)], true),
    row([paragraph('首段甲\n首段乙\n首段丙') + paragraph('后续正文')]),
  ]));
  expectPage(pages, '独立标题', 1, `${label}：标题应与完整首段一起换页`);
  expectPage(pages, '首段甲', 1, `${label}：标题后首段开头应同页`);
  expectPage(pages, '首段丙', 1, `${label}：标题后首段结尾应同页`);

  const nested = table([row([paragraph('嵌套表内容', 50)], true)]);
  pages = paginate(api, paragraph('前置内容', 40) + table([row([
    paragraph('表前正文') + paragraph('业务表题', 10, true) + nested + paragraph('表后正文'),
  ])]));
  expectPage(pages, '表前正文', 0, `${label}：表前正文不应被后续表格带走`);
  expectPage(pages, '业务表题', 1, `${label}：表题应与嵌套表一起换页`);
  expectPage(pages, '嵌套表内容', 1, `${label}：嵌套表应与表题同页`);

  pages = paginate(api, paragraph('前置内容', 80) + table([row([
    paragraph('左栏标题', 10, true),
    paragraph('右栏首段甲\n右栏首段乙\n右栏首段丙'),
  ])], 2));
  expectPage(pages, '左栏标题', 1, `${label}：左栏标题应与右栏首段一起换页`);
  expectPage(pages, '右栏首段甲', 1, `${label}：右栏首段开头应跟随左栏标题`);
  expectPage(pages, '右栏首段丙', 1, `${label}：右栏首段结尾应跟随左栏标题`);
}

// 两个公开入口都运行，避免只补到浏览器或 CommonJS 一侧。
async function main() {
  checkPagination(require('@docx-editor.dev/core/layout'), 'CommonJS');
  checkPagination(await import('@docx-editor.dev/core/layout'), 'ESM');
  console.log('DOCX 表格分页定向检查通过（CommonJS / ESM）。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
