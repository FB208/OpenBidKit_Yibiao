const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { countPendingUnits, renderBusinessTemplateForExport } = require('./businessTemplateFillTask.cjs');
const { collectOutlineExportEntries, formatPendingMark, getPendingContentModeMessage } = require('./exportService.cjs');
const { findHtmlStructureIssues } = require('../utils/htmlStructure.cjs');

/** 转义程序插入的项目名、目录标题和占位提示。 */
function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 读取 AI 小节正文；图片未就绪时仍返回原始 HTML，供导出前检查源码。 */
function readAiSection(workspaceDir, file) {
  if (!workspaceDir) return { reason: '正文未生成', detail: `正文 Agent 工作区不存在，无法读取 ${file}` };
  let body;
  try {
    body = fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { reason: '正文未生成', detail: `正文文件不存在：${file}` };
    throw error;
  }
  if (!body.trim()) return { body, reason: '正文未生成', detail: `正文文件为空：${file}` };
  const $ = cheerio.load(body, null, false);
  for (const img of $('img').toArray()) {
    const reference = $(img).attr('data-yb-asset-ref');
    if (!reference) return { body, reason: '有图片未生成完成', detail: '图片缺少 data-yb-asset-ref' };
    try {
      fs.accessSync(path.join(workspaceDir, reference));
    } catch (error) {
      if (error.code === 'ENOENT') return { body, reason: '有图片未生成完成', detail: `图片文件不存在：${reference}` };
      throw error;
    }
  }
  return { body, $ };
}

/** AI 叶子的正文文件按稳定 ID 命名。 */
function aiSectionFile(item) {
  return `正文/${encodeURIComponent(item.id)}.html`;
}

/**
 * 整本导出读取当前产物，检查问题交给现有正文任务修复。
 * 非 AI 叶子按节点 ID 并入商务模版中对应的章节，章节按模版原样导出；没有对应章节时保留占位提示。
 */
