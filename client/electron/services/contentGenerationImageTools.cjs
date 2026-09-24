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

// 并发源码模型只处理当前图片；布局规范随请求提供，不依赖主会话上下文。
function buildImageSourcePrompt(kind, frameSize) {
  const common = '你负责生成投标文件中一张独立配图的源码。只返回源码，不输出 Markdown 围栏或解释。仅使用本次请求提供的内容和数据，不虚构事实、数值或承诺；你没有检索、文件写入或渲染工具，不负责正文编排、生成其他图片或回填正文。';
  if (kind === 'mermaid') {
    return `${common}\n生成 Mermaid 源码：流程图使用 flowchart，思维导图使用 mindmap，实体关系图使用 erDiagram。使用合法语法，正确处理中文标签，节点与连线清晰，避免过度密集。不要生成 HTML。`;
  }
  const height = { square: 1240, wide: 827, tall: 1653, panorama: 698 }[frameSize];
  if (!height) throw new Error('HTML 配图必须提供合法的 frame_size：square、wide、tall 或 panorama');
  return `${common}
生成完整独立 HTML 文档，可用 HTML/CSS/SVG 绘图，不受正文受限 HTML 标签限制；不使用脚本、外部资源或网络依赖。
画布比例为 ${frameSize}，固定设计尺寸为1240×${height}px，以 body 为画布，宽高包含程序统一设置的四周40px内边距，内部可用区域为1160×${height - 80}px；程序按2倍像素输出。保持 body 的 Flex/Grid 布局，不额外包一层画布或重复添加外层边距。
采用正式简洁的配色、清晰层次、统一字体和线条，正文及节点文字不小于24px。标题和主体共同利用可用空间，主体用 Flex/Grid 分配剩余高度，卡片、节点及图形均衡分布，不在底部留下大块空白。
内容不得侵入边距或超出画布，不通过无意义文字、拉伸图形、空卡片或整体缩小内容填满版面，不用隐藏溢出来掩盖裁切。`;
}

