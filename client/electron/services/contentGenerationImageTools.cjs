const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('cheerio');
const { applyRangeEdits } = require('../utils/textEdit.cjs');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');

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

// 读取最新正文并保留原文位置；不重新序列化 HTML，避免改变正文和图组布局。
function readSectionImages(workspaceDir, section) {
  const file = resolveImageWorkspaceFile(workspaceDir, section.file);
  const html = fs.readFileSync(file, 'utf8');
  const $ = load(html, { sourceCodeLocationInfo: true }, false);
  const ids = new Set();
  const images = $('figure').toArray().map(figure => {
    const node = $(figure);
    const id = node.attr('id');
    if (!id?.trim() || ids.has(id)) throw new Error(`小节 ${section.id} 的 figure id 为空或重复：${id || '空'}`);
    ids.add(id);
    const image = node.find('img');
    const prompt = node.find('template[data-yb-role="prompt"]');
    const generation = node.attr('data-yb-generation');
    const frameSize = node.attr('data-yb-size');
    if (node.find('figure').length || image.length !== 1 || prompt.length !== 1 || !prompt.text().trim()) {
      throw new Error(`图片 ${id} 必须有一个 img 和一个非空提示词，不能嵌套 figure`);
    }
    if (!['aiImage', 'htmlImage', 'mermaid'].includes(generation) || !['square', 'wide', 'tall', 'panorama'].includes(frameSize)) {
      throw new Error(`图片 ${id} 的生成方式或画框比例无效`);
    }
    const reference = image.attr('data-yb-asset-ref') || '';
    const exists = reference ? fs.existsSync(resolveImageWorkspaceFile(workspaceDir, reference))
      && fs.statSync(resolveImageWorkspaceFile(workspaceDir, reference)).isFile() : false;
    return {
      image_id: `${encodeURIComponent(section.id)}/${encodeURIComponent(id)}`,
      section_id: section.id, file: section.file, figure_id: id,
      generation, frame_size: frameSize, prompt: prompt.text().trim(),
      alt: image.attr('alt') || '', caption: node.find('figcaption').text().trim(),
      asset_ref: reference, asset_exists: exists,
      reused_original: reference.startsWith('原图/') || Boolean(section.restored_content?.images?.some(item => item.asset_ref === reference)),
      location: image[0].sourceCodeLocation,
    };
  });
  if ($('img').length !== images.length) throw new Error(`小节 ${section.id} 存在 figure 之外的图片，请先修复正文结构`);
  return { file, html, images };
}

