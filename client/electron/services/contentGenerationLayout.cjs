const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { countReadableWords } = require('../utils/wordCount.cjs');

// 独立隐藏窗口完成布局，不依赖用户打开正文页面，也不加载外部网页。
async function readWordLayout(file, signal) {
  const { BrowserWindow } = require('electron');
  signal.throwIfAborted();
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'wordLayoutPreload.cjs'), sandbox: false,
    nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
  } });
  const close = () => { if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await window.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const layout = await window.webContents.executeJavaScript(`window.wordLayout.read(${JSON.stringify(file)})`);
    signal.throwIfAborted();
    return layout;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}

// 布局中的单元格段落坐标已相对于页面正文区，递归只取内容，不把单元格空白当页尾。
function paragraphs(blocks) {
  return blocks.flatMap(block => block.kind === 'paragraph' ? [block]
    : (block.rows || []).flatMap(row => row.cells.flatMap(cell => paragraphs(cell.blocks || []))));
}

// 按实际文流分组：单栏；或通栏标题之间的左栏、右栏。通栏边界前的平衡留白不处理。
function flowSlots(layout, twoColumn) {
  const slots = [];
  for (const page of layout.pages) {
    const width = page.contentBox.width;
    const dual = twoColumn && page.fragments.some(block => block.box.width > width * 0.35 && block.box.width < width * 0.6);
    if (!dual) {
      slots.push({ page: page.index + 1, column: 1, blocks: page.fragments, limit: page.contentBox.height });
      continue;
    }
    let band = [];
    const flush = limit => {
      for (const column of [1, 2]) {
        const blocks = band.filter(block => (block.box.x < width / 2 ? 1 : 2) === column);
        if (blocks.length) slots.push({ page: page.index + 1, column, blocks, limit });
      }
      band = [];
    };
    for (const block of page.fragments) {
      if (block.box.width > width * 0.8) {
        flush(block.box.y);
        slots.push({ page: page.index + 1, column: 0, blocks: [block], limit: block.box.y + block.box.height });
      } else band.push(block);
    }
    flush(page.contentBox.height);
  }
  return slots;
}

// 只为确切映射到下一页/栏图片块的大留白安排补写，页内、表内和图片内部空白均不计入。
function analyzeLayout(layout, sources, targetIds, twoColumn = false) {
  const sourcesByName = new Map(sources.map(source => [source.name, source]));
  const sourceByParagraph = new Map((layout.destinations || []).flatMap(destination => {
    const source = sourcesByName.get(destination.anchor.name);
    return source ? [[destination.anchor.paragraphId, source]] : [];
  }));
  const slots = flowSlots(layout, twoColumn);
  const gaps = [];
  for (let index = 0; index < slots.length - 1; index++) {
    const slot = slots[index];
    const next = slots[index + 1];
    const currentParagraphs = paragraphs(slot.blocks);
    const following = paragraphs(next.blocks).find(p => p.lines.some(line => line.drawings?.length || line.spans?.some(span => span.text?.trim())));
    const source = following && sourceByParagraph.get(following.paragraphId);
    // 下一章标题、最后一页、显式分页、跨页图片的续片都不是补写位置。
    if (!source?.image || !targetIds.has(source.section_id) || following.fragmentIndex > 0
      || following.props?.some(prop => prop.localName === 'pageBreakBefore')
      || (slot.page === next.page && next.column === 0)) continue;
    const bottom = Math.max(0, ...slot.blocks.map(block => block.box.y + block.box.height));
    const gap = slot.limit - bottom;
    if (gap < 72 / 2.54 * 3) continue;
    const nextParagraphs = paragraphs(next.blocks);
    const nextSourceIndex = nextParagraphs.findIndex((p, i) => i > 0 && sourceByParagraph.has(p.paragraphId)
      && sourceByParagraph.get(p.paragraphId) !== source);
    const imageBlock = nextParagraphs.slice(0, nextSourceIndex < 0 ? undefined : nextSourceIndex);
    const blockHeight = Math.max(...imageBlock.map(p => p.box.y + p.box.height)) - Math.min(...imageBlock.map(p => p.box.y));
    if (blockHeight <= gap) continue; // 能放下的块不归因于图片挤出，避免把分栏平衡当成缺字。
    const columnWidth = Math.max(...slot.blocks.map(block => block.box.width));
    const body = currentParagraphs.filter(p => p.outlineLevel == null && p.styleId === 'Normal'
      && Math.abs(p.box.width - columnWidth) < columnWidth * 0.08
      && !p.lines.some(line => line.drawings?.length));
    // 只用邻近的完整正文行估算；短段尾行、图注和表格窄列不能代表正文密度。
    const samples = body.slice(-8).flatMap(p => p.lines.slice(0, -1)).filter(line => countReadableWords(line.spans.map(span => span.text || '').join('')) > 0);
    if (!samples.length) continue;
    const lineHeight = samples.reduce((sum, line) => sum + line.box.height, 0) / samples.length;
    if (gap <= lineHeight * 4) continue;
    const wordsPerLine = samples.reduce((sum, line) => sum + countReadableWords(line.spans.map(span => span.text || '').join('')), 0) / samples.length;
    const spacing = body.at(-1)?.spacing || {};
    const usable = gap - lineHeight - (spacing.before || 0) - (spacing.after || 0);
    const words = Math.floor(Math.floor(usable / lineHeight) * wordsPerLine);
    if (words <= 0) continue;
    gaps.push({ section_id: source.section_id, file: source.file, block_index: source.block_index,
      figure_ids: source.figure_ids, target_text: source.text, page: slot.page, column: slot.column,
      gap_cm: Number((gap * 2.54 / 72).toFixed(2)), suggested_words: words,
      preceding_text: currentParagraphs.at(-1)?.lines.flatMap(line => line.spans.map(span => span.text || '')).join('').slice(-160) || '',
    });
  }
  return gaps;
}

