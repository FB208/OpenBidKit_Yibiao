const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');

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
  const $ = cheerio.load(body, null, false);
  let replacedImages = false;
  for (const element of $('figure').toArray()) {
    const figure = $(element);
    const reference = figure.children('img').attr('data-yb-asset-ref');
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
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporaryDir = fs.mkdtempSync(path.join(temporaryRoot, 'yibiao-content-preview-'));
  try {
    const rendered = await openXmlHelperService.createRestrictedHtmlDocx(replacedImages ? $.html() : body, template.config, {
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
async function convertContentSections({ result, outputDir, openXmlHelperService, signal, completed = [], onProgress = () => {} }) {
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
        const body = fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
        const rendered = await openXmlHelperService.createRestrictedHtmlDocx(body, template.config, {
          assetRoot: workspaceDir, copyAssets: true,
        });
        signal.throwIfAborted();
        fs.writeFileSync(`${target}.tmp`, rendered.bytes);
        fs.renameSync(`${target}.tmp`, target);
        saved.set(section.section_id, { section_id: section.section_id, file });
        onProgress(sections.flatMap(item => saved.has(item.section_id) ? [saved.get(item.section_id)] : []));
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`小节 ${section.number} ${section.title} 转 Word 失败：${error.message}`, { cause: error });
    }
  }
  return sections.map(section => saved.get(section.section_id));
}

module.exports = { scanGeneratedSections, previewContentSection, convertContentSections };
