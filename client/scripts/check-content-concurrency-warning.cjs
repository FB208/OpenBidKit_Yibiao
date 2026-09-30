const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '../src/features/technical-plan/pages/ContentEditPage.tsx');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let start;
let dialog;
// 从真实页面提取启动入口和提醒弹窗，执行其行为，不复制判断逻辑。
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startGeneration') start = node.getText(source);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'AppDialog'
    && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'description'
      && prop.initializer?.getText(source) === '{concurrencyWarning}')) dialog = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(start && dialog, '页面必须保留启动入口和并发提醒弹窗');
const code = ts.transpileModule(`const ${start}; const renderWarning = () => (${dialog});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'element', jsxFragmentFactory: 'Fragment' },
}).outputText;

// 仅替换配置读取及任务提交，保留页面入口和按钮回调。
function setup(text, image, completedCount = 0) {
  const launches = [];
  const errors = [];
  const context = {
    config: { concurrency_limit: text, image_model: { concurrency_limit: image, status: 'available' } },
    generationStarting: { current: false }, taskBlocksGeneration: false, concurrencyWarning: '', generationSubmitting: false,
    outlineData: { outline: [{}] }, leaves: [{}, {}], completedCount,
    contentGenerationOptions: { useAiImages: false },
    ensureValidContentTemplate: async () => true,
    normalizeContentGenerationOptions: options => options,
    launchContentGeneration: async payload => launches.push(payload),
    showToast: (...args) => errors.push(args),
    setConcurrencyWarning: value => { context.concurrencyWarning = value; },
    setGenerationSubmitting: value => { context.generationSubmitting = value; },
    AppDialog: 'AppDialog', Fragment: 'Fragment',
    element: (type, props, ...children) => ({ type, props: { ...props, children } }),
  };
  context.window = { yibiao: { config: { load: async () => context.config } } };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, launches, errors, start: vm.runInContext('startGeneration', context), render: vm.runInContext('renderWarning', context) };
}

// 覆盖任一低并发、阈值、取消/关闭、确认、最新配置和重复提交。
async function main() {
  for (const [text, image] of [[10, 50], [50, 2], [49, 49]]) {
    const test = setup(text, image);
    await test.start();
    assert.equal(test.launches.length, 0);
    assert.equal(test.render().props.description, `当前设置的文本模型并发${text}，生图模型并发${image}，建议设置50或更高，否则生成速度会比较慢`);
    assert.equal(test.render().props.open, true, '关闭 AI 配图也检查生图并发');
    test.render().props.actions.props.children[0].props.onClick();
    assert.equal(test.render().props.open, false);
    assert.equal(test.launches.length, 0, '取消不启动任务');
    await test.start();
    test.render().props.onOpenChange(false);
    assert.equal(test.render().props.open, false);
    assert.equal(test.launches.length, 0, '关闭弹窗不启动任务');
  }
  for (const [text, image, completed, action] of [[50, 50, 0, 'start'], [60, 80, 1, 'continue'], [50, 50, 2, 'regenerate']]) {
    const test = setup(text, image, completed);
    await Promise.all([test.start(), test.start()]);
    assert.equal(test.launches.length, 1, '重复点击只提交一次');
    assert.equal(test.launches[0].contentGenerationAction, action);
    assert.equal(test.launches[0].regenerate, completed === 2);
    assert.equal(test.render().props.open, false);
  }
  const confirmed = setup(10, 2);
  await confirmed.start();
  confirmed.context.config = { concurrency_limit: 20, image_model: { concurrency_limit: 5, status: 'available' } };
  const proceed = confirmed.render().props.actions.props.children[1].props.onClick;
  proceed();
  proceed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed.launches.length, 1, '连续确认只提交一次且不重复弹窗');
  assert.equal(confirmed.launches[0].config, confirmed.context.config, '确认时重新读取最新配置');
  assert.equal(confirmed.render().props.open, false);
  assert.equal(confirmed.context.generationSubmitting, false);
  const missingTemplate = setup(10, 2);
  missingTemplate.context.ensureValidContentTemplate = async () => false;
  await missingTemplate.start();
  assert.equal(missingTemplate.render().props.open, false, '原有模板检查仍然优先');
  assert.equal(missingTemplate.launches.length, 0);
  const failed = setup(50, 50);
  failed.context.window.yibiao.config.load = async () => { throw new Error('读取配置失败'); };
  await failed.start();
  assert.equal(failed.launches.length, 0);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.context.generationStarting.current, false, '失败后解除提交锁');
  assert.equal(failed.context.generationSubmitting, false);
  console.log('正文低并发提醒检查通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
