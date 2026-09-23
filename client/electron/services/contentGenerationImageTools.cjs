const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Agent 的源码路径和正文图片引用均限定为当前工作区内的相对路径。
function resolveImageWorkspaceFile(workspaceDir, file) {
  if (!file || file.includes('\\') || path.isAbsolute(file) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file) || file.split('/').includes('..')) {
    throw new Error('图片或源码路径必须是当前工作区内使用正斜杠的相对路径');
  }
  return path.join(workspaceDir, file);
}

// 完成正文时检查真实图片引用，未生成的占位不得作为最终结果提交。
function validateContentImageReferences(workspaceDir, html) {
  const $ = require('cheerio').load(html, null, false);
  $('img').each((_index, element) => {
    const reference = $(element).attr('data-yb-asset-ref');
    if (!reference) throw new Error(`图片尚未生成或未填写 data-yb-asset-ref：${$(element).attr('alt') || '未命名图片'}`);
    const file = resolveImageWorkspaceFile(workspaceDir, reference);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`正文引用的图片文件不存在：${reference}`);
  });
}

// 三类图片均返回当前工作区资源路径；HTML、Mermaid 源码由主 Agent 自行编写。
function createContentGenerationImageTools({ aiService, signal, localImageRenderService }, { Type, workspaceDir }) {
  // 每次生成独立文件，失败或重新生成不会破坏此前已被正文引用的图片。
  function saveImage(buffer, extension) {
    const assetRef = `图片/${crypto.randomUUID()}${extension}`;
    fs.mkdirSync(path.join(workspaceDir, '图片'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, assetRef), buffer);
    return assetRef;
  }

  // 返回文字结果及结构化详情，不把图片二进制塞进模型上下文。
  function toolResult(result) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
  }

  return [{
    name: 'generate-image', label: 'AI 生图',
    description: '使用主程序生图配置生成单张图片，复制到当前工作区图片目录；返回原始结果及 asset_ref，供正文 img 的 data-yb-asset-ref 使用。',
    executionMode: 'sequential',
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: '描述图片的表达目的、主体、场景或结构关系，并给出必要的构图、风格及文字要求。提示词应与本节正文和对应图片用途一致。' }),
      title: Type.Optional(Type.String({ description: '图片标题' })),
      style: Type.Optional(Type.Union([Type.Literal('engineering_diagram'), Type.Literal('realistic_photo')], { description: 'engineering_diagram：工程图示风格，适用于示意、结构及原理表达；realistic_photo：写实照片风格，适用于实物和场景表达。省略时使用工程图示风格。' })),
      size: Type.Optional(Type.String({ description: '仅在明确当前生图服务支持的尺寸值时填写 size；否则省略该参数，使用主程序配置。正文中的 data-yb-size 表示排版画框比例，不可直接作为生图尺寸参数。' })),
    }, { additionalProperties: false }),
    // 沿用现有生图队列、重试及统计，只增加工作区内的图片副本。
    async execute(_callId, params, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      const result = await aiService.generateImage({ ...params, signal: combinedSignal });
      combinedSignal.throwIfAborted();
      const assetRef = saveImage(fs.readFileSync(result.file_path), path.extname(result.file_path));
      return toolResult({ ...result, asset_ref: assetRef });
    },
  }, ...['html', 'mermaid'].map(kind => ({
    name: `render-${kind}-image`, label: kind === 'html' ? 'HTML 转图片' : 'Mermaid 转图片',
    description: `读取 Agent 已写入的 ${kind === 'html' ? '独立配图 HTML，按正文 data-yb-size 对应的 frame_size 固定画布截图，画布内四周保留 40px 边距' : 'Mermaid 源文件'}，用主程序本地组件转为 PNG。返回 asset_ref、像素尺寸和源码路径；渲染失败时修改源码后重新调用。`,
    executionMode: 'sequential',
    parameters: Type.Object({
      source_file: Type.String({ minLength: 1, description: '当前工作区内的源码相对路径，如 图片/实施流程.html 或 图片/实施流程.mmd；使用 UTF-8，不带 Markdown 围栏。' }),
      ...(kind === 'html' ? { frame_size: Type.Union(['square', 'wide', 'tall', 'panorama'].map(value => Type.Literal(value)), { description: '与正文 figure 的 data-yb-size 一致。设计尺寸：square=1240×1240，wide=1240×827，tall=1240×1653，panorama=1240×698；尺寸包含四周40px内边距。按此尺寸编写HTML，程序以2倍像素输出。' }) } : {}),
    }, { additionalProperties: false }),
    // 适配原转图接口的暂停回调，渲染结束后再次检查取消状态再保存。
    async execute(_callId, { source_file, frame_size }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      const source = fs.readFileSync(resolveImageWorkspaceFile(workspaceDir, source_file), 'utf8');
      const renderer = localImageRenderService || require('./localImageRenderService.cjs').getLocalImageRenderService();
      const pauseOptions = { isPauseRequested: () => combinedSignal.aborted, createPauseError: () => combinedSignal.reason };
      const result = kind === 'html'
        ? await renderer.renderHtmlToPng(source, { ...pauseOptions, frameSize: frame_size })
        : await renderer.renderMermaidToPng(source, pauseOptions);
      combinedSignal.throwIfAborted();
      return toolResult({ success: true, source_file, asset_ref: saveImage(result.buffer, '.png'), width: result.width, height: result.height, ...(kind === 'html' ? { layout_issues: result.layout_issues } : {}) });
    },
  }))];
}

module.exports = { createContentGenerationImageTools, validateContentImageReferences };
