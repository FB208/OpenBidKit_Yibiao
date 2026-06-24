function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeText)
    .filter(Boolean)
    .slice(0, 6);
}

function buildBidSectionContextHint(selectedSection, options = {}) {
  const hasSelectedSection = options.hasSelectedSection === true;
  const title = normalizeText(selectedSection?.title);
  const headLine = normalizeText(selectedSection?.headLine || selectedSection?.head_line);
  const description = normalizeText(selectedSection?.description);
  const evidence = normalizeEvidence(selectedSection?.evidence);

  if (!title && !headLine && !description && !evidence.length) {
    return hasSelectedSection
      ? '本项目为多标段，当前招标文件已按用户选择的投标范围处理。请以当前输入内容为准，不要主动扩展到其他标段。'
      : '';
  }

  const lines = [
    '本项目为多标段，当前招标文件已按用户选择的投标范围处理。请仅关注当前选择标段和当前输入内容，不要主动扩展到其他标段。',
  ];
  if (title) lines.push(`当前选择标段：${title}`);
  if (headLine) lines.push(`AI 识别标题行：${headLine}`);
  if (description) lines.push(`AI 识别描述：${description}`);
  if (evidence.length) lines.push(`AI 识别依据：${evidence.join('；')}`);
  return lines.join('\n');
}

module.exports = {
  buildBidSectionContextHint,
};
