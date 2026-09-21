const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { collectOutlineExportEntries, getPendingContentModeMessage, renderMarkdownForRestrictedHtml } = require('./exportService.cjs');

/** 转义程序插入的项目名、目录标题和占位提示。 */
function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 整本导出只读取当前目录、模板和 Agent 产物，不修改正文工作区。 */
function createTechnicalPlanExport({ technicalPlanStore, templateStore, agentService, openXmlHelperService }) {
  return {
    /** 保存对话框与转换使用同一次点击时的目录和模板。 */
    prepare() {
      const state = technicalPlanStore.loadTechnicalPlan();
      if (!state.outlineData?.outline?.length) throw new Error('没有可导出的目录内容');
      const template = templateStore.getTemplate(state.exportTemplateId);
      if (!template) throw new Error('请先到“长嘛样”选择有效的导出模板');
      const task = agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
      return {
        project_name: state.outlineData.project_name,
        outline: state.outlineData.outline,
        export_format: template.config,
        export_template_scope: state.exportTemplateScope,
        workspaceDir: task?.paths.workspaceDir,
      };
    },

    /** 按当前目录顺序组装全文，统一套用当前模板并转换一次。 */
    async build(snapshot, { onProgress, stats, developerLogger }) {
      const entries = collectOutlineExportEntries(snapshot.outline, snapshot.export_template_scope === 'ai-only');
      const assets = new Map();
      const ranges = [];
      // 合并相邻同样式范围，完整章节只排版一次；混合父标题跟随首个子节点的页面。
      const append = (html, useTemplate, sectionTemplate) => {
        const previous = ranges.at(-1);
        if (previous?.useTemplate === useTemplate && previous.sectionTemplate === sectionTemplate) previous.html += `\n${html}`;
        else ranges.push({ html, useTemplate, sectionTemplate });
      };
      append(`<p style="text-align:center"><em>内容由 AI 生成</em></p><p style="text-align:center"><strong>${escapeHtml(snapshot.project_name || '投标技术文件')}</strong></p>`,
        snapshot.export_template_scope !== 'ai-only', entries[0].sectionTemplate);
      for (const [index, entry] of entries.entries()) {
        const { item, level, useTemplate, sectionTemplate } = entry;
        if (level > 6) throw new Error('当前转换器最多支持六级章节标题');
        const label = `${item.number} ${item.title}`;
        let body = '';
        try {
          if (!item.children?.length) {
            if (item.content_mode === 'ai-generate') {
              const file = `正文/${encodeURIComponent(item.id)}.html`;
              if (!snapshot.workspaceDir) throw new Error(`正文 Agent 工作区不存在，无法读取 ${file}`);
              body = fs.readFileSync(path.join(snapshot.workspaceDir, file), 'utf8');
              if (!body.trim()) throw new Error(`正文文件为空：${file}`);
              const $ = cheerio.load(body, null, false);
              for (const img of $('img').toArray()) {
                const reference = $(img).attr('data-yb-asset-ref');
                if (!reference) throw new Error('图片缺少 data-yb-asset-ref');
                fs.accessSync(path.join(snapshot.workspaceDir, reference));
              }
            } else if (String(item.content || '').trim()) {
              body = await renderMarkdownForRestrictedHtml(item.content, assets, { baseDir: snapshot.workspaceDir, developerLogger });
            } else {
              const message = getPendingContentModeMessage(item);
              body = message ? `<p><em>[${escapeHtml(message)}]</em></p>` : '';
            }
          }
        } catch (error) {
          throw new Error(`小节 ${label} 导出失败：${error.message}`, { cause: error });
        }
        // 显式记录目录编号，正文内部标题不能改变后续目录编号。
        append(`<h${level} data-yb-outline-number="${item.number}">${escapeHtml(item.title)}</h${level}>\n${body}`, useTemplate, sectionTemplate);
        onProgress?.({ phase: 'running', progress: 10 + Math.round((index + 1) / entries.length * 40), message: `正在读取正文 ${index + 1}/${entries.length}：${label}`, warnings: [], ...stats });
      }
      const html = ranges.map(range => `<section data-yb-export-template="${range.useTemplate}" data-yb-export-page-template="${range.sectionTemplate}">${range.html}</section>`).join('\n');
      developerLogger?.write('export.technical_plan.html.assembled', { section_count: entries.length, html_chars: html.length, image_count: cheerio.load(html)('img').length });
      onProgress?.({ phase: 'running', progress: 55, message: '正在按当前模板转换整本 Word。', warnings: [], ...stats });
      const result = await openXmlHelperService.createRestrictedHtmlDocx(html, snapshot.export_format, {
        assetRoot: snapshot.workspaceDir, copyAssets: true, assets, wholeDocument: true,
      });
      return { buffer: Buffer.from(result.bytes), warnings: [], stats };
    },
  };
}

module.exports = { createTechnicalPlanExport };
