function stripFencedCodeBlocks(content: string) {
  return content.replace(/```[\s\S]*?```/g, '\n');
}

function stripMarkdownImages(content: string) {
  return content.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
}

function keepMarkdownLinkText(content: string) {
  return content
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
}

function stripUrls(content: string) {
  return content.replace(/\b(?:https?|file|yibiao-asset):\/\/\S+/gi, ' ');
}

function stripHtml(content: string) {
  return content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|tr|td|th|li|ul|ol|table|thead|tbody|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeMarkdownLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) return '';

  return line
    .replace(/^\s{0,3}#{1,6}\s+/g, ' ')
    .replace(/^\s{0,3}>\s?/g, ' ')
    .replace(/^\s*[-+*]\s+(?:\[[ xX]\]\s*)?/g, ' ')
    .replace(/^\s*\d+[.)．、]\s+/g, ' ')
    .replace(/^\s*\|/, ' ')
    .replace(/\|\s*$/g, ' ')
    .replace(/\|/g, ' ');
}

export function normalizeReadableText(content: string) {
  return stripHtml(stripUrls(keepMarkdownLinkText(stripMarkdownImages(stripFencedCodeBlocks(String(content || ''))))))
    .split(/\r?\n/)
    .map(normalizeMarkdownLine)
    .join('\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[~*_#>\[\](){}|\\]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countReadableWords(content: string) {
  const readableText = normalizeReadableText(content);
  if (!readableText) return 0;

  const cjkCount = (readableText.match(/[\u3400-\u9fff]/gu) || []).length;
  const withoutCjk = readableText.replace(/[\u3400-\u9fff]/gu, ' ');
  const tokenCount = (withoutCjk.match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*/g) || []).length;
  return cjkCount + tokenCount;
}
