const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { findHtmlStructureIssues, repairHtmlStructure, closeOpenTemplates, ownImages } = require('../utils/htmlStructure.cjs');

// 转换副本：结构完整的正文原样使用；有结构问题时按整本导出的规则修复副本（含补齐提示词结束标签），源 HTML 不回写。
function convertibleHtml(html) {
  const problems = findHtmlStructureIssues(html);
  return problems.length ? { ...repairHtmlStructure(html), problems } : { html, repairs: [], problems };
}

// 返回本次目标中已有非空正文的小节 ID；临时文件、配图源码和其他小节不参与。
function scanGeneratedSections(workspaceDir, targets) {
  return targets.filter(section => {
    try {
      const file = path.join(workspaceDir, section.file);
      return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').trim().length > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }).map(section => section.id);
}

// 每次读取最新正文生成独立临时 Word；未完成的配图仅在预览副本中显示占位。
async function previewContentSection({ sectionId, agentService, openXmlHelperService }) {
  const workspaceDir = agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY)?.paths.workspaceDir;
  if (!workspaceDir) return null;
  let body;
  try {
    body = fs.readFileSync(path.join(workspaceDir, '正文', `${encodeURIComponent(sectionId)}.html`), 'utf8');
    if (!body.trim()) return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const template = JSON.parse(fs.readFileSync(path.join(workspaceDir, '所选模板配置.json'), 'utf8'));
  // 先无损补齐提示词结束标签，使并入模板的图片回到 figure；缺图按 figure 自身图片（含被加粗或链接包裹的）判断，
  // 在结构修复前换成占位，避免尚无 img 的待生成 figure 被修复删除。
  const closed = closeOpenTemplates(body).html;
  const $ = cheerio.load(closed, null, false);
  let replacedImages = false;
  for (const element of $('figure').toArray()) {
    const figure = $(element);
    const reference = ownImages($, element).first().attr('data-yb-asset-ref');
    let missing = !reference;
    if (reference) {
      try {
        fs.accessSync(path.join(workspaceDir, reference));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
      }
    }
    if (missing) {
      const caption = figure.children('figcaption').text().trim();
      figure.replaceWith($('<p>').text(`图片生成中${caption ? `：${caption}` : ''}`));
      replacedImages = true;
    }
  }
  // 其余结构问题（如图片被加粗或链接包裹）再在副本中修复，已生成的图片不会误显示为占位。
  const html = convertibleHtml(replacedImages ? $.html() : closed).html;
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporaryDir = fs.mkdtempSync(path.join(temporaryRoot, 'yibiao-content-preview-'));
  try {
    const rendered = await openXmlHelperService.createRestrictedHtmlDocx(html, template.config, {
      assetRoot: workspaceDir, copyAssets: true,
    });
    const file = path.join(temporaryDir, `${encodeURIComponent(sectionId)}.docx`);
    fs.writeFileSync(file, rendered.bytes);
    return new Uint8Array(fs.readFileSync(file));
  } finally {
    if (path.dirname(temporaryDir) === temporaryRoot && path.basename(temporaryDir).startsWith('yibiao-content-preview-')) {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }
}

// 小节 Word 仅转换正文，目录标题由页面显示；只复用已登记成功且仍存在的文件。
// 转换不做结构校验，有结构问题的旧正文在副本中修复后转换并通过 onStructureRepaired 留痕，源 HTML 不回写。
// 无法导出的单张图片由助手在原位改为文字提示，通过 onImagesSkipped 留痕，不使本节转换失败。
async function convertContentSections({ result, outputDir, openXmlHelperService, signal, completed = [], onProgress = () => {}, onActivity, onStructureRepaired, onImagesSkipped }) {
  const { workspaceDir, sections } = result;
  const template = JSON.parse(fs.readFileSync(path.join(workspaceDir, '所选模板配置.json'), 'utf8'));
  const saved = new Map(completed.filter(item => fs.existsSync(path.join(outputDir, item.file))
    && fs.statSync(path.join(outputDir, item.file)).size > 0).map(item => [item.section_id, item]));
  fs.mkdirSync(outputDir, { recursive: true });
  for (const section of sections) {
    signal.throwIfAborted();
    const file = `${encodeURIComponent(section.section_id)}.docx`;
    const target = path.join(outputDir, file);
    try {
      if (saved.get(section.section_id)?.file !== file) {
        onActivity?.({ progress: { step: 'word-converting', label: `正在转换 ${section.number} ${section.title}` } });
        const { html: body, problems, repairs } = convertibleHtml(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
        const rendered = await openXmlHelperService.createRestrictedHtmlDocx(body, template.config, {
          assetRoot: workspaceDir, copyAssets: true,
        });
        signal.throwIfAborted();
        fs.writeFileSync(`${target}.tmp`, rendered.bytes);
        fs.renameSync(`${target}.tmp`, target);
        if (problems.length) {
          onStructureRepaired?.(`小节 ${section.number} ${section.title} 正文结构不完整（${problems.length} 处），已在转换副本中自动修复${repairs.length ? `：${repairs.join('；')}` : ''}。`);
        }
        if (rendered.imageWarnings.length) {
          onImagesSkipped?.(`小节 ${section.number} ${section.title} 有 ${rendered.imageWarnings.length} 张图片无法写入 Word，已在原位置用文字标出：${[...new Set(rendered.imageWarnings.map(item => `${item.assetRef}（${item.reason}）`))].join('；')}。`);
        }
        saved.set(section.section_id, { section_id: section.section_id, file });
        onProgress(sections.flatMap(item => saved.has(item.section_id) ? [saved.get(item.section_id)] : []));
      }
    } catch (error) {
      onActivity?.({ progress: { step: 'word-converting', label: `${section.number} ${section.title} ${signal.aborted ? '转换已暂停' : '转换失败'}` } });
      if (signal.aborted) throw signal.reason;
      throw new Error(`小节 ${section.number} ${section.title} 转 Word 失败：${error.message}`, { cause: error });
    }
  }
  return sections.map(section => saved.get(section.section_id));
}

module.exports = { scanGeneratedSections, previewContentSection, convertContentSections };
