const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('./localImageRenderService.cjs');

test('HTML 布局探针覆盖文字变形、裁切、遮挡和重叠，不把竖排文字列为问题', () => {
  const probe = __test__.buildHtmlLayoutProbeScript();
  assert.match(probe, /文字存在旋转、倒置、镜像或缩放变形/);
  assert.match(probe, /文字被容器裁切/);
  assert.match(probe, /文字被前景元素遮挡/);
  assert.match(probe, /文字内容发生重叠/);
  assert.doesNotMatch(probe, /writing-mode/);
});
