const test = require('node:test');
const assert = require('node:assert/strict');
const { generateHtmlIllustration } = require('./contentIllustrationGeneration.cjs');

const png = Buffer.from('89504e470d0a1a0a', 'hex');

function createExecution() {
  return {
    planItem: {
      item_id: 'html-1',
      kind: 'html',
      image_type: '系统架构与拓扑图',
      title: '总体系统架构图',
      section_ids: ['1.1'],
      placement: 'after',
      generation: {},
    },
    reference: '实施方案正文',
  };
}

function createWorkspaceStore(overrides = {}) {
  return {
    readIllustrationHtml: () => '',
    findIllustrationHtml: () => null,
    saveIllustrationHtml: ({ content }) => {
      assert.match(content, /<html\b/i);
      return { relativePath: 'illustrations/revision/html/html-1.html' };
    },
    saveIllustrationPng: ({ buffer }) => {
      assert.deepEqual(buffer, png);
      return { assetUrl: 'yibiao-asset://generated-images/html-1.png' };
    },
    ...overrides,
  };
}

test('HTML 生图提示词禁止文字变形，并将布局诊断反馈给修复请求', async () => {
  const prompts = [];
  let probeCount = 0;
  let renderCount = 0;
  const result = await generateHtmlIllustration({
    aiService: {
      chat: async ({ messages }) => {
        prompts.push(messages[0].content);
        return '<!doctype html><html><head></head><body>修复后的架构图</body></html>';
      },
    },
    execution: createExecution(),
    plan: { revision: 'revision' },
    workspaceStore: createWorkspaceStore(),
    localImageRenderService: {
      probeHtmlLayoutOnly: async () => {
        probeCount += 1;
        return {
          width: 1240,
          height: 600,
          layout_issues: probeCount === 1 ? ['文字存在旋转、倒置、镜像或缩放变形：div.label'] : [],
        };
      },
      renderHtmlToPng: async () => {
        renderCount += 1;
        return {
          buffer: png,
          width: 1240,
          height: 600,
          layout_issues: [],
        };
      },
    },
    runAgentHtml: async () => { throw new Error('普通 HTML 生图不应启动 Agent'); },
  });

  assert.match(prompts[0], /文字不得旋转、倒置、镜像或缩放变形/);
  assert.equal(probeCount, 2);
  assert.equal(renderCount, 1);
  assert.match(prompts[1], /文字存在旋转、倒置、镜像或缩放变形/);
  assert.equal(result.visual_qa.layout_repair_attempts, 1);
});

test('HTML 布局问题连续两轮修复后直接生成一次 PNG', async () => {
  let probeCount = 0;
  let renderCount = 0;
  const result = await generateHtmlIllustration({
    aiService: { chat: async () => '<!doctype html><html><head></head><body>待修复图</body></html>' },
    execution: createExecution(),
    plan: { revision: 'revision' },
    workspaceStore: createWorkspaceStore(),
    localImageRenderService: {
      probeHtmlLayoutOnly: async () => {
        probeCount += 1;
        return {
          width: 1240,
          height: 600,
          layout_issues: ['文字被前景元素遮挡：div.card 被 div.core 覆盖'],
        };
      },
      renderHtmlToPng: async () => {
        renderCount += 1;
        return {
          buffer: png,
          width: 1240,
          height: 600,
          layout_issues: ['文字被前景元素遮挡：div.card 被 div.core 覆盖'],
        };
      },
    },
    runAgentHtml: async () => { throw new Error('普通 HTML 生图不应启动 Agent'); },
  });

  assert.equal(probeCount, 2);
  assert.equal(renderCount, 1);
  assert.equal(result.visual_qa.layout_repair_attempts, 2);
});