// 仅替换或插入图片引用属性；位置来自解析器，其他原始字符保持不变。
function imageReferenceEdit(html, image, assetRef) {
  const location = image.location;
  if (!location?.startTag) throw new Error(`无法定位图片原始标签：${image.image_id}`);
  const attribute = location.attrs?.['data-yb-asset-ref'];
  const value = assetRef.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = `data-yb-asset-ref="${value}"`;
  if (attribute) return { start: attribute.startOffset, end: attribute.endOffset, newText: text };
  const tag = html.slice(location.startTag.startOffset, location.startTag.endOffset);
  const closing = tag.search(/\s*\/?>$/);
  if (closing < 0) throw new Error(`无法定位图片标签结尾：${image.image_id}`);
  const offset = location.startTag.startOffset + closing;
  return { start: offset, end: offset, newText: ` ${text}` };
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
function createContentGenerationImageTools({ aiService, signal, localImageRenderService, htmlImageOptimization = false, sections = [], beforeApply = () => {} }, { Type, workspaceDir }) {
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

  // 首次生成和源码修复共用转图逻辑；源码一就绪即进入已有本地队列。
  async function renderImage(result, combinedSignal) {
    combinedSignal.throwIfAborted();
    const renderer = localImageRenderService || require('./localImageRenderService.cjs').getLocalImageRenderService();
    const pauseOptions = { isPauseRequested: () => combinedSignal.aborted, createPauseError: () => combinedSignal.reason };
    const source = fs.readFileSync(resolveImageWorkspaceFile(workspaceDir, result.source_file), 'utf8');
    const rendered = result.kind === 'html'
      ? await renderer.renderHtmlToPng(source, { ...pauseOptions, frameSize: result.frame_size, checkLayout: htmlImageOptimization })
      : await renderer.renderMermaidToPng(source, pauseOptions);
    combinedSignal.throwIfAborted();
    Object.assign(result, {
      asset_ref: saveImage(rendered.buffer, '.png'), width: rendered.width, height: rendered.height,
      ...(result.kind === 'html' ? { layout_issues: rendered.layout_issues } : {}),
      status: result.kind === 'html' && rendered.layout_issues?.length ? 'needs_repair' : 'success',
    });
  }

  // 等待整批退出后返回完整结果；取消也交给 Pi 落入会话，避免丢失已完成产物路径。
  async function runImageBatch(images, toolSignal, onUpdate, processImage) {
    const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
    combinedSignal.throwIfAborted();
    if (new Set(images.map(image => image.image_id)).size !== images.length) throw new Error('同一批图片的 image_id 不能重复');
    let completed = 0;
    const results = await Promise.all(images.map(async image => {
      const result = { image_id: image.image_id, kind: image.kind,
        ...(image.source_file ? { source_file: image.source_file } : {}),
        ...(image.kind === 'html' ? { frame_size: image.frame_size } : {}),
        stage: image.source_file ? 'render' : 'generate' };
      try {
        combinedSignal.throwIfAborted();
        await processImage(image, result, combinedSignal);
        if (result.status === 'success') result.stage = 'complete';
      } catch (error) {
        Object.assign(result, { status: combinedSignal.aborted ? 'cancelled' : 'error', error: error.message });
      }
      onUpdate?.(toolResult({ completed: ++completed, total: images.length, result }));
      return result;
    }));
    const output = toolResult({ results, ...(combinedSignal.aborted ? { cancelled: true } : {}) });
    if (results.some(result => result.status !== 'success')) output.isError = true;
    return output;
  }

  const targets = new Map(sections.map(section => [section.id, section]));
  return [{
    name: 'list-section-images', label: '读取正文图片清单', executionMode: 'sequential',
    description: '读取本轮目标小节的最新 HTML，返回每张图片的 image_id、小节、生成方式、比例、提示词、图注、当前引用及文件存在状态。image_id 原样传给图片工具及回填工具，不自行拼接。reused_original 为原方案图片，只复用、不重新生成。默认读取全部目标，可按 section_ids 只刷新待修复小节。',
    parameters: Type.Object({ section_ids: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })) }, { additionalProperties: false }),
    async execute(_callId, { section_ids }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      const results = (section_ids || [...targets.keys()]).map(id => {
        combinedSignal.throwIfAborted();
        try {
          if (!targets.has(id)) throw new Error(`不能读取非目标小节：${id}`);
          const { images } = readSectionImages(workspaceDir, targets.get(id));
          return { section_id: id, status: 'success', images: images.map(({ location, ...image }) => image) };
        } catch (error) { return { section_id: id, status: 'error', error: error.message }; }
      });
      return toolResult({ results });
    },
  }, {
    name: 'apply-section-images', label: '批量回填正文图片', executionMode: 'sequential',
    description: '批量回填图片工具返回 status=success 的图片。image_id 使用清单标识，asset_ref 使用图片工具返回值，previous_asset_ref 使用清单中的原引用（未填写时为空字符串）。按小节合并保存，只修改 img 的 data-yb-asset-ref。引用已变化则先刷新清单；同一地址重复提交不会重复修改。未成功的项不要提交，原图直接复用。检查每项结果，只在本次所需回填全部成功后标记任务完成。',
    parameters: Type.Object({ images: Type.Array(Type.Object({
      image_id: Type.String({ minLength: 1 }), asset_ref: Type.String({ minLength: 1 }), previous_asset_ref: Type.String(),
    }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    async execute(_callId, { images }, toolSignal) {
      const combinedSignal = AbortSignal.any([signal, toolSignal].filter(Boolean));
      combinedSignal.throwIfAborted();
      beforeApply();
      if (new Set(images.map(item => item.image_id)).size !== images.length) throw new Error('同一批回填的 image_id 不能重复');
      const groups = new Map();
      const results = new Map();
      for (const item of images) {
        try {
          const parts = item.image_id.split('/');
          const id = decodeURIComponent(parts[0]);
          if (parts.length !== 2 || !targets.has(id)) throw new Error('图片不属于本次目标小节，请使用清单中的 image_id');
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(item);
        } catch (error) { results.set(item.image_id, { image_id: item.image_id, status: 'error', error: error.message }); }
      }
      for (const [id, items] of groups) {
        combinedSignal.throwIfAborted();
        try {
          const { file, html, images: current } = readSectionImages(workspaceDir, targets.get(id));
          const edits = [];
          for (const item of items) {
            const image = current.find(image => image.image_id === item.image_id);
            if (!image) throw new Error(`图片标识不存在：${item.image_id}`);
            const asset = resolveImageWorkspaceFile(workspaceDir, item.asset_ref);
            if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) throw new Error(`图片文件不存在：${item.asset_ref}`);
            if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(item.asset_ref)) throw new Error('回填必须使用图片资源，不能使用 HTML/Mermaid 源码');
            if (image.asset_ref === item.asset_ref) continue;
            if (image.asset_ref !== item.previous_asset_ref) throw new Error(`图片引用已变化，请刷新清单：${item.image_id}`);
            edits.push(imageReferenceEdit(html, image, item.asset_ref));
          }
          if (edits.length) {
            const edited = applyRangeEdits(html, edits);
            if (edited.errors.length) throw new Error(edited.errors.join('；'));
            combinedSignal.throwIfAborted();
            const temporary = `${file}.images.tmp`;
            try { fs.writeFileSync(temporary, edited.content, 'utf8'); fs.renameSync(temporary, file); }
            finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
          }
          for (const item of items) results.set(item.image_id, { image_id: item.image_id, section_id: id, status: 'success', asset_ref: item.asset_ref });
        } catch (error) {
          for (const item of items) results.set(item.image_id, { image_id: item.image_id, section_id: id, status: 'error', error: error.message });
        }
      }
      return toolResult({ results: images.map(item => results.get(item.image_id)) });
    },
  }, {
    name: 'generate-section-images', label: '批量生成正文图片', executionMode: 'sequential',
    description: `通过 images 一次提交本轮全部待生成 AI、HTML、Mermaid 图片，image_id 原样使用正文图片清单标识，不按类型或小批次拆分。AI 使用生图队列，HTML/Mermaid 使用文本队列生成源码，每张源码完成后立即进入对应本地渲染队列；超限自动排队。返回逐项 status、stage、asset_ref、source_file 和 error。success 图片直接回填。${htmlImageOptimization ? 'HTML 返回 needs_repair 时，按 layout_issues 修改源码后转图，直到成功。' : ''}有 source_file 的失败项直接修复并调用 render 工具，不重新生成源码；无源码的失败项才重试生成。暂停结果保留已完成产物，恢复仅补未完成项。`,
    parameters: Type.Object({ images: Type.Array(Type.Union(['ai', 'html', 'mermaid'].map(kind => Type.Object({
      image_id: Type.String({ minLength: 1, description: '正文图片清单中的 image_id，批内唯一。' }),
      kind: Type.Literal(kind),
      prompt: Type.String({ minLength: 1, description: '图片表达目的、准确内容和数据；保留与正文画框一致的宽高比例及构图方向，不只给文件路径或要求模型检索。' }),
      ...(kind === 'ai' ? {
        size: Type.String({ minLength: 1, pattern: '\\S', description: '逐图依据正文 data-yb-size 选择对应比例的具体尺寸：square=1:1、wide=3:2、tall=3:4、panorama=16:9；当前金龙 gpt-image-2-1k 的 tall 使用 768x1024。不得传画框名称或省略尺寸。' }),
        title: Type.Optional(Type.String()),
        style: Type.Optional(Type.Union([Type.Literal('engineering_diagram'), Type.Literal('realistic_photo')], { description: '工程图示或写实照片风格，省略时使用工程图示。' })),
      } : kind === 'html' ? {
        frame_size: Type.Union(['square', 'wide', 'tall', 'panorama'].map(value => Type.Literal(value)), { description: '与正文 figure 的 data-yb-size 一致。' }),
      } : {}),
    }, { additionalProperties: false }))), { minItems: 1 }) }, { additionalProperties: false }),
    async execute(_callId, { images }, toolSignal, onUpdate) {
      return runImageBatch(images, toolSignal, onUpdate, async (image, result, combinedSignal) => {
        const { image_id, kind, prompt, frame_size } = image;
        if (kind === 'ai') {
          const { image_id: _id, kind: _kind, ...params } = image;
          if (!params.size?.trim()) throw new Error('请补充本张 AI 图片的 size，尺寸比例应与正文画框一致');
          const generated = await aiService.generateImage({ ...params, signal: combinedSignal });
          combinedSignal.throwIfAborted();
          Object.assign(result, generated, { status: 'success', asset_ref: saveImage(fs.readFileSync(generated.file_path), path.extname(generated.file_path)) });
        } else {
          if (!['html', 'mermaid'].includes(kind)) throw new Error('图片 kind 必须为 ai、html 或 mermaid');
          const response = await aiService.chat({
            signal: combinedSignal, logTitle: `Agent 配图源码-${kind}-${image_id}`,
            messages: [{ role: 'system', content: buildImageSourcePrompt(kind, frame_size) }, { role: 'user', content: prompt }],
          });
          combinedSignal.throwIfAborted();
          const source = extractAiSource(response, kind);
          result.source_file = saveImage(Buffer.from(source, 'utf8'), kind === 'html' ? '.html' : '.mmd');
          result.stage = 'render';
          await renderImage(result, combinedSignal);
        }
      });
    },
  }, ...['html', 'mermaid'].map(kind => ({
    name: `render-${kind}-image`, label: kind === 'html' ? '批量 HTML 转图片' : '批量 Mermaid 转图片',
    description: `将本轮全部待渲染的 ${kind === 'html' ? 'HTML' : 'Mermaid'} 文件通过 images 一次提交，单张也使用一项数组，不逐张或分小批等待。读取工作区已有的 ${kind === 'html' ? '独立配图 HTML，按正文 data-yb-size 对应的 frame_size 固定画布截图，画布内四周保留 40px 边距' : 'Mermaid 源文件'}，由现有本地渲染队列控制并发并转为 PNG。返回 results 中每项的 image_id、status、asset_ref、像素尺寸和源码路径或 error。success 图片直接回填。${kind === 'html' && htmlImageOptimization ? '返回 needs_repair 时，按 layout_issues 修改源码后重新渲染，直到成功。' : ''}只对失败或需要修正的项修改源码后重新提交，保留其他结果。`,
    executionMode: 'sequential',
    parameters: Type.Object({
      images: Type.Array(Type.Object({
        image_id: Type.String({ minLength: 1, description: '本批唯一的图片标识，沿用源码生成时的 image_id，用于对应正文图片。' }),
        source_file: Type.String({ minLength: 1, description: '当前工作区内的源码相对路径，如 图片/实施流程.html 或 图片/实施流程.mmd；使用 UTF-8，不带 Markdown 围栏。' }),
        ...(kind === 'html' ? { frame_size: Type.Union(['square', 'wide', 'tall', 'panorama'].map(value => Type.Literal(value)), { description: '与正文 figure 的 data-yb-size 一致。设计尺寸：square=1240×1240，wide=1240×827，tall=1240×1653，panorama=1240×698；尺寸包含四周40px内边距。按此尺寸编写HTML，程序以2倍像素输出。' }) } : {}),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    // 修复时只重新渲染已有源码，复用与首次生成相同的结果和取消处理。
    async execute(_callId, { images }, toolSignal, onUpdate) {
      return runImageBatch(images.map(image => ({ ...image, kind })), toolSignal, onUpdate,
        async (_image, result, combinedSignal) => renderImage(result, combinedSignal));
    },
  }))];
}

module.exports = { createContentGenerationImageTools, validateContentImageReferences };
