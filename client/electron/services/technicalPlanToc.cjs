const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWordPageAnchors } = require('./contentGenerationLayout.cjs');
const { removeTemporaryDir } = require('../utils/forceRemove.cjs');

const TOC_BOOKMARK_PREFIX = '_Toc';
// 目录书签与页码引用锚点（_YbP）共用一次整本测量。
const MEASURE_BOOKMARK_PREFIX = '_';
const MAX_ROUNDS = 3;
const MEASURE_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_HINT = '请在 Word 中右键目录 →“更新域”';
const REF_UPDATE_HINT = '请在 Word 中全选（Ctrl+A）后按 F9 更新域';

/**
 * 整本导出目录和页码引用的页码。助手已写满全部目录条目、页码为等宽占位，因此先测整本即可得到各标题和锚点的最终页；
 * 回填后条目只会变窄，个别长标题少折一行可能让目录少一页：用只含目录的小文档复测，
 * 少了 Δ 页就把目录之后的条目和锚点统一减 Δ（目录前后都是硬分页，后续内容整体平移），最多 3 轮。
 * 没有目录时只测一次整本。测量失败不阻断导出，页码留空；清空页码也失败时抛错，不把占位交给用户。
 * 测量页码与 Word 分页有出入，文档也不写打开时更新域（Word 打开时的更新在排版完成前执行会算成 1），测量成功时也提示手动更新。
 */
async function fillTableOfContents({ bytes, toc, tocOnlyBytes, pageRefs, openXmlHelperService, onProgress, developerLogger, measure = readWordPageAnchors }) {
  const started = Date.now();
  const signal = AbortSignal.timeout(MEASURE_TIMEOUT_MS);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-export-toc-'));
  const write = (name, content) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const entries = toc?.entries || [];
  const anchors = pageRefs?.anchors || [];
  const notes = [];
  const log = { entry_count: entries.length, page_ref_count: pageRefs?.count || 0, anchor_count: anchors.length };
  try {
    let pageNumbers = {};
    let anchorPages = {};
    try {
      onProgress?.(85, '正在测量页码');
      const full = await measure(write('full.docx', bytes), MEASURE_BOOKMARK_PREFIX, signal);
      const pageIndexes = new Map(full.destinations);
      const pageOf = (bookmark) => {
        const index = pageIndexes.get(bookmark);
        return index === undefined ? null : Number(full.pages[index] ?? index + 1);
      };
      const pagesOf = (items, delta) => Object.fromEntries(items.flatMap((item) => {
        const page = pageOf(item.bookmark);
        return page === null ? [] : [[item.bookmark, String(item.afterToc ? page - delta : page)]];
      }));
      let delta = 0;
      if (entries.length) {
        const tocPages = (await measure(write('toc-0.docx', tocOnlyBytes), TOC_BOOKMARK_PREFIX, signal)).pageCount;
        for (let round = 1; ; round += 1) {
          pageNumbers = pagesOf(entries, delta);
          const small = await openXmlHelperService.fillTocPageNumbers(tocOnlyBytes, pageNumbers);
          const measured = (await measure(write(`toc-${round}.docx`, small.bytes), TOC_BOOKMARK_PREFIX, signal)).pageCount;
          Object.assign(log, { toc_pages: tocPages, final_toc_pages: measured, delta, rounds: round });
          if (tocPages - measured === delta) break;
          if (round >= MAX_ROUNDS) {
            log.unstable = true;
            break;
          }
          delta = tocPages - measured;
        }
      }
      anchorPages = pagesOf(anchors, delta);
    } catch (error) {
      pageNumbers = {};
      anchorPages = {};
      log.measure_error = error?.message || String(error);
      if (entries.length) notes.push(`目录页码未能计算，已留空：${UPDATE_HINT}`);
      if (anchors.length) notes.push(`页码引用未能计算，已留空：${REF_UPDATE_HINT}`);
    }
    onProgress?.(95, '正在回填页码');
    const filled = await openXmlHelperService.fillTocPageNumbers(bytes, entries.length ? pageNumbers : null, anchors.length ? anchorPages : null);
    Object.assign(log, { missing_count: filled.missingCount, ref_missing_count: filled.refMissingCount });
    if (!log.measure_error) {
      if (Object.keys(pageNumbers).length) notes.push(`目录页码可能不准：${UPDATE_HINT} →“只更新页码”`);
      if (filled.missingCount) notes.push(`${filled.missingCount} 条目录页码未能计算，已留空：${UPDATE_HINT}`);
      if (Object.keys(anchorPages).length) notes.push(`页码引用可能不准：${REF_UPDATE_HINT}`);
      if (filled.refMissingCount) notes.push(`${filled.refMissingCount} 处页码引用未能计算，已留空：${REF_UPDATE_HINT}`);
    }
    return { bytes: filled.bytes, notes };
  } finally {
    // directory 由本函数在系统临时目录创建，只含本次测量用的 Word；删不掉只记日志，不影响导出。
    await removeTemporaryDir(directory, (error) => { log.cleanup_error = error?.message || String(error); });
    developerLogger?.write('export.technical_plan.toc', { ...log, elapsed_ms: Date.now() - started });
  }
}

module.exports = { fillTableOfContents };
