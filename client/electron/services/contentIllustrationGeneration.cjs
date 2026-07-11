const zlib = require('node:zlib');
const {
  assertSupportedMermaidDiagramType,
  assertSupportedMermaidSyntax,
  getMermaidDiagramTypeLabel,
} = require('../utils/mermaidPolicy.cjs');
const { runWithRemoteImageRetry } = require('../utils/remoteImageRetry.cjs');

const HTML_AGENT_THRESHOLD_CHARS = 50000;
const HTML_SCREENSHOT_URL = 'https://mt.agnet.top/image/url2png';
const HTML_SCREENSHOT_TIMEOUT_MS = 120000;
const MERMAID_REPAIR_ATTEMPTS = 3;
const MERMAID_RENDER_TIMEOUT_MS = 15000;
const GENERATED_ILLUSTRATION_PATTERN = /<!-- yibiao-illustration:start\b[^>]*-->[\s\S]*?<!-- yibiao-illustration:end -->/gi;

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactError(value, maxLength = 220) {
  const text = singleLine(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeMermaidCode(value) {
  return String(value || '').replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim();
}

function normalizeHtmlCode(value) {
  const text = String(value || '').trim();
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1].trim() : text;
  const start = source.search(/<!doctype\s+html|<html\b/i);
  const document = start >= 0 ? source.slice(start) : source;
  const end = document.toLowerCase().lastIndexOf('</html>');
  return (end >= 0 ? document.slice(0, end + '</html>'.length) : document).trim();
}

function validateHtmlCode(value) {
  const html = normalizeHtmlCode(value);
  if (!/<html\b/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error('HTML 图片结果必须是完整 HTML 文档');
  }
  return html;
}

// 从最终正文中构建图片生成参考材料。
function buildIllustrationReference(planItem, contextById, sections) {
  return planItem.section_ids.map((sectionId) => {
    const context = contextById.get(sectionId);
    const item = context?.item || {};
    const content = String(sections?.[sectionId]?.content || item.content || '').trim();
    return `## ${sectionId} ${singleLine(item.title || '未命名章节')}\n\n${content}`;
  }).join('\n\n');
}

function buildIllustrationExecutionContexts(plan, leafContexts, sections) {
  const contextById = new Map((leafContexts || []).map((context) => [context.item.id, context]));
  return (plan?.items || []).map((planItem) => ({
    planItem,
    contexts: planItem.section_ids.map((id) => contextById.get(id)).filter(Boolean),
    reference: buildIllustrationReference(planItem, contextById, sections),
  }));
}

function buildAiImagePrompt(execution) {
  const styleLabel = execution.planItem.image_type === 'realistic_photo' ? '专业实景图片' : '专业工程图示';
  return `阅读并理解以下技术方案正文，生成一张${styleLabel}。
图片需要准确表达正文中的设备、环境、部署关系或实施场景，不要编造正文中没有的关键对象。
不要有太多文字，专业、克制，适合投标技术方案。
参考内容如下：

${execution.reference}`;
}

function buildHtmlImagePrompt(execution) {
  return `阅读并理解以下内容，用html绘制一张${execution.planItem.image_type}，不要有太多文字描述，专业商务风格。这是一个类图片的html，所以注意仔细检查显示效果、文字换行、拥挤等问题。宽度固定1240px，高度自适应。参考内容如下：

${execution.reference}`;
}

function buildHtmlAgentPrompt(execution) {
  return `请读取当前工作目录中的 reference.md，阅读并理解全部内容，用 HTML 绘制一张${execution.planItem.image_type}。

要求：
1. 不要有太多文字描述，使用专业商务风格。
2. 这是一个类图片的 HTML，必须仔细检查显示效果、文字换行和内容拥挤问题。
3. 页面宽度固定为 1240px，高度自适应。
4. 生成完整 HTML 文档，包含 html、head、body，不依赖本地文件。
5. 只创建 illustration.html，不要修改 reference.md，不要创建其他结果文件。`;
}

function buildMermaidGenerationMessages(execution) {
  const type = assertSupportedMermaidDiagramType(execution.planItem.image_type);
  const typeLabel = getMermaidDiagramTypeLabel(type);
  return [
    {
      role: 'system',
      content: `你是投标技术方案 Mermaid 图生成助手。请根据最终正文生成一张${typeLabel}。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只能使用 flowchart TD/TB/LR/RL/BT 语法，不得使用 graph 别名或其他 Mermaid 语法族。
3. 中文节点标签必须写成 A["中文标签"]。
4. 不使用 & 多节点连接简写，不使用分号，每行只写一个 Mermaid 语句。
5. 图表必须忠实于正文，不编造正文中没有的流程、层级、角色或职责。
6. 控制节点数量和文字长度，保证浏览器预览和 Word 导出清晰。
7. code 不包含 Markdown 代码围栏。`,
    },
    {
      role: 'user',
      content: `参考正文：\n${execution.reference}\n\n请返回：\n{\n  "title": "图表标题",\n  "code": "flowchart TD..."\n}`,
    },
  ];
}

function normalizeMermaidGenerationResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  return {
    title: singleLine(source.title || source.name || ''),
    code: normalizeMermaidCode(source.code || source.mermaid_code || source.mermaid?.code || ''),
  };
}

