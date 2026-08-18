'use strict';

const fs = require('node:fs');
const path = require('node:path');

const templateFillsDirRelativePath = path.join('technical-plan', 'template-fills').replace(/\\/g, '/');

function buildTemplateFillBookmarkName(nodeId) {
  const safeId = String(nodeId || '').replace(/[^A-Za-z0-9_]/g, '_');
  return `yibiao-template-fill-${safeId}`;
}

function safeNodeFilePart(nodeId) {
  return String(nodeId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'node';
}

function collectLeafContexts(items, parents = []) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const nextParents = [...parents, item];
    if (item?.children?.length) {
      results.push(...collectLeafContexts(item.children, nextParents));
    } else {
      results.push({ item, parentChapters: parents });
    }
  }
  return results;
}

function extractKeywords(title, description) {
  const parts = String(title || '').split(/[\s,，、;；/\\()（）【】\[\]]+/)
    .concat(String(description || '').split(/[\s,，、;；/\\()（）【】\[\]]+/));
  return [...new Set(parts.map((part) => part.trim()).filter((part) => part.length >= 2))].slice(0, 6);
}

function extractSearchPhrases(title, description) {
  const phrases = [];
  const titleText = String(title || '').trim();
  if (titleText.length >= 2) phrases.push(titleText);
  const descText = String(description || '').trim();
  if (descText.length >= 4) {
    const firstSentence = descText.split(/[。；;\n]/).map((part) => part.trim()).find((part) => part.length >= 4);
    if (firstSentence) phrases.push(firstSentence.slice(0, 30));
  }
  return phrases;
}

