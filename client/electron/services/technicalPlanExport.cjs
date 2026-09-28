const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { collectOutlineExportEntries, getPendingContentModeMessage, renderMarkdownForRestrictedHtml } = require('./exportService.cjs');

/** 转义程序插入的项目名、目录标题和占位提示。 */
function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 读取 AI 小节正文；正文缺失或图片未就绪时返回未完成原因，其他读取错误继续抛出。 */
function readAiSection(workspaceDir, file, layoutCheck) {
  if (!workspaceDir) return { reason: '正文未生成', detail: `正文 Agent 工作区不存在，无法读取 ${file}` };
  let body;
  try {
    body = fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { reason: '正文未生成', detail: `正文文件不存在：${file}` };
    throw error;
  }
  if (!body.trim()) return { reason: '正文未生成', detail: `正文文件为空：${file}` };
  const $ = cheerio.load(body, null, false);
  const imageWarnings = [];
  for (const [index, element] of $('figure').toArray().entries()) {
    const figure = $(element);
    if (figure.children('img').length === 1) continue;
    const detail = `第 ${index + 1} 个 figure 必须包含一个直接子级 img`;
    if (layoutCheck) throw new Error(detail);
    const caption = figure.children('figcaption').text().trim();
    imageWarnings.push(`${detail}${caption ? `（${caption}）` : ''}`);
    // 只替换导出副本中的异常图片块，保留同节正文、表格和正常图片。
    figure.replaceWith($('<p>').text('图片引用失败'));
  }
  for (const img of $('img').toArray()) {
    const reference = $(img).attr('data-yb-asset-ref');
    if (!reference) return { reason: '有图片未生成完成', detail: '图片缺少 data-yb-asset-ref' };
    try {
      fs.accessSync(path.join(workspaceDir, reference));
    } catch (error) {
      if (error.code === 'ENOENT') return { reason: '有图片未生成完成', detail: `图片文件不存在：${reference}` };
      throw error;
    }
  }
  return { body: imageWarnings.length ? $.html() : body, $, imageWarnings };
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

    /** 按当前目录顺序组装全文，统一套用当前模板并转换一次；用户导出跳过未完成的 AI 小节，格式自检保持严格校验。 */
    async build(snapshot, { onProgress, stats, developerLogger, layoutCheck = false }) {
      const entries = collectOutlineExportEntries(snapshot.outline, snapshot.export_template_scope === 'ai-only');
      const assets = new Map();
      const ranges = [];
      const layoutSources = [];
      const warnings = [];
      const imageWarnings = [];
      // 仅自检副本携带定位标记，转换器会将其替换为不可见书签。
      const mark = (html, source) => {
        const name = `yb_layout_${layoutSources.length}`;
        layoutSources.push({ name, ...source });
        return `<p>YIBIAOLAYOUT:${name}</p>\n${html}`;
      };
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
              const section = readAiSection(snapshot.workspaceDir, file, layoutCheck);
              if (section.reason) {
                if (layoutCheck) throw new Error(section.detail);
                warnings.push(`小节 ${label} 未导出正文：${section.reason}`);
                body = '<p><em>[本小节未完成，未导出正文]</em></p>';
              } else if (layoutCheck) {
                const { $ } = section;
                const blocks = $.root().children().toArray();
                body = blocks.map((node, blockIndex) => mark($.html(node), {
                  section_id: item.id, file, block_index: blockIndex,
                  image: node.name === 'figure' || $(node).find('figure').length > 0,
                  figure_ids: $(node).find('figure').addBack('figure').map((_i, figure) => $(figure).attr('id')).get(),
                  text: $(node).text().slice(0, 160),
                })).join('\n');
              } else {
                body = section.body;
                imageWarnings.push(...section.imageWarnings.map(warning => `小节 ${label} 未导出异常图片：${warning}`));
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
        const heading = `<h${level} data-yb-outline-number="${item.number}">${escapeHtml(item.title)}</h${level}>`;
        append(`${layoutCheck ? mark(heading, { section_id: item.id, heading: level }) : heading}\n${body}`, useTemplate, sectionTemplate);
        onProgress?.({ phase: 'running', progress: 10 + Math.round((index + 1) / entries.length * 40), message: `正在读取正文 ${index + 1}/${entries.length}：${label}`, warnings: [], ...stats });
      }
      const html = ranges.map(range => `<section data-yb-export-template="${range.useTemplate}" data-yb-export-page-template="${range.sectionTemplate}">${range.html}</section>`).join('\n');
      developerLogger?.write('export.technical_plan.html.assembled', { section_count: entries.length, skipped_section_count: warnings.length, skipped_image_count: imageWarnings.length, html_chars: html.length, image_count: cheerio.load(html)('img').length });
      onProgress?.({ phase: 'running', progress: 55, message: '正在按当前模板转换整本 Word。', warnings: [], ...stats });
      const result = await openXmlHelperService.createRestrictedHtmlDocx(html, snapshot.export_format, {
        assetRoot: snapshot.workspaceDir, copyAssets: true, assets, wholeDocument: true,
      });
      return {
        buffer: Buffer.from(result.bytes), warnings: [...warnings, ...imageWarnings], stats,
        ...(warnings.length || imageWarnings.length ? { message: `Word 已导出，${[
          warnings.length ? `${warnings.length} 个 AI 小节未完成，仅保留标题` : '',
          imageWarnings.length ? `${imageWarnings.length} 处图片结构异常，已保留提示及其余正文` : '',
        ].filter(Boolean).join('；')}。` } : {}),
        ...(layoutCheck ? { layoutSources } : {}),
      };
    },
  };
}

module.exports = { createTechnicalPlanExport };