function validateMermaidGenerationResult(result) {
  if (!result?.title) throw new Error('Mermaid 生成结果缺少 title');
  if (!result?.code) throw new Error('Mermaid 生成结果缺少 code');
  if (/```/.test(result.code)) throw new Error('Mermaid 代码不能包含 Markdown 代码围栏');
  assertSupportedMermaidSyntax(result.code);
}

function assertMermaidPreviewCompatible(code) {
  const normalized = normalizeMermaidCode(code);
  if (!normalized) throw new Error('Mermaid 代码为空');
  assertSupportedMermaidSyntax(normalized);
  if (/[;；]/.test(normalized)) throw new Error('Mermaid 代码不能使用分号');
  if (/\s&\s/.test(normalized) && /-->|---|==>/.test(normalized)) throw new Error('Mermaid 代码不能使用多节点 & 连接简写');
  if (/\[[^\]\n"']*[\u3400-\u9fff][^\]\n"']*\]/u.test(normalized)) throw new Error('Mermaid 中文节点标签必须使用双引号');
  if (/^\s*[\u3400-\u9fff][\w\u3400-\u9fff-]*\s*(?:-->|---|==>)/mu.test(normalized)) throw new Error('Mermaid 节点 ID 不能直接使用中文');
}

function mermaidInkUrl(code) {
  const state = JSON.stringify({ code: String(code || ''), mermaid: { theme: 'default' } });
  const payload = zlib.deflateSync(Buffer.from(state, 'utf-8')).toString('base64url');
  return `https://mermaid.ink/img/pako:${payload}?type=png&bgColor=!white`;
}

async function validateMermaidRender(code) {
  const normalized = normalizeMermaidCode(code);
  assertMermaidPreviewCompatible(normalized);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MERMAID_RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(mermaidInkUrl(normalized), { signal: controller.signal });
    if (!response.ok || !/image\//i.test(response.headers.get('content-type') || '')) {
      throw new Error(`Mermaid 渲染失败：HTTP ${response.status || 'unknown'}`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Mermaid 渲染校验超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildMermaidRepairMessages(execution, mermaidPlan, errorMessage, attempt) {
  const typeLabel = getMermaidDiagramTypeLabel(execution.planItem.image_type);
  return [
    {
      role: 'system',
      content: `你是 Mermaid 图代码修复助手。请根据渲染错误和最终正文修复现有 Mermaid 代码。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 保持“${typeLabel}”业务类型，忠实于参考正文。
3. 必须使用 flowchart TD/TB/LR/RL/BT 语法。
4. 中文节点标签必须使用双引号，不使用 & 简写和分号。
5. code 不包含 Markdown 代码围栏。`,
    },
    {
      role: 'user',
      content: `参考正文：\n${execution.reference}\n\n图表标题：${mermaidPlan.title}\n修复轮次：${attempt}/${MERMAID_REPAIR_ATTEMPTS}\n渲染错误：${errorMessage}\n\n待修复代码：\n${mermaidPlan.code}\n\n请返回：\n{ "code": "修复后的 Mermaid 代码" }`,
    },
  ];
}

function normalizeMermaidRepairResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  return { code: normalizeMermaidCode(source.code || source.fixed_code || source.mermaid_code || '') };
}

function validateMermaidRepairResult(result) {
  if (!result?.code || /```/.test(result.code)) throw new Error('Mermaid 修复结果缺少有效 code');
  assertSupportedMermaidSyntax(result.code);
}

async function prepareRenderableMermaid({ aiService, execution, mermaidPlan, isPauseLikeError }) {
  let currentPlan = { ...mermaidPlan, code: normalizeMermaidCode(mermaidPlan.code) };
  let lastError = null;
  try {
    assertSupportedMermaidDiagramType(execution.planItem.image_type);
    await validateMermaidRender(currentPlan.code);
    return { ...currentPlan, attempts: 0 };
  } catch (error) {
    lastError = error;
  }

  for (let attempt = 1; attempt <= MERMAID_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      const repaired = await aiService.collectJsonResponse({
        messages: buildMermaidRepairMessages(execution, currentPlan, compactError(lastError?.message || lastError), attempt),
        temperature: 0.1,
        logTitle: `Mermaid配图修复-${execution.planItem.item_id}-${currentPlan.title}`,
        progressLabel: 'Mermaid 配图修复',
        failureMessage: '模型返回的 Mermaid 修复结果格式无效',
        normalizer: normalizeMermaidRepairResult,
        validator: validateMermaidRepairResult,
        max_retries: 1,
      });
      currentPlan = { ...currentPlan, code: repaired.code };
      await validateMermaidRender(currentPlan.code);
      return { ...currentPlan, attempts: attempt };
    } catch (error) {
      if (isPauseLikeError?.(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(compactError(lastError?.message || lastError || 'Mermaid 渲染失败'));
}

// 使用生图模型基于最终正文生成 AI 图片。
async function generateAiIllustration(aiService, execution) {
  const sectionTitle = singleLine(execution.contexts[0]?.item?.title || '技术方案');
  const title = execution.planItem.image_type === 'realistic_photo' ? `${sectionTitle}实景示意` : `${sectionTitle}工程示意`;
  const generated = await aiService.generateImage({
    title,
    logTitle: `AI生图-${execution.planItem.item_id}-${title}`,
    prompt: buildAiImagePrompt(execution),
    style: execution.planItem.image_type,
  });
  if (!generated?.asset_url) throw new Error('生图模型未返回本地图片地址');
  return { title, asset_url: generated.asset_url, attempts: 1 };
}

// 使用文本模型基于最终正文生成并校验 Mermaid。
async function generateMermaidIllustration(aiService, execution, isPauseLikeError) {
  const generated = await aiService.collectJsonResponse({
    messages: buildMermaidGenerationMessages(execution),
    temperature: 0.2,
    logTitle: `Mermaid配图-${execution.planItem.item_id}-${execution.contexts[0]?.item?.title || '未命名章节'}`,
    progressLabel: 'Mermaid 配图生成',
    failureMessage: '模型返回的 Mermaid 配图格式无效',
    normalizer: normalizeMermaidGenerationResult,
    validator: validateMermaidGenerationResult,
  });
  return prepareRenderableMermaid({ aiService, execution, mermaidPlan: generated, isPauseLikeError });
}

async function requestHtmlScreenshot(html, onRetry, pauseControl = {}) {
  let requestAttempts = 0;
  const result = await runWithRemoteImageRetry(async (attempt) => {
    requestAttempts = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTML_SCREENSHOT_TIMEOUT_MS);
    const pauseWatcher = pauseControl.isPauseRequested
      ? setInterval(() => {
        if (pauseControl.isPauseRequested() && !controller.signal.aborted) {
          controller.abort();
        }
      }, 100)
      : null;
    try {
      const response = await fetch(HTML_SCREENSHOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html_base64: Buffer.from(html, 'utf-8').toString('base64'),
          capture_mode: 'full_page',
          response_type: 'base64',
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true || !payload?.data?.image_base64) {
        throw new Error(payload?.message || `HTML 转图片失败：HTTP ${response.status || 'unknown'}`);
      }
      const imageBase64 = String(payload.data.image_base64).replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '');
      const buffer = Buffer.from(imageBase64, 'base64');
      if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error('HTML 转图片服务返回的内容不是有效 PNG');
      }
      return { buffer, width: payload.data.width, height: payload.data.height };
    } catch (error) {
      if (pauseControl.isPauseRequested?.()) {
        throw pauseControl.createPauseError?.() || error;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }, {
    onRetry,
    shouldStop: pauseControl.isPauseRequested,
    createStopError: pauseControl.createPauseError,
  });
  return { ...result, attempts: requestAttempts };
}

// 生成 HTML 源文件并调用远程服务转换为 PNG。
async function generateHtmlIllustration({ aiService, execution, plan, workspaceStore, runAgentHtml, onRenderRetry, isPauseRequested, createPauseError }) {
  const existingPath = execution.planItem.generation?.source_path;
  let html = existingPath ? workspaceStore.readIllustrationHtml(existingPath) : '';
  const mode = execution.reference.length > HTML_AGENT_THRESHOLD_CHARS ? 'agent' : 'normal';
  if (!html) {
    if (mode === 'agent') {
      html = await runAgentHtml({
        title: `HTML配图-${execution.planItem.item_id}`,
        prompt: buildHtmlAgentPrompt(execution),
        outputFile: 'illustration.html',
        files: [{ path: 'reference.md', content: execution.reference }],
        validateOutput: (result) => validateHtmlCode(result?.output_content || ''),
      });
    } else {
      const response = await aiService.chat({
        messages: [{ role: 'user', content: `${buildHtmlImagePrompt(execution)}\n\n仅返回html代码，不要返回任何其他内容。` }],
        temperature: 0.2,
        logTitle: `HTML配图-${execution.planItem.item_id}-${execution.planItem.image_type}`,
      });
      html = validateHtmlCode(response);
    }
    html = validateHtmlCode(html);
  }

  const savedHtml = workspaceStore.saveIllustrationHtml({ revision: plan.revision, itemId: execution.planItem.item_id, content: html });
  let screenshot;
  try {
    screenshot = await requestHtmlScreenshot(html, onRenderRetry, { isPauseRequested, createPauseError });
  } catch (error) {
    error.illustrationGeneration = { mode, source_path: savedHtml.relativePath };
    throw error;
  }
  const savedPng = workspaceStore.saveIllustrationPng({ revision: plan.revision, itemId: execution.planItem.item_id, buffer: screenshot.buffer });
  return {
    mode,
    title: execution.planItem.image_type,
    source_path: savedHtml.relativePath,
    asset_url: savedPng.assetUrl,
    attempts: screenshot.attempts,
  };
}

function stripGeneratedIllustrations(content) {
  return String(content || '').replace(GENERATED_ILLUSTRATION_PATTERN, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildGeneratedIllustrationMarkdown(planItem) {
  const generation = planItem.generation || {};
  let body = '';
  if (planItem.kind === 'mermaid' && generation.code) {
    const title = singleLine(generation.title || '流程图');
    const caption = title.endsWith('图') ? title : `${title}图`;
    body = `\`\`\`mermaid\n${normalizeMermaidCode(generation.code)}\n\`\`\`\n\n*图：${caption}*`;
  } else if (generation.asset_url) {
    const title = singleLine(generation.title || planItem.image_type || '技术方案配图');
    const caption = title.endsWith('图') ? title : `${title}图`;
    body = `![${caption}](${generation.asset_url})\n\n*图：${caption}*`;
  }
  if (!body) return '';
  return `<!-- yibiao-illustration:start id="${planItem.item_id}" -->\n${body}\n<!-- yibiao-illustration:end -->`;
}

function mapOutlineContent(items, contentById) {
  return (items || []).map((item) => ({
    ...item,
    ...(contentById.has(item.id) ? { content: contentById.get(item.id) } : {}),
    ...(item.children?.length ? { children: mapOutlineContent(item.children, contentById) } : {}),
  }));
}

// 清除旧生成块，确保重新编排时只参考纯正文。
function stripGeneratedIllustrationsFromDocument(outlineData, sections) {
  const nextSections = { ...(sections || {}) };
  const contentById = new Map();
  for (const [itemId, section] of Object.entries(nextSections)) {
    const content = stripGeneratedIllustrations(section?.content || '');
    nextSections[itemId] = { ...section, content };
    contentById.set(itemId, content);
  }
  return {
    sections: nextSections,
    outlineData: outlineData ? { ...outlineData, outline: mapOutlineContent(outlineData.outline, contentById) } : outlineData,
  };
}

// 按最终计划顺序把成功图片一次性插入权威正文。
function applyGeneratedIllustrationsToDocument(plan, outlineData, sections) {
  const nextSections = { ...(sections || {}) };
  const contentById = new Map();
  for (const [itemId, section] of Object.entries(nextSections)) {
    const content = stripGeneratedIllustrations(section?.content || '');
    nextSections[itemId] = { ...section, content };
    contentById.set(itemId, content);
  }

  for (const planItem of plan?.items || []) {
    if (planItem.generation?.status !== 'success') continue;
    const block = buildGeneratedIllustrationMarkdown(planItem);
    if (!block) continue;
    const targetId = planItem.kind === 'html' && planItem.placement === 'before'
      ? planItem.section_ids[0]
      : planItem.section_ids[planItem.section_ids.length - 1];
    const current = String(nextSections[targetId]?.content || '').trim();
    const content = planItem.placement === 'before' ? `${block}\n\n${current}`.trim() : `${current}\n\n${block}`.trim();
    nextSections[targetId] = { ...nextSections[targetId], content, status: 'success', error: undefined, updated_at: new Date().toISOString() };
    contentById.set(targetId, content);
  }

  return {
    sections: nextSections,
    outlineData: outlineData ? { ...outlineData, outline: mapOutlineContent(outlineData.outline, contentById) } : outlineData,
  };
}

module.exports = {
  HTML_AGENT_THRESHOLD_CHARS,
  applyGeneratedIllustrationsToDocument,
  buildAiImagePrompt,
  buildHtmlImagePrompt,
  buildIllustrationExecutionContexts,
  generateAiIllustration,
  generateHtmlIllustration,
  generateMermaidIllustration,
  normalizeHtmlCode,
  stripGeneratedIllustrationsFromDocument,
  validateHtmlCode,
};
