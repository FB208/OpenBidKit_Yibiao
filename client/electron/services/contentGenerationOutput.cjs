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

module.exports = { scanGeneratedSections, convertContentSections };
