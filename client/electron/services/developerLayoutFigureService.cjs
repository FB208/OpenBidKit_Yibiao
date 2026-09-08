const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir } = require('../utils/paths.cjs');
const { getLocalImageRenderService, HTML_DESIGN_WIDTH } = require('./localImageRenderService.cjs');

/**
 * 开发者版面预算测试专用的配图生成。
 *
 * 与正式链路的区别只有一个：画框比例由版面预算先定死，生成环节负责把图**做成这个比例**，
 * 而不是先生成再想办法塞进去。html 图因此按目标高宽比精确截图，mermaid 和 AI 图
 * 交给 C# 侧按画框居中裁切。
 *
 * 产物落在独立的工作区目录，不与模板样张资源混在一起。
 */
const DEVELOPER_FIGURE_ASSET_ROOT = 'developer-layout-assets';

/**
 * 画框是宽还是高，决定 mermaid 该往哪个方向铺。
 * 渲染器是按画框比例居中裁切的，方向选错就会把两侧内容切掉，
 * 所以方向必须跟着版面预算给的比例走。
 */
function resolveFlowDirection(aspectWidth, aspectHeight) {
  const ratio = aspectWidth / aspectHeight;
  if (ratio >= 1.3) return { code: 'LR', label: '从左到右横向铺陈' };
  if (ratio <= 0.85) return { code: 'TD', label: '从上到下纵向铺陈' };
  return { code: 'TD', label: '从上到下，层级尽量均衡，接近方形' };
}

/** mermaid 一次渲染的最大节点数说明与正式链路保持一致，避免图过密看不清。 */
function buildMermaidMessages(prompt, caption, direction) {
  return [
    {
      role: 'system',
      content: `你是投标技术方案 Mermaid 图生成助手。

要求：
1. 只返回 JSON，不要输出解释或 Markdown。
2. 只能使用 flowchart TD/TB/LR/RL/BT 语法，不得使用 graph 别名。
2.1 本次必须使用 flowchart ${direction.code}：图会按固定画框比例裁切，${direction.label}才不会被切掉内容。
3. 中文节点标签写成 A["中文标签"]。
4. 不使用 & 多节点连接简写，不使用分号，每行只写一个语句。
5. 节点不超过 12 个，单个节点文字不超过 16 个汉字。
6. code 不包含 Markdown 代码围栏。`,
    },
    {
      role: 'user',
      content: `图题：${caption || '流程图'}\n\n配图要求：\n${prompt}\n\n请返回：\n{\n  "code": "flowchart ${direction.code}..."\n}`,
    },
  ];
}

/**
 * html 图的提示词直接给死目标画布尺寸。
 * 版面预算已经算出这张图在页面上占多宽多高，html 就照这个比例画，
 * 截图时再按同一尺寸精确捕获，中间不存在"高度自适应之后再想办法适配"的环节。
 */
function buildHtmlPrompt(prompt, caption, width, height) {
  return `阅读并理解以下配图要求，用 HTML 绘制一张信息图。

图题：${caption || '信息图'}

配图要求：
${prompt}

硬性尺寸要求：
- 画布固定为 ${width}px 宽、${height}px 高，内容必须完整填满这个画布且不得溢出、不得出现滚动条。
- 按这个宽高比组织版式：${width > height ? '横向铺陈，优先左右分栏' : width < height ? '纵向铺陈，优先上下分层' : '方形构图，中心对称或九宫格'}。
- 正文和节点文字不小于 24px，主要信息节点控制在 12 个以内，不得靠缩小字号强塞内容。
- 文字不得旋转、变形、重叠、被遮挡或被容器裁切；不使用固定或粘性定位。
- 专业商务风格，不依赖在线字体或任何外部资源。

只返回完整的 HTML 文档（含 html、head、body），不要任何解释文字，不要 Markdown 代码围栏。`;
}

/** 把画框比例换成生图服务商能接受的 WxH，长边 1024，短边取 64 的整数倍。 */
function buildImageSize(aspectWidth, aspectHeight) {
  const round64 = (value) => Math.max(64, Math.round(value / 64) * 64);
  return aspectWidth >= aspectHeight
    ? `1024x${round64(1024 * aspectHeight / aspectWidth)}`
    : `${round64(1024 * aspectWidth / aspectHeight)}x1024`;
}

function stripHtmlFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function normalizeMermaidResult(value) {
  const code = String(value?.code || '').trim();
  return { code: code.replace(/^```(?:mermaid)?\s*|\s*```$/g, '').trim() };
}

