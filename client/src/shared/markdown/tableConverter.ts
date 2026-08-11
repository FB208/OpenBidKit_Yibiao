// 表格转换工具：把 HTML 表格 / Markdown 管道表解析成矩形网格模型，
// 再把网格模型序列化为标准 Markdown 管道表（始终不保留合并单元格）。

export interface GridCell {
  text: string;
}

export interface GridModel {
  rows: GridCell[][]; // 每行等长，构成矩形网格
}

export interface DetectedTable {
  grid: GridModel;
  start: number;
  end: number;
  kind: 'html' | 'markdown';
}

function normalizeCellText(raw: string): string {
  return String(raw || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析 HTML 表格（含 colspan/rowspan），展开合并单元格为标准矩形网格。
export function htmlTableToGrid(html: string): GridModel | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const trs = Array.from(table.querySelectorAll('tr'));
  if (!trs.length) return null;

  const occupancy: boolean[][] = [];
  const textAt: string[][] = [];
  let maxCols = 0;

  trs.forEach((tr, r) => {
    occupancy[r] = occupancy[r] || [];
    textAt[r] = textAt[r] || [];
    let c = 0;
    const cells = Array.from(tr.querySelectorAll('td, th'));
    cells.forEach((cell) => {
      while (occupancy[r][c]) c += 1;
      const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
      const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
      const text = normalizeCellText(cell.textContent || '');
      for (let dr = 0; dr < rowspan; dr += 1) {
        const rr = r + dr;
        occupancy[rr] = occupancy[rr] || [];
        textAt[rr] = textAt[rr] || [];
        for (let dc = 0; dc < colspan; dc += 1) {
          const cc = c + dc;
          occupancy[rr][cc] = true;
          if (dr === 0 && dc === 0) {
            textAt[rr][cc] = text;
          } else if (textAt[rr][cc] === undefined) {
            textAt[rr][cc] = '';
          }
        }
      }
      c += colspan;
    });
    maxCols = Math.max(maxCols, occupancy[r].length);
  });

  if (!maxCols) return null;
  const rows: GridCell[][] = [];
  for (let r = 0; r < occupancy.length; r += 1) {
    const row: GridCell[] = [];
    for (let c = 0; c < maxCols; c += 1) {
      row.push({ text: textAt[r]?.[c] || '' });
    }
    rows.push(row);
  }
  if (!rows.length || !rows[0].length) return null;
  return { rows };
}

function splitMarkdownRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((part) => normalizeCellText(part.replace(/\\\|/g, '|')));
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false;
  return /^[\s|:-]+(?:\|[\s|:-]+)+\|?\s*$/.test(trimmed);
}

// 解析单个标准 Markdown 管道表（含表头、分隔行、表体）。
export function markdownTableToGrid(md: string): GridModel | null {
  const lines = md.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isSeparatorLine(lines[i])) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx < 1) return null;
  const headerLine = lines[sepIdx - 1];
  if (!headerLine.includes('|')) return null;

  const rows: GridCell[][] = [splitMarkdownRow(headerLine).map((text) => ({ text }))];
  for (let i = sepIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].includes('|')) break;
    rows.push(splitMarkdownRow(lines[i]).map((text) => ({ text })));
  }
  const colCount = Math.max(...rows.map((row) => row.length));
  rows.forEach((row) => {
    while (row.length < colCount) row.push({ text: '' });
  });
  if (!colCount) return null;
  return { rows };
}

interface OffsetLine {
  text: string;
  start: number;
}

function splitWithOffsets(content: string): OffsetLine[] {
  const lines: OffsetLine[] = [];
  const re = /\r?\n/g;
  let match: RegExpExecArray | null;
  let lineStart = 0;
  while ((match = re.exec(content)) !== null) {
    lines.push({ text: content.slice(lineStart, match.index), start: lineStart });
    lineStart = match.index + match[0].length;
  }
  lines.push({ text: content.slice(lineStart), start: lineStart });
  return lines;
}

function detectMarkdownTableRange(content: string): { start: number; end: number } | null {
  const lines = splitWithOffsets(content);
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isSeparatorLine(lines[i].text)) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx < 1) return null;
  const headerLine = sepIdx - 1;
  if (!lines[headerLine].text.includes('|')) return null;
  let endLine = sepIdx;
  for (let i = sepIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].text.trim();
    if (trimmed.includes('|') && trimmed !== '') endLine = i;
    else break;
  }
  const start = lines[headerLine].start;
  const end = lines[endLine].start + lines[endLine].text.length;
  return { start, end };
}

// 在整段内容中识别第一个表格（Markdown 优先于 HTML，按出现位置靠前者生效）。
export function detectTable(content: string): DetectedTable | null {
  const mdRange = detectMarkdownTableRange(content);
  const htmlMatch = /<table[\s\S]*?<\/table>/i.exec(content);
  const mdStart = mdRange ? mdRange.start : Infinity;
  const htmlStart = htmlMatch ? htmlMatch.index : Infinity;

  if (mdStart <= htmlStart && mdRange) {
    const grid = markdownTableToGrid(content.slice(mdRange.start, mdRange.end));
    if (grid) return { grid, start: mdRange.start, end: mdRange.end, kind: 'markdown' };
  }
  if (htmlMatch) {
    const grid = htmlTableToGrid(htmlMatch[0]);
    if (grid) return { grid, start: htmlMatch.index, end: htmlMatch.index + htmlMatch[0].length, kind: 'html' };
  }
  return null;
}

// 把网格模型序列化为标准 Markdown 管道表（无合并单元格）。
export function gridToMarkdown(grid: GridModel): string {
  const colCount = grid.rows[0]?.length ?? 0;
  if (!colCount) return '';
  const escape = (text: string) => text.replace(/\|/g, '\\|');
  const lines: string[] = [];
  grid.rows.forEach((row, index) => {
    lines.push(`| ${row.map((cell) => escape(cell.text)).join(' | ')} |`);
    if (index === 0) {
      lines.push(`| ${row.map(() => '---').join(' | ')} |`);
    }
  });
  return lines.join('\n');
}

// 用新的标准 Markdown 表格替换内容中的第一个表格；若内容无表格则追加。
export function replaceFirstTable(content: string, newTableMarkdown: string): string {
  const detected = detectTable(content);
  if (detected) {
    return content.slice(0, detected.start) + newTableMarkdown + content.slice(detected.end);
  }
  const trimmed = content.trim();
  if (!trimmed) return newTableMarkdown;
  return `${content.replace(/\s*$/, '')}\n\n${newTableMarkdown}`;
}