function createTechnicalPlanExport({ technicalPlanStore, templateStore, agentService, openXmlHelperService, credentialLibraryService, startContentGeneration }) {
  return {
    /**
     * 保存对话框与转换使用同一次点击时的目录和模板。
     * 模板设置页的导出测试传入正在编辑的模板配置，替代项目“长嘛样”已选模板。
     */
    prepare({ exportFormat } = {}) {
      const state = technicalPlanStore.loadTechnicalPlan();
      if (!state.outlineData?.outline?.length) throw new Error('没有可导出的目录内容');
      const template = exportFormat ? null : templateStore.getTemplate(state.exportTemplateId);
      if (!exportFormat && !template) throw new Error('请先到“长嘛样”选择有效的导出模板');
      const task = agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
      return {
        project_name: state.outlineData.project_name,
        outline: state.outlineData.outline,
        export_format: exportFormat || template.config,
        export_template_scope: state.exportTemplateScope,
        workspaceDir: task?.paths.workspaceDir,
      };
    },

    /** 导出前逐节检查原始 HTML，汇总结构问题及稳定文件定位。 */
    inspect(snapshot) {
      const issues = [];
      for (const { item } of collectOutlineExportEntries(snapshot.outline, snapshot.export_template_scope === 'ai-only')) {
        if (item.children?.length || item.content_mode !== 'ai-generate') continue;
        const file = aiSectionFile(item);
        const section = readAiSection(snapshot.workspaceDir, file);
        if (section.body === undefined) continue;
        const problems = findHtmlStructureIssues(section.body, { checkSourceCompleteness: true });
        if (problems.length) issues.push({ id: item.id, section: `${item.number} ${item.title}`, file, problems });
      }
      return issues;
    },

    /** 将本次问题作为结果要求交给原正文任务，不在导出服务执行修复。 */
    repair(issues) {
      const requirement = '导出前检查发现以下小节存在问题。请结合已有会话上下文、项目资料和受限 HTML 规范完成修复，使这些小节具备完整正文、有效图片引用和符合规范的 HTML，能够用于 Word 导出。\n\n'
        + issues.map(issue => `${issue.section}\n稳定 ID：${issue.id}\nHTML 文件：${issue.file}\n检查问题：\n${issue.problems.map(problem => `- ${problem}`).join('\n')}`).join('\n\n');
      return startContentGeneration({ exportRepair: requirement });
    },

    /**
     * 按当前目录顺序组装已通过预检的原始 HTML，统一套用模板；格式自检保持严格校验。
     * 无法导出的单张图片在原位改为文字提示，按小节写入 warnings，不中断导出。
     */
    async build(snapshot, { onProgress, stats, developerLogger, layoutCheck = false }) {
      const entries = collectOutlineExportEntries(snapshot.outline, snapshot.export_template_scope === 'ai-only');
      const templateChapters = new Map((technicalPlanStore.hasBidTemplate() ? technicalPlanStore.readBidTemplateFields().chapters || [] : [])
        .filter(chapter => chapter.id)
        .map(chapter => [chapter.id, chapter]));
      const businessIds = new Set(entries
        .filter(({ item }) => !item.children?.length && item.content_mode !== 'ai-generate' && templateChapters.has(item.id))
        .map(({ item }) => item.id));
      // 页面归属：模版章节单独成组并使用模版页面；父目录跟随首个子目录，避免孤立标题页。
      const pageKinds = new Array(entries.length);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const { item, level, sectionTemplate } = entries[index];
        pageKinds[index] = item.children?.length && entries[index + 1]?.level > level
          ? pageKinds[index + 1]
          : businessIds.has(item.id) ? 'business' : String(sectionTemplate);
      }
      const ranges = [];
      const layoutSources = [];
      const warnings = [];
      let skippedCount = 0;
      // 图片引用所属小节及各小节无法导出的图片原因，转换结束后按小节汇总提示。
      const imageSections = new Map();
      const imageFailures = new Map();
      const recordImages = (label, references) => {
        for (const reference of references) imageSections.set(reference, new Set(imageSections.get(reference)).add(label));
      };
      const recordImageFailure = (label, reason) => imageFailures.set(label, [...(imageFailures.get(label) || []), reason]);
      // 仅自检副本携带定位标记，转换器会将其替换为不可见书签。
      const mark = (html, source) => {
        const name = `yb_layout_${layoutSources.length}`;
        layoutSources.push({ name, ...source });
        return `<p>YIBIAOLAYOUT:${name}</p>\n${html}`;
      };
      // 合并相邻同样式范围，完整章节只排版一次；混合父标题跟随首个子节点的页面。
      const append = (html, useTemplate, pageKind) => {
        const previous = ranges.at(-1);
        if (previous && !previous.business && previous.useTemplate === useTemplate && previous.pageKind === pageKind) previous.html += `\n${html}`;
        else ranges.push({ html, useTemplate, pageKind });
      };
      const reportEntry = (index, label) => onProgress?.({ phase: 'running', progress: 10 + Math.round((index + 1) / entries.length * 40), message: `正在读取正文 ${index + 1}/${entries.length}：${label}`, warnings: [], ...stats });
      for (const [index, entry] of entries.entries()) {
        const { item, level, useTemplate } = entry;
        if (level > 6) throw new Error('当前转换器最多支持六级章节标题');
        const label = `${item.number} ${item.title}`;
        if (businessIds.has(item.id)) {
          // 模版章节使用自带的标题段，不另写程序标题。
          ranges.push({ business: { id: item.id, title: item.title, level }, useTemplate, pageKind: 'business' });
          reportEntry(index, label);
          continue;
        }
        let body = '';
        try {
          if (!item.children?.length) {
            if (item.content_mode === 'ai-generate') {
              const file = aiSectionFile(item);
              const section = readAiSection(snapshot.workspaceDir, file);
              if (section.reason) {
                if (layoutCheck) throw new Error(section.detail);
                skippedCount += 1;
                warnings.push(`小节 ${label} 未导出正文：${section.reason}`);
                body = `<p><em>${escapeHtml(formatPendingMark('本节正文（未生成完成）'))}</em></p>`;
              } else if (layoutCheck) {
                const problems = findHtmlStructureIssues(section.body);
                if (problems.length) throw new Error(`正文结构不完整：${problems.slice(0, 3).join('；')}`);
                const { $ } = section;
                const blocks = $.root().children().toArray();
                body = blocks.map((node, blockIndex) => mark($.html(node), {
                  section_id: item.id, file, block_index: blockIndex,
                  image: node.name === 'figure' || $(node).find('figure').length > 0,
                  figure_ids: $(node).find('figure').addBack('figure').map((_i, figure) => $(figure).attr('id')).get(),
                  text: $(node).text().slice(0, 160),
                })).join('\n');
                recordImages(label, $('img').map((_i, img) => $(img).attr('data-yb-asset-ref')).get());
              } else {
                body = section.body;
                recordImages(label, section.$('img').map((_i, img) => section.$(img).attr('data-yb-asset-ref')).get());
              }
            } else {
              const message = getPendingContentModeMessage(item);
              body = message ? `<p><em>${escapeHtml(formatPendingMark(message))}</em></p>` : '';
            }
          }
        } catch (error) {
          throw new Error(`小节 ${label} 导出失败：${error.message}`, { cause: error });
        }
        // 显式记录目录编号，正文内部标题不能改变后续目录编号。
        const heading = `<h${level} data-yb-outline-number="${item.number}">${escapeHtml(item.title)}</h${level}>`;
        append(`${layoutCheck ? mark(heading, { section_id: item.id, heading: level }) : heading}\n${body}`, useTemplate, pageKinds[index]);
        reportEntry(index, label);
      }
      const html = ranges.map(range => (range.business
        ? `<section data-yb-business-chapter="${escapeHtml(range.business.id)}" data-yb-business-level="${range.business.level}" data-yb-business-title="${escapeHtml(range.business.title)}" data-yb-export-template="${range.useTemplate}" data-yb-export-page-template="business"></section>`
        : `<section data-yb-export-template="${range.useTemplate}" data-yb-export-page-template="${range.pageKind}">${range.html}</section>`)).join('\n');
      developerLogger?.write('export.technical_plan.html.assembled', { section_count: entries.length, skipped_section_count: warnings.length, business_chapter_count: businessIds.size, html_chars: html.length, image_count: cheerio.load(html)('img').length });
      let business = null;
      if (businessIds.size) {
        onProgress?.({ phase: 'running', progress: 52, message: '正在按已确认的字段值生成商务模版。', warnings: [], ...stats });
        business = await renderBusinessTemplateForExport({ workspaceStore: technicalPlanStore, credentialLibraryService, openXmlHelperService });
      }
      onProgress?.({ phase: 'running', progress: 55, message: '正在按当前模板转换整本 Word。', warnings: [], ...stats });
      let result;
      try {
        result = await openXmlHelperService.createRestrictedHtmlDocx(html, snapshot.export_format, {
          assetRoot: snapshot.workspaceDir, copyAssets: true, wholeDocument: true,
          ...(business ? { businessTemplate: { input: business.input, chapters: [...businessIds].map(id => templateChapters.get(id)) } } : {}),
        });
      } finally {
        business?.cleanup();
      }
      for (const { assetRef, reason } of result.imageWarnings) {
        for (const label of imageSections.get(assetRef)) recordImageFailure(label, reason);
      }
      let failedImageCount = 0;
      for (const [label, reasons] of imageFailures) {
        failedImageCount += reasons.length;
        warnings.push(`小节 ${label} 有 ${reasons.length} 张图片无法导出，已在原位置用文字标出：${[...new Set(reasons)].join('；')}`);
      }
      if (failedImageCount) developerLogger?.write('export.technical_plan.images.skipped', { image_count: failedImageCount, sections: Object.fromEntries(imageFailures) });
      // 商务模版未填写项与已删除的资信库图片都在原位置保留占位，签章位置已留白，不计入未填写。
      const businessNotes = business ? [
        ...[countPendingUnits(business.fields, result.businessFieldIds)].filter(Boolean)
          .map(count => `商务模版有 ${count} 项未填写，已在原位置保留占位，请打开文档补充`),
        ...(business.missingImages.size ? [`商务模版有 ${business.missingImages.size} 项所选资信库图片已删除，已在原位置保留占位`] : []),
        ...result.businessWarnings,
      ] : [];
      warnings.push(...businessNotes);
      // 正文、商务占位和程序提示中需要用户补充的位置统一为“【待填写】”，提示总数和搜索关键词。
      const pendingNote = result.pendingMarkCount ? `文档中共有 ${result.pendingMarkCount} 处“待填写”，可在 Word 中搜索后逐项处理` : '';
      if (pendingNote) warnings.push(pendingNote);
      return {
        buffer: Buffer.from(result.bytes), warnings, stats,
        ...(warnings.length ? { message: `Word 已导出，${[
          skippedCount ? `其中 ${skippedCount} 个 AI 小节未完成，仅保留标题，请完成后重新导出` : '',
          failedImageCount ? `${failedImageCount} 张图片无法导出，已在原位置用文字标出，请打开文档核对` : '',
          ...businessNotes,
          pendingNote,
        ].filter(Boolean).join('；')}。` } : {}),
        ...(layoutCheck ? { layoutSources } : {}),
      };
    },
  };
}

module.exports = { createTechnicalPlanExport };
