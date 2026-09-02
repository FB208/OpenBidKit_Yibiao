const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadExportStateModule() {
  const sourcePath = path.join(__dirname, 'exportState.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const { hasExportableRejectionResults } = loadExportStateModule();

function result(status, inputSignature, findingCount = 0) {
  return {
    status,
    inputSignature,
    findings: Array.from({ length: findingCount }, (_, index) => ({ id: String(index) })),
  };
}

test('至少一个当前签名结果成功时允许导出零问题报告', () => {
  assert.equal(hasExportableRejectionResults({
    rejectionCheckResult: result('idle', 'rejection-current'),
    typoCheckResult: result('success', 'bid-current'),
    logicCheckResult: result('idle', 'bid-current'),
    rejectionInputSignature: 'rejection-current',
    bidSignature: 'bid-current',
  }), true);
});

test('当前签名结果已有 finding 时即使状态错误也允许导出', () => {
  assert.equal(hasExportableRejectionResults({
    rejectionCheckResult: result('error', 'rejection-current', 1),
    typoCheckResult: result('error', 'bid-current'),
    logicCheckResult: result('idle', 'bid-current'),
    rejectionInputSignature: 'rejection-current',
    bidSignature: 'bid-current',
  }), true);
});

test('旧签名结果和仅错误空结果不能启用导出', () => {
  assert.equal(hasExportableRejectionResults({
    rejectionCheckResult: result('success', 'rejection-old', 2),
    typoCheckResult: result('error', 'bid-current'),
    logicCheckResult: result('success', 'bid-old', 1),
    rejectionInputSignature: 'rejection-current',
    bidSignature: 'bid-current',
  }), false);
});
