const fs = require('node:fs');
const path = require('node:path');

// 仅统计本次目标的已落盘正文；临时文件、配图源码和其他小节不参与进度。
function scanGeneratedSections(workspaceDir, targets) {
  return targets.filter(section => {
    try {
      const file = path.join(workspaceDir, section.file);
      return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').trim().length > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }).length;
}

// 按本次目录顺序逐节转换；只复用明确记录为成功且仍存在的 Word 文件。
async function convertContentSections({ result, outputDir, openXmlHelperService, signal, completed = [], onProgress = () => {} }) {
  const { workspaceDir, sections } = result;
  const template = JSON.parse(fs.readFileSync(path.join(workspaceDir, '所选模板配置.json'), 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const headings = new Map();
  // 小节独立成册，但保留原目录中的标题级别和对应模板样式。
  function visit(nodes, level = 1) {
    for (const node of nodes) {
      headings.set(node.id, { title: node.title, level });
      visit(node.children || [], level + 1);
    }
  }
  visit(decisions.outline);
  const saved = new Map(completed.filter(item => fs.existsSync(path.join(outputDir, item.file))
    && fs.statSync(path.join(outputDir, item.file)).size > 0).map(item => [item.section_id, item]));
  fs.mkdirSync(outputDir, { recursive: true });
  for (const section of sections) {
    signal.throwIfAborted();
    const file = `${encodeURIComponent(section.section_id)}.docx`;
    const target = path.join(outputDir, file);
    try {
      if (saved.get(section.section_id)?.file !== file) {
        const { title, level } = headings.get(section.section_id);
        if (level > 6) throw new Error('当前转换器最多支持六级章节标题');
        const escapedTitle = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const body = fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
        const html = `<!-- yibiao:block -->\n<h${level}>${escapedTitle}</h${level}>\n${body}`;
        const rendered = await openXmlHelperService.createRestrictedHtmlDocx(html, template.config, {
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

module.exports = { scanGeneratedSections, convertContentSections };