function createTemplateFillService({ store, docxAgentService } = {}) {
  function getSourceDocxFiles() {
    return (store.getTenderSourceFiles() || [])
      .filter((file) => file.sourceDocxPath)
      .map((file) => ({
        id: file.id,
        fileName: file.fileName,
        absPath: store.resolveWorkspaceFilePath(file.sourceDocxPath),
      }))
      .filter((file) => file.absPath && fs.existsSync(file.absPath));
  }

  // 按设计 D3 固定顺序定位：章节 → 搜索 → 关键词/表头。
  async function locateTemplate(source, leaf) {
    const { item, parentChapters } = leaf;
    const sectionText = parentChapters.length
      ? parentChapters[parentChapters.length - 1]?.title || ''
      : '';
    const title = String(item?.title || '').trim();

    for (const sourceFile of source) {
      try {
        const hit = await docxAgentService.locate(sourceFile.absPath, {
          strategy: 'heading',
          text: title,
          sectionText,
        });
        if (hit) return { sourceFile, locator: hit };
      } catch { /* 继续下一个来源 */ }
    }

    for (const phrase of extractSearchPhrases(title, item?.description)) {
      for (const sourceFile of source) {
        try {
          const hit = await docxAgentService.locate(sourceFile.absPath, {
            strategy: 'text',
            text: phrase,
            sectionText,
          });
          if (hit) return { sourceFile, locator: hit };
        } catch { /* 继续下一个来源 */ }
      }
    }

    const keywords = extractKeywords(title, item?.description);
    if (keywords.length) {
      for (const sourceFile of source) {
        try {
          const hit = await docxAgentService.locate(sourceFile.absPath, {
            strategy: 'table_header',
            keywords,
          });
          if (hit) return { sourceFile, locator: hit };
        } catch { /* 继续下一个来源 */ }
      }
    }

    return null;
  }

  async function extractSnapshot(sourceFile, locator, nodeId) {
    const fillsDir = store.getTemplateFillsDir();
    fs.mkdirSync(fillsDir, { recursive: true });
    const fileName = `${safeNodeFilePart(nodeId)}.docx`;
    const outPath = path.join(fillsDir, fileName);
    const isTable = locator.start_kind === 'table';
    const result = await docxAgentService.extractRange({
      src: sourceFile.absPath,
      out: outPath,
      startKind: isTable ? 'table' : 'paragraph',
      start: isTable ? undefined : locator.paragraph_index,
      end: isTable ? undefined : locator.end_index_exclusive,
      tableIndex: isTable ? locator.table_index : undefined,
      expectText: isTable ? undefined : String(locator.text || '').slice(0, 20) || undefined,
    });
    return { result, snapshotRelPath: `${templateFillsDirRelativePath}/${fileName}` };
  }

  // 状态行结构对齐 technical_plan_template_fills；onUpdate(patch) 用于任务 checkpoint。
  async function fillTemplateLeaves({ nodeIds = null, force = false, onUpdate = null } = {}) {
    const state = store.loadTechnicalPlan();
    const outline = state?.outlineData?.outline || [];
    const leaves = collectLeafContexts(outline).filter(({ item }) => item?.content_mode === 'template-fill');
    const targetLeaves = Array.isArray(nodeIds) && nodeIds.length
      ? leaves.filter(({ item }) => nodeIds.includes(item.id))
      : leaves;
    const summary = { total: targetLeaves.length, success: 0, error: 0, skipped: 0, pending: 0 };

    if (!targetLeaves.length) return summary;

    const existingFills = store.getTemplateFills() || {};
    const source = getSourceDocxFiles();

    let runtimeError = null;
    if (!source.length) {
      runtimeError = null;
    } else {
      try {
        await docxAgentService.ensureRuntime();
      } catch (error) {
        runtimeError = error?.message || String(error);
      }
    }

    for (const leaf of targetLeaves) {
      const nodeId = leaf.item.id;
      const previous = existingFills[nodeId];
      if (!force && previous?.status === 'success' && previous.snapshotRelPath) {
        summary.success += 1;
        continue;
      }
      const timestamp = new Date().toISOString();
      const emit = (fill) => {
        if (onUpdate) onUpdate({ [nodeId]: fill });
        else store.updateTechnicalPlan({ templateFills: { [nodeId]: fill } });
      };

      if (!source.length) {
        summary.skipped += 1;
        emit({
          nodeId,
          status: 'skipped',
          sourceFileId: undefined,
          locator: undefined,
          previewText: '',
          snapshotRelPath: undefined,
          error: '未找到招标原始 Word，请重新上传招标文件，以保留原始 Word',
          updatedAt: timestamp,
        });
        continue;
      }
      if (runtimeError) {
        summary.error += 1;
        emit({
          nodeId,
          status: 'error',
          sourceFileId: undefined,
          locator: undefined,
          previewText: '',
          snapshotRelPath: undefined,
          error: runtimeError,
          updatedAt: timestamp,
        });
        continue;
      }

      let matched = null;
      try {
        matched = await locateTemplate(source, leaf);
      } catch (error) {
        matched = null;
      }

      if (!matched) {
        summary.error += 1;
        emit({
          nodeId,
          status: 'error',
          sourceFileId: undefined,
          locator: undefined,
          previewText: '',
          snapshotRelPath: undefined,
          error: '未能在招标文件中定位到对应模板区域（已按章节、搜索、表头依次尝试）',
          updatedAt: timestamp,
        });
        continue;
      }

      try {
        const { result, snapshotRelPath } = await extractSnapshot(matched.sourceFile, matched.locator, nodeId);
        summary.success += 1;
        emit({
          nodeId,
          status: 'success',
          sourceFileId: matched.sourceFile.id,
          locator: {
            strategy: matched.locator.strategy,
            start_kind: matched.locator.start_kind,
            start_index: matched.locator.start_kind === 'table' ? matched.locator.table_index : matched.locator.paragraph_index,
            end_index_exclusive: matched.locator.end_index_exclusive,
            heading: matched.locator.heading_level,
            expect_text: String(matched.locator.text || '').slice(0, 30),
            alternatives: matched.locator.alternatives || [],
            source_file_name: matched.sourceFile.fileName,
          },
          previewText: result.preview_text || '',
          snapshotRelPath,
          error: undefined,
          updatedAt: timestamp,
        });
      } catch (error) {
        summary.error += 1;
        emit({
          nodeId,
          status: 'error',
          sourceFileId: matched.sourceFile.id,
          locator: undefined,
          previewText: '',
          snapshotRelPath: undefined,
          error: `模板内容抽取失败：${error?.message || error}`,
          updatedAt: timestamp,
        });
      }
    }
    return summary;
  }

  return {
    fillTemplateLeaves,
    buildTemplateFillBookmarkName,
  };
}

module.exports = {
  createTemplateFillService,
  buildTemplateFillBookmarkName,
};
