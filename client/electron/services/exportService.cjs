const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const AdmZip = require('adm-zip');

function sanitizeFilename(value) {
  return String(value || '标书文档')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '标书文档';
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runProperties(options = {}) {
  const parts = ['<w:rFonts w:ascii="SimSun" w:eastAsia="宋体" w:hAnsi="SimSun"/>'];
  if (options.bold) parts.push('<w:b/>');
  if (options.italic) parts.push('<w:i/>');
  if (options.size) parts.push(`<w:sz w:val="${options.size}"/>`);
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

function textRun(text, options = {}) {
  const segments = String(text || '').split(/\r?\n/);
  const content = segments.map((segment, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(segment)}</w:t>`).join('');
  return `<w:r>${runProperties(options)}${content}</w:r>`;
}

function paragraphFromRuns(runs, options = {}) {
  const pPr = [];
  if (options.style) pPr.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);
  pPr.push(`<w:spacing w:after="${options.after ?? 160}"/>`);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runs.join('')}</w:p>`;
}

function paragraph(text, options = {}) {
  return paragraphFromRuns([textRun(text, options)], options);
}

function markdownRuns(text) {
  const pattern = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
  const parts = String(text || '').split(pattern);
  return parts.filter(Boolean).map((part) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return textRun(part.slice(2, -2), { bold: true });
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return textRun(part.slice(1, -1), { italic: true });
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return textRun(part.slice(1, -1));
    }
    return textRun(part);
  });
}

function parseMarkdownBlocks(content) {
  const blocks = [];
  const lines = String(content || '').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].replace(/\r$/, '').trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const stripped = lines[index].replace(/\r$/, '').trim();
        const bulletMatch = /^[-*]\s+(.*)$/.exec(stripped);
        if (bulletMatch) {
          if (bulletMatch[1].trim()) items.push(['unordered', null, bulletMatch[1].trim()]);
          index += 1;
          continue;
        }
        const numberMatch = /^(\d+)\.\s+(.*)$/.exec(stripped);
        if (numberMatch) {
          if (numberMatch[2].trim()) items.push(['ordered', numberMatch[1], numberMatch[2].trim()]);
          index += 1;
          continue;
        }
        break;
      }
      if (items.length) blocks.push(['list', items]);
      continue;
    }

    if (line.includes('|')) {
      const rows = [];
      while (index < lines.length) {
        const stripped = lines[index].replace(/\r$/, '').trim();
        if (!stripped.includes('|')) break;
        if (!/^\|?[-\s|]+\|?$/.test(stripped)) {
          const rowText = stripped.split('|').map((cell) => cell.trim()).filter(Boolean).join(' | ');
          if (rowText) rows.push(rowText);
        }
        index += 1;
      }
      if (rows.length) blocks.push(['table', rows]);
      continue;
    }

    if (line.startsWith('#')) {
      const match = /^(#+)\s*(.*)$/.exec(line);
      if (match) blocks.push(['heading', Math.min(match[1].length, 3), match[2].trim()]);
      index += 1;
      continue;
    }

    const paraLines = [];
    while (index < lines.length) {
      const stripped = lines[index].replace(/\r$/, '').trim();
      if (stripped && !/^[-*]\s+/.test(stripped) && !/^\d+\.\s/.test(stripped) && !stripped.includes('|') && !stripped.startsWith('#')) {
        paraLines.push(stripped);
        index += 1;
      } else {
        break;
      }
    }
    if (paraLines.length) {
      blocks.push(['paragraph', paraLines.join(' ')]);
    } else {
      index += 1;
    }
  }

  return blocks;
}

function renderMarkdownBlocks(paragraphs, blocks) {
  for (const block of blocks) {
    const kind = block[0];
    if (kind === 'list') {
      for (const [itemKind, number, text] of block[1]) {
        const prefix = itemKind === 'unordered' ? '• ' : `${number}. `;
        paragraphs.push(paragraphFromRuns([textRun(prefix), ...markdownRuns(text)]));
      }
    } else if (kind === 'table') {
      for (const row of block[1]) {
        paragraphs.push(paragraph(row));
      }
    } else if (kind === 'heading') {
      paragraphs.push(paragraph(block[2], { style: `Heading${block[1]}`, bold: true }));
    } else if (kind === 'paragraph') {
      paragraphs.push(paragraphFromRuns(markdownRuns(block[1])));
    }
  }
}

function addMarkdownContent(paragraphs, content) {
  renderMarkdownBlocks(paragraphs, parseMarkdownBlocks(content));
}

function addOutlineItems(paragraphs, items, level = 1) {
  for (const item of items || []) {
    const title = `${item.id || ''} ${item.title || '未命名章节'}`.trim();
    if (level <= 3) {
      paragraphs.push(paragraph(title, { style: `Heading${level}`, bold: true }));
    } else {
      paragraphs.push(paragraph(title, { bold: true, after: 80 }));
    }

    if (!item.children?.length) {
      if (String(item.content || '').trim()) {
        addMarkdownContent(paragraphs, item.content);
      }
      continue;
    }

    addOutlineItems(paragraphs, item.children, level + 1);
  }
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>${runProperties()}</w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:spacing w:before="360" w:after="180"/></w:pPr>${runProperties({ bold: true, size: 32 })}</w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:spacing w:before="280" w:after="140"/></w:pPr>${runProperties({ bold: true, size: 28 })}</w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr>${runProperties({ bold: true, size: 24 })}</w:style>
</w:styles>`;
}

function documentXml(payload) {
  const paragraphs = [];
  paragraphs.push(paragraph('内容由AI生成', { italic: true, align: 'center', size: 18 }));
  paragraphs.push(paragraph(payload.project_name || '投标技术文件', { bold: true, align: 'center', size: 32, after: 260 }));

  if (String(payload.project_overview || '').trim()) {
    paragraphs.push(paragraph('项目概述', { style: 'Heading1', bold: true }));
    paragraphs.push(paragraph(payload.project_overview));
  }

  addOutlineItems(paragraphs, payload.outline || []);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphs.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`;
}

function buildDocxBuffer(payload) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`, 'utf-8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf-8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml(payload), 'utf-8'));
  zip.addFile('word/styles.xml', Buffer.from(stylesXml(), 'utf-8'));
  return zip.toBuffer();
}

function createExportService() {
  return {
    async exportWord(payload = {}) {
      if (!Array.isArray(payload.outline) || !payload.outline.length) {
        throw new Error('没有可导出的目录内容');
      }

      const defaultFilename = `${sanitizeFilename(payload.project_name || '标书文档')}.docx`;
      const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
      const result = await dialog.showSaveDialog({
        title: '导出 Word 文档',
        defaultPath: path.join(defaultDir, defaultFilename),
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true, message: '已取消导出' };
      }

      fs.writeFileSync(result.filePath, buildDocxBuffer(payload));
      return { success: true, path: result.filePath, message: 'Word 已导出' };
    },
  };
}

module.exports = {
  createExportService,
  buildDocxBuffer,
};
