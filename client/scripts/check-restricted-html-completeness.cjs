// 验证正式源码完整性校验和正文生成保存入口；用户正文目录只读。
// 用法：node scripts/check-restricted-html-completeness.cjs "正文目录"
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { findHtmlStructureIssues, assertHtmlStructure } = require('../electron/utils/htmlStructure.cjs');
const { createContentGenerationTools } = require('../electron/services/contentGenerationAgent.cjs');

const sectionDir = process.argv[2];
if (!sectionDir) throw new Error('请传入需要验证的正文目录；脚本只读取该目录。');
const incidentFile = 'd7d9af0b-37d5-4e9d-aa0b-9c8f24a24b90.html';
const prefix = '<!-- yibiao:block -->\n<p>完整的中文正文。</p>\n';

const validCases = [
  ['中文正文片段', prefix],
  ['Windows 换行和 BOM', `\uFEFF${prefix.replace(/\n/g, '\r\n')}`],
  ['合法列表及可省略的 li 结束标签', `${prefix}<ul><li>甲<li>乙</ul>`],
  ['合法表格及可省略的单元格结束标签', `${prefix}<table><tbody><tr><td>甲<td>乙</table>`],
  ['属性里的大于号', `${prefix}<p title="阈值 > 10">完整内容</p>`],
  ['文本比较符和连接符', `${prefix}<p>数值 1 < 2，A & B。</p>`],
  ['转义后的标签示例', `${prefix}<p>&lt;ul id=&quot;s_1_&quot;&gt;</p>`],
  ['完整注释含标签示例', `${prefix}<!-- 示例：<ul id="s_1_ -->`],
  ['完整图片框和提示词', `${prefix}<figure data-yb-size="wide"><template>中文图示</template><img alt="图片"><figcaption>图注</figcaption></figure>`],
  ['完整内联格式及空元素', `${prefix}<p><strong>重点</strong><br><em>说明</em></p>`],
];
const truncatedCases = [
  ['真实故障形态', '<ul id="s_1_'],
  ['标签名未写完', '<tabl'],
  ['属性名未写完', '<ul data-yb'],
  ['双引号未闭合', '<p title="中文内容'],
  ['单引号未闭合', "<p title='中文内容"],
  ['引号已闭合但缺少大于号', '<ul id="s_1_"'],
  ['无引号属性未结束', '<ul id=s_1_'],
  ['属性等号后结束', '<ul id='],
  ['只写了左尖括号', '<'],
  ['只写了结束标签前缀', '</'],
  ['结束标签未写完', '<ul><li>项目</li></ul'],
  ['注释未结束', '<!-- yibiao:block'],
  ['注释结束符未写完', '<!-- 中文 --'],
  ['图片空元素未写完', '<figure data-yb-size="wide"><img alt="图" /'],
];

// 合法样例确保新增检测不把正常 HTML 片段误判为截断。
test(`正常受限 HTML：${validCases.length} 个样例全部通过`, () => {
  for (const [name, html] of validCases) assert.doesNotThrow(() => assertHtmlStructure(html, { checkSourceCompleteness: true }), name);
});

// 截断样例覆盖标签名、属性、引号、结束标签及注释的不同中断位置。
test(`源码截断：${truncatedCases.length} 个样例全部拒绝`, () => {
  for (const [name, tail] of truncatedCases) {
    const html = prefix + tail;
    assert.ok(findHtmlStructureIssues(html, { checkSourceCompleteness: true }).some(issue => issue.includes('eof-')), `${name} 未产生源码截断诊断`);
    assert.throws(() => assertHtmlStructure(html, { checkSourceCompleteness: true }), /HTML 结构不完整/, name);
  }
});

// 解析器 EOF 回调不能替代既有的元素闭合和图片结构检查。
test('保留原结构约束：缺少 ul 结束标签、图片被包裹仍拒绝', () => {
  assert.throws(() => assertHtmlStructure(`${prefix}<ul><li>项目</li>`, { checkSourceCompleteness: true }), /缺少结束标签/);
  assert.throws(() => assertHtmlStructure(`${prefix}<figure data-yb-size="wide"><strong><img alt="图"></strong></figure>`, { checkSourceCompleteness: true }), /直接子元素/);
});

// 读取故障副本，验证默认行为不变，开启源码检查后能定位并拒绝。
test('真实故障：默认检查通过，开启源码检查后定位第 50 行并拒绝', () => {
  const html = fs.readFileSync(path.join(sectionDir, incidentFile), 'utf8');
  assert.ok(html.endsWith('<ul id="s_1_'), '传入的故障副本已变化，不再是原始截断样本');
  assert.deepEqual(findHtmlStructureIssues(html), []);
  assert.deepEqual(findHtmlStructureIssues(html, { checkSourceCompleteness: false }), []);
  assert.deepEqual(findHtmlStructureIssues(html, { checkSourceCompleteness: true }), ['第 50 行第 13 列：标签尚未结束（eof-in-tag）']);
  assert.throws(() => assertHtmlStructure(html, { checkSourceCompleteness: true }), /第 50 行第 13 列：标签尚未结束（eof-in-tag）/);
  // 只在内存构造对照，证明故障由末尾残缺标签触发，不写回原文件。
  assert.doesNotThrow(() => assertHtmlStructure(html.slice(0, -'<ul id="s_1_'.length), { checkSourceCompleteness: true }));
});