function createDeveloperLayoutFigureService({ app, aiService, localImageRenderService = null }) {
  const renderService = () => localImageRenderService || getLocalImageRenderService();

  function assetDir() {
    const dir = path.join(getWorkspaceDir(app), DEVELOPER_FIGURE_ASSET_ROOT, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 每轮生成前清掉上一轮的图，避免工作区无限增长。 */
  function reset() {
    const dir = assetDir();
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    return { assetRoot: DEVELOPER_FIGURE_ASSET_ROOT, dir };
  }

  /**
   * 把模板占位图补进测试资源目录。
   * 关闭真实生图、章节本来就没有配图、某张图生成失败退回占位图，这几种情况下
   * 组装出来的 HTML 都会引用模板那几张 webp，不补进来 Word 侧会报"图片资产不存在"；
   * 目录本身也可能还没建过（纯文字那条路不会调 reset），这里一并保证。
   * 只复制不清理：目录里还躺着本轮真实生成的图，不能按模板资源对齐。
   */
  function ensurePlaceholderAssets() {
    const dir = assetDir();
    const sourceDir = path.join(app.getAppPath(), 'assets', 'content-template-preview');
    for (const name of fs.readdirSync(sourceDir)) {
      if (!name.toLowerCase().endsWith('.webp')) continue;
      const source = path.join(sourceDir, name);
      const target = path.join(dir, name);
      const sourceStat = fs.statSync(source);
      const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (targetStat && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        continue;
      }
      fs.copyFileSync(source, target);
    }
    return DEVELOPER_FIGURE_ASSET_ROOT;
  }

  function writeAsset(id, buffer, extension = 'png') {
    const fileName = `${id}.${extension}`;
    fs.writeFileSync(path.join(assetDir(), fileName), buffer);
    return `assets/${fileName}`;
  }

  async function renderMermaid({ id, prompt, caption, aspectWidth, aspectHeight }) {
    const direction = resolveFlowDirection(aspectWidth, aspectHeight);
    const generated = await aiService.collectJsonResponse({
      messages: buildMermaidMessages(prompt, caption, direction),
      logTitle: `版面测试-Mermaid-${id}`,
      progressLabel: 'Mermaid 配图生成',
      failureMessage: '模型返回的 Mermaid 配图格式无效',
      normalizer: normalizeMermaidResult,
      validator: (result) => {
        if (!result.code) throw new Error('Mermaid code 为空');
        if (!/^flowchart\s+(TD|TB|LR|RL|BT)\b/i.test(result.code)) {
          throw new Error('只支持 flowchart TD/TB/LR/RL/BT');
        }
      },
    });
    const rendered = await renderService().renderMermaidToPng(generated.code);
    if (!rendered?.buffer?.length) throw new Error('Mermaid 本地转图失败');
    return {
      assetRef: writeAsset(id, rendered.buffer),
      width: rendered.width,
      height: rendered.height,
      source: generated.code,
    };
  }

  async function renderHtml({ id, prompt, caption, aspectWidth, aspectHeight }) {
    // 画布宽固定用本地转图的设计宽，高按画框比例推出来，比例即版面预算给的比例。
    const width = HTML_DESIGN_WIDTH;
    const height = Math.max(1, Math.round(width * (aspectHeight / aspectWidth)));
    const answer = await aiService.chat({
      messages: [{ role: 'user', content: buildHtmlPrompt(prompt, caption, width, height) }],
      logTitle: `版面测试-HTML图-${id}`,
    });
    const html = stripHtmlFence(answer);
    if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html) && !/<div[\s>]/i.test(html)) {
      throw new Error('模型未返回可渲染的 HTML');
    }
    const rendered = await renderService().renderExactHtmlToPng({ html, width, height, scale: 2 });
    if (!rendered?.buffer?.length) throw new Error('HTML 本地转图失败');
    return {
      assetRef: writeAsset(id, rendered.buffer),
      width: rendered.width,
      height: rendered.height,
      source: html,
    };
  }

  async function renderAiImage({ id, prompt, caption, aspectWidth, aspectHeight }) {
    const generated = await aiService.generateImage({
      title: caption || '配图',
      logTitle: `版面测试-AI生图-${id}`,
      prompt,
      style: 'technical_diagram',
      // 按画框比例下单，长边固定 1024；服务商不认这个尺寸时会退回它自己的配置值。
      size: buildImageSize(aspectWidth, aspectHeight),
    });
    if (!generated?.file_path) throw new Error('生图模型未返回本地图片地址');
    const buffer = fs.readFileSync(generated.file_path);
    const extension = path.extname(generated.file_path).replace('.', '') || 'png';
    return {
      assetRef: writeAsset(id, buffer, extension),
      width: 0,
      height: 0,
      source: generated.file_path,
    };
  }

  /** 生成一张图并落到测试资源目录，返回可直接写进 data-yb-asset-ref 的相对路径。 */
  async function renderFigure(payload = {}) {
    const id = String(payload.id || 'fig').replace(/[^\w-]/g, '') || 'fig';
    const request = {
      id,
      prompt: String(payload.prompt || '').trim(),
      caption: String(payload.caption || '').trim(),
      aspectWidth: Math.max(1, Number(payload.aspectWidth) || 1),
      aspectHeight: Math.max(1, Number(payload.aspectHeight) || 1),
    };
    if (!request.prompt) throw new Error('配图提示词为空');

    const started = Date.now();
    const result = payload.generation === 'mermaid'
      ? await renderMermaid(request)
      : payload.generation === 'htmlImage'
        ? await renderHtml(request)
        : payload.generation === 'aiImage'
          ? await renderAiImage(request)
          : (() => { throw new Error(`未知的配图方式：${payload.generation}`); })();

    return { ...result, id, generation: payload.generation, elapsedMs: Date.now() - started };
  }

  return { renderFigure, reset, ensurePlaceholderAssets, assetRoot: DEVELOPER_FIGURE_ASSET_ROOT };
}

module.exports = {
  DEVELOPER_FIGURE_ASSET_ROOT,
  createDeveloperLayoutFigureService,
};