// 图片与独立源码均保存在当前工作区；源码生成使用文本队列，转图继续复用本地渲染。
function createContentGenerationImageTools({ aiService, signal, localImageRenderService }, { Type, workspaceDir }) {
  // 图片和源码每次生成独立文件，失败或重新生成不会覆盖已有产物。
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
    description: '将本轮全部待生成 AI 图片通过 images 一次提交，不按章节或固定小批次拆分。内部按主程序生图并发设置生成，超出上限自动排队。每项 image_id 在批内唯一，用于对应正文中的具体图片。返回 results 中各项的状态及 asset_ref；只重试失败项。单张也通过只有一项的 images 提交。',
    executionMode: 'sequential',
    parameters: Type.Object({
      images: Type.Array(Type.Object({
        image_id: Type.String({ minLength: 1, description: '本批唯一的图片标识，用于将结果对应到正文中的具体图片；图组内每张图使用不同标识。' }),
        prompt: Type.String({ minLength: 1, description: '描述图片的表达目的、主体、场景或结构关系，并保留与正文画框和 size 一致的宽高比例及横向/竖向构图要求，不得在整理提示词时省略比例。' }),
        title: Type.Optional(Type.String({ description: '图片标题' })),
        style: Type.Optional(Type.Union([Type.Literal('engineering_diagram'), Type.Literal('realistic_photo')], { description: 'engineering_diagram：工程图示风格，适用于示意、结构及原理表达；realistic_photo：写实照片风格，适用于实物和场景表达。省略时使用工程图示风格。' })),
        size: Type.String({ minLength: 1, pattern: '\\S', description: '必填。逐图依据正文 figure 的 data-yb-size 选择对应比例的具体生图尺寸：square=1:1、wide=3:2、tall=3:4、panorama=16:9。当前金龙 gpt-image-2-1k 的 tall 可使用已验证的 768x1024。不能把 tall 等画框名称当尺寸，不得省略尺寸或统一沿用默认方图；prompt 同步写明比例和构图方向。' }),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    // 批内并发交给现有生图队列，逐项保留结果；取消时等待整批退出再向主会话抛出。
    async execute(_callId, { images }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      if (new Set(images.map(image => image.image_id)).size !== images.length) throw new Error('同一批生图的 image_id 不能重复');
      const results = await Promise.all(images.map(async ({ image_id, ...params }) => {
        try {
          combinedSignal.throwIfAborted();
          if (!params.size?.trim()) throw new Error('请补充本张 AI 图片的 size，尺寸比例应与正文画框一致');
          const result = await aiService.generateImage({ ...params, signal: combinedSignal });
          combinedSignal.throwIfAborted();
          const assetRef = saveImage(fs.readFileSync(result.file_path), path.extname(result.file_path));
          return { ...result, image_id, status: 'success', asset_ref: assetRef };
        } catch (error) {
          return { image_id, status: 'error', error: error.message };
        }
      }));
      combinedSignal.throwIfAborted();
      return toolResult({ results });
    },
  }, {
    name: 'generate-image-sources', label: '批量生成配图源码',
    description: '将本轮全部待生成 HTML/Mermaid 源码合并到 images 一次提交，不按章节、类型或固定小批次拆分。使用现有文本模型队列并发生成，超出上限自动排队，源码保存为图片目录下的新文件。每项 prompt 必须提供准确的表达内容及所需数据，模型无法读取主会话或检索资料。返回 results 中的 image_id、kind、status、source_file（HTML 含 frame_size）或 error；仅重试失败项。源码成功不表示渲染完成，随后按 HTML/Mermaid 分别批量调用对应 render 工具，修复反馈后再回填正文图片引用。',
    executionMode: 'sequential',
    parameters: Type.Object({
      images: Type.Array(Type.Object({
        image_id: Type.String({ minLength: 1, description: '本批唯一的图片标识，用于对应正文中的具体图片。' }),
        kind: Type.Union([Type.Literal('html'), Type.Literal('mermaid')]),
        prompt: Type.String({ minLength: 1, description: '图片的类型、表达目的、准确内容和数据，以及必要的设计要求；不能只给文件路径或让模型自行查找资料。' }),
        frame_size: Type.Optional(Type.Union(['square', 'wide', 'tall', 'panorama'].map(value => Type.Literal(value)), { description: 'HTML 必填，与对应正文 figure 的 data-yb-size 一致；Mermaid 不需要。' })),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    // 每图独立请求和落盘，部分失败不丢弃成功源码，取消后不再保存新文件。
    async execute(_callId, { images }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      if (new Set(images.map(image => image.image_id)).size !== images.length) throw new Error('同一批配图源码的 image_id 不能重复');
      const results = await Promise.all(images.map(async ({ image_id, kind, prompt, frame_size }) => {
        try {
          combinedSignal.throwIfAborted();
          const source = (await aiService.chat({
            signal: combinedSignal, logTitle: `Agent 配图源码-${kind}-${image_id}`,
            messages: [{ role: 'system', content: buildImageSourcePrompt(kind, frame_size) }, { role: 'user', content: prompt }],
          })).trim();
          combinedSignal.throwIfAborted();
          if (!source || source.startsWith('```')) throw new Error('配图源码不能为空或包含 Markdown 围栏，请只返回源码');
          const sourceFile = saveImage(Buffer.from(source, 'utf8'), kind === 'html' ? '.html' : '.mmd');
          return { image_id, kind, status: 'success', source_file: sourceFile, ...(kind === 'html' ? { frame_size } : {}) };
        } catch (error) {
          return { image_id, kind, status: 'error', error: error.message };
        }
      }));
      combinedSignal.throwIfAborted();
      return toolResult({ results });
    },
  }, ...['html', 'mermaid'].map(kind => ({
    name: `render-${kind}-image`, label: kind === 'html' ? '批量 HTML 转图片' : '批量 Mermaid 转图片',
    description: `将本轮全部待渲染的 ${kind === 'html' ? 'HTML' : 'Mermaid'} 文件通过 images 一次提交，单张也使用一项数组，不逐张或分小批等待。读取工作区已有的 ${kind === 'html' ? '独立配图 HTML，按正文 data-yb-size 对应的 frame_size 固定画布截图，画布内四周保留 40px 边距' : 'Mermaid 源文件'}，由现有本地渲染队列控制并发并转为 PNG。返回 results 中每项的 image_id、status、asset_ref、像素尺寸和源码路径或 error${kind === 'html' ? '，并保留各项 layout_issues' : ''}；只对失败或需要修正的项修改源码后重新提交，保留其他结果。`,
    executionMode: 'sequential',
    parameters: Type.Object({
      images: Type.Array(Type.Object({
        image_id: Type.String({ minLength: 1, description: '本批唯一的图片标识，沿用源码生成时的 image_id，用于对应正文图片。' }),
        source_file: Type.String({ minLength: 1, description: '当前工作区内的源码相对路径，如 图片/实施流程.html 或 图片/实施流程.mmd；使用 UTF-8，不带 Markdown 围栏。' }),
        ...(kind === 'html' ? { frame_size: Type.Union(['square', 'wide', 'tall', 'panorama'].map(value => Type.Literal(value)), { description: '与正文 figure 的 data-yb-size 一致。设计尺寸：square=1240×1240，wide=1240×827，tall=1240×1653，panorama=1240×698；尺寸包含四周40px内边距。按此尺寸编写HTML，程序以2倍像素输出。' }) } : {}),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    // 全量提交给现有渲染队列；逐项保留结果，取消时等待本批退出且不再落盘。
    async execute(_callId, { images }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      if (new Set(images.map(image => image.image_id)).size !== images.length) throw new Error('同一批转图的 image_id 不能重复');
      const renderer = localImageRenderService || require('./localImageRenderService.cjs').getLocalImageRenderService();
      const pauseOptions = { isPauseRequested: () => combinedSignal.aborted, createPauseError: () => combinedSignal.reason };
      const results = await Promise.all(images.map(async ({ image_id, source_file, frame_size }) => {
        try {
          combinedSignal.throwIfAborted();
          const source = fs.readFileSync(resolveImageWorkspaceFile(workspaceDir, source_file), 'utf8');
          const result = kind === 'html'
            ? await renderer.renderHtmlToPng(source, { ...pauseOptions, frameSize: frame_size })
            : await renderer.renderMermaidToPng(source, pauseOptions);
          combinedSignal.throwIfAborted();
          return { image_id, status: 'success', source_file, asset_ref: saveImage(result.buffer, '.png'), width: result.width, height: result.height, ...(kind === 'html' ? { frame_size, layout_issues: result.layout_issues } : {}) };
        } catch (error) {
          return { image_id, status: 'error', source_file, error: error.message };
        }
      }));
      combinedSignal.throwIfAborted();
      return toolResult({ results });
    },
  }))];
}

module.exports = { createContentGenerationImageTools, validateContentImageReferences };