// 全量对照本次工作区，检查新规则是否额外拒绝其他正文。
test('真实工作区：只拒绝已知异常小节，其余正文全部通过', () => {
  const files = fs.readdirSync(sectionDir).filter(file => file.endsWith('.html')).sort();
  assert.ok(files.length > 1, '需要完整正文目录进行对照');
  const rejected = files.filter(file => {
    return findHtmlStructureIssues(fs.readFileSync(path.join(sectionDir, file), 'utf8'), { checkSourceCompleteness: true }).length;
  });
  assert.deepEqual(rejected, [incidentFile]);
  console.log(`真实正文：共 ${files.length} 节，拒绝 ${rejected.length} 节，通过 ${files.length - rejected.length} 节。`);
});

// 明确能力边界：在完整段落之后停止，不能靠 HTML 结构推断还有正文未写。
test('边界：完整段落后结束仍通过，不声称能检测语义上的少写', () => {
  assert.doesNotThrow(() => assertHtmlStructure('<p>第一段已完成。</p>', { checkSourceCompleteness: true }));
});

// 用最小中文工作区调用真实生成工具；仅替换 AI 回复，不连接模型或读写用户任务。
async function runGeneration(t, html, previousHtml) {
  const { Type } = await import('typebox');
  const workspaceDir = fs.mkdtempSync(path.join(__dirname, '.html-completeness-'));
  t.after(() => {
    // 只清理由本脚本创建且仍位于脚本目录内的临时工作区。
    assert.equal(path.dirname(path.resolve(workspaceDir)), path.resolve(__dirname));
    assert.ok(path.basename(workspaceDir).startsWith('.html-completeness-'));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  const id = 'd7d9af0b-37d5-4e9d-aa0b-9c8f24a24b90';
  const section = { id, number: '1.2.21', title: '到货通知机制', file: `正文/${id}.html`,
    content_plan: { target_words: 0, image_needed: false, table: { needed: false } } };
  const decisions = { targets: [section], has_knowledge_base: false, global_facts_requirements: '',
    image_requirements: '', word_requirements: '', user_requirement: '' };
  fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), JSON.stringify(decisions), 'utf8');
  for (const file of ['项目概述.md', '全局事实设定.md', '受限HTML生成规范.md', '配图类型对照表.md', '正文模板.html', '所选模板配置.json']) {
    fs.writeFileSync(path.join(workspaceDir, file), file === '所选模板配置.json' ? '{}' : '验证材料', 'utf8');
  }
  fs.mkdirSync(path.join(workspaceDir, '任务'));
  fs.writeFileSync(path.join(workspaceDir, '任务', '正文生成.json'), JSON.stringify({
    sections: [{ section_id: id, instructions: '', references: '', ...(previousHtml ? { regenerate: true } : {}) }],
  }), 'utf8');
  const target = path.join(workspaceDir, section.file);
  if (previousHtml) {
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, previousHtml, 'utf8');
  }
  const progress = [];
  const updates = [];
  const activity = [];
  const tool = createContentGenerationTools({
    aiService: { async chat() { return html; } },
    onProgress: value => progress.push(value), onActivity: value => activity.push(value),
  }, { Type, workspaceDir }).find(item => item.name === 'generate-sections');
  const result = await tool.execute('completeness-check', {}, undefined, value => updates.push(value));
  return { result: result.details.results[0], target, progress, updates, activity };
}

// 残缺源码必须以小节失败返回，不能写文件或报告保存成功。
test('生成入口：残缺回复返回失败且不落盘', async t => {
  const output = await runGeneration(t, prefix + '<ul id="s_1_');
  assert.equal(output.result.status, 'error');
  assert.match(output.result.error, /标签尚未结束（eof-in-tag）/);
  assert.equal(fs.existsSync(output.target), false);
  assert.equal(fs.existsSync(`${output.target}.tmp`), false);
  assert.deepEqual(output.progress, []);
  assert.ok(output.updates.every(update => update.details.status === 'error'));
  assert.ok(output.activity.every(event => event.progress.items.every(item => item.status !== 'success')));
});

// 重新生成的校验失败应保留原文件，不覆盖已有正文。
test('生成入口：重写失败保留原文件', async t => {
  const previous = '<p>这段原正文必须保留。</p>';
  const output = await runGeneration(t, prefix + '<!-- 未结束', previous);
  assert.equal(output.result.status, 'error');
  assert.match(output.result.error, /注释尚未结束（eof-in-comment）/);
  assert.equal(fs.readFileSync(output.target, 'utf8'), previous);
  assert.equal(fs.existsSync(`${output.target}.tmp`), false);
  assert.deepEqual(output.progress, []);
});

// 完整回复继续按现有流程保存，并返回成功进度。
test('生成入口：正常回复原样保存并返回成功', async t => {
  const output = await runGeneration(t, prefix);
  assert.equal(output.result.status, 'success');
  assert.equal(fs.readFileSync(output.target, 'utf8'), prefix.trim());
  assert.equal(fs.existsSync(`${output.target}.tmp`), false);
  assert.equal(output.progress.length, 1);
  assert.equal(output.progress[0].status, 'success');
  assert.equal(output.updates[0].details.status, 'success');
});