// 临时导出、一次并发补写、一次复查；阶段状态随正文 Session 保存，恢复时不重新分配名额。
async function runContentLayoutCheck({ exporter, taskKey, agentService, result, signal, resume, supplement, onProgress,
  layoutDocument = readWordLayout }) {
  let state = resume ? agentService.loadPersistentTask(taskKey).state.layout_check : null;
  const save = next => {
    agentService.updatePersistentTask(taskKey, { layout_check: next,
      status: next.status === 'completed' ? 'success' : 'running',
      phase: next.status === 'completed' ? 'completed' : 'layout-checking',
      ...(next.status === 'completed' ? { agent_connection: 'idle' } : {}),
    });
    state = next;
    onProgress(state);
  };
  if (!state) save({ status: 'checking', jobs: [], completed_section_ids: [] });
  else onProgress(state);
  if (state.status === 'completed') return state;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-content-layout-'));
  const targetIds = new Set(result.sections.map(section => section.section_id));
  let snapshot;
  // 每次复查重新导出当前 HTML，但同一轮使用相同模板，避免检测口径变化。
  const inspect = async () => {
    signal.throwIfAborted();
    const output = await exporter.build(snapshot, { layoutCheck: true });
    signal.throwIfAborted();
    const file = path.join(directory, '格式自检.docx');
    fs.writeFileSync(file, output.buffer);
    const layout = await layoutDocument(file, signal);
    signal.throwIfAborted();
    const page = snapshot.export_format.page;
    return analyzeLayout(layout, output.layoutSources, targetIds, page?.orientation === 'landscape' && page.two_column);
  };
  try {
    snapshot = exporter.prepare();
    if (state.status === 'checking') {
      const gaps = await inspect();
      const jobs = result.sections.flatMap(section => {
        const items = gaps.filter(gap => gap.section_id === section.section_id);
        return items.length ? [{ section_id: section.section_id, file: section.file, original_words: section.words, gaps: items }] : [];
      });
      save({ ...state, jobs, status: jobs.length ? 'supplementing' : 'completed', remaining_gaps: [] });
    }
    if (state.status === 'supplementing') {
      if (state.jobs.some(job => !state.completed_section_ids.includes(job.section_id))) {
        await supplement({ get: () => state, save });
      }
      signal.throwIfAborted();
      save({ ...state, status: 'rechecking' });
    }
    if (state.status === 'rechecking') save({ ...state, status: 'completed', remaining_gaps: await inspect() });
    return state;
  } finally {
    // directory 由本函数在系统临时目录创建，包含的只有本轮自检 Word。
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { readWordLayout, analyzeLayout, runContentLayoutCheck };
