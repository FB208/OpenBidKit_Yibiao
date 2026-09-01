const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadExportStateModule() {
  const source = fs.readFileSync(path.join(__dirname, 'exportState.ts'), 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const { hasExportableDuplicateResults } = loadExportStateModule();

test('当前签名任一分析成功时允许导出零重复报告', () => {
  assert.equal(hasExportableDuplicateResults({
    metadataAnalysis: { status: 'success', signature: 'current', rows: [] },
    signature: 'current',
  }), true);
});

test('当前签名已产生目录相似度时即使状态错误也允许导出', () => {
  assert.equal(hasExportableDuplicateResults({
    outlineAnalysis: { status: 'error', signature: 'current', duplicateGroups: [], pairwiseSimilarities: [{ score: 0.5 }] },
    signature: 'current',
  }), true);
});

test('旧签名结果和仅错误空结果不能启用查重导出', () => {
  assert.equal(hasExportableDuplicateResults({
    metadataAnalysis: { status: 'success', signature: 'old', rows: [{ key: 'creator' }] },
    contentAnalysis: { status: 'error', signature: 'current', duplicateSentences: [] },
    imageAnalysis: { status: 'success', signature: 'old', duplicateImages: [{ id: 'image' }] },
    signature: 'current',
  }), false);
});
