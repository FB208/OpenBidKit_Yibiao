function buildChapterContentMessages({ chapter, parentChapters, siblingChapters, projectOverview }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const chapterDescription = chapter.description || '';
  const messages = [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 注意避免与同级章节内容重复，保持内容的独特性和互补性。
6. 直接返回章节内容，不生成标题，不要任何额外说明或格式标记。`,
    },
  ];

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }

  if (parentChapters?.length) {
    const parentLines = ['上级章节信息：'];
    for (const parent of parentChapters) {
      parentLines.push(`- ${parent.id || 'unknown'} ${parent.title || '未命名章节'}\n  ${parent.description || ''}`);
    }
    messages.push({ role: 'user', content: parentLines.join('\n') });
  }

  if (siblingChapters?.length) {
    const siblingLines = ['同级章节信息（请避免内容重复）：'];
    for (const sibling of siblingChapters) {
      if (sibling.id === chapterId) {
        continue;
      }
      siblingLines.push(`- ${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}\n  ${sibling.description || ''}`);
    }
    if (siblingLines.length > 1) {
      messages.push({ role: 'user', content: siblingLines.join('\n') });
    }
  }

  messages.push({
    role: 'user',
    content: `请为以下标书章节生成具体内容：

当前章节信息：
章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

请根据项目概述信息和上述章节层级关系，生成详细的专业内容，确保与上级章节的内容逻辑相承，同时避免与同级章节内容重复，突出本章节的独特性和技术方案优势。
直接返回编写的正文内容，不要输出标题、解释、总结等任何其他内容`,
  });

  return messages;
}

function normalizeChildren(item) {
  return Array.isArray(item.children) ? item.children : [];
}

function collectLeafContexts(items, parents = []) {
  const results = [];
  for (const item of items || []) {
    const children = normalizeChildren(item);
    if (!children.length) {
      results.push({ item, parentChapters: parents, siblingChapters: items || [] });
      continue;
    }
    results.push(...collectLeafContexts(children, [...parents, item]));
  }
  return results;
}

function updateOutlineItemContent(items, targetId, content) {
  return (items || []).map((item) => {
    if (item.id === targetId) {
      return { ...item, content };
    }

    const children = normalizeChildren(item);
    if (!children.length) {
      return item;
    }

    return { ...item, children: updateOutlineItemContent(children, targetId, content) };
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unwrapMarkdownTitle(line) {
  let normalized = String(line || '').trim();
  normalized = normalized.replace(/^#{1,6}\s+/, '').trim();
  normalized = normalized.replace(/^\*\*(.+)\*\*$/, '$1').trim();
  normalized = normalized.replace(/^__(.+)__$/, '$1').trim();
  return normalized.replace(/[：:：。\s]+$/, '').trim();
}

function stripRepeatedChapterTitle(content, chapter) {
  const title = String(chapter?.title || '').trim();
  if (!title) {
    return content;
  }

  const rawLines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let firstContentLine = rawLines.findIndex((line) => line.trim());
  if (firstContentLine < 0) {
    return content;
  }

  const chapterId = String(chapter?.id || '').trim();
  const firstLine = unwrapMarkdownTitle(rawLines[firstContentLine]);
  let comparable = firstLine;

  if (chapterId) {
    comparable = comparable.replace(new RegExp(`^${escapeRegExp(chapterId)}\\s+`), '').trim();
  }
  comparable = comparable.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '').trim();

  if (comparable !== title && firstLine !== `${chapterId} ${title}`.trim()) {
    return content;
  }

  const nextLines = rawLines.slice(firstContentLine + 1);
  while (nextLines.length && !nextLines[0].trim()) {
    nextLines.shift();
  }
  return [...rawLines.slice(0, firstContentLine), ...nextLines].join('\n').trimStart();
}

function createInitialSections(leaves, existingSections) {
  const next = { ...(existingSections || {}) };
  const leafIds = new Set(leaves.map(({ item }) => item.id));

  for (const key of Object.keys(next)) {
    if (!leafIds.has(key)) {
      delete next[key];
    }
  }

  for (const { item } of leaves) {
    const existing = next[item.id];
    const content = existing?.content || item.content || '';
    const existingStatus = existing?.status === 'running' ? undefined : existing?.status;
    next[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: existingStatus || (content.trim() ? 'success' : 'idle'),
      content,
      error: existing?.error,
      updated_at: existing?.updated_at,
    };
  }

  return next;
}

function progressFor(leaves, sections) {
  if (!leaves.length) {
    return 0;
  }

  const done = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id]?.status)).length;
  return Math.round((done / leaves.length) * 100);
}

function now() {
  return new Date().toISOString();
}

function withSection(sections, item, partial) {
  return {
    ...(sections || {}),
    [item.id]: {
      id: item.id,
      title: item.title || '未命名章节',
      status: 'idle',
      content: '',
      ...(sections || {})[item.id],
      ...partial,
      updated_at: now(),
    },
  };
}

async function runContentGenerationTask({ aiService, workspaceStore, updateTask, payload }) {
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const outlineData = payload.outlineData || storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const leaves = collectLeafContexts(outlineData.outline);
  if (!leaves.length) {
    throw new Error('当前目录没有可生成正文的小节');
  }

  const projectOverview = payload.projectOverview || outlineData.project_overview || storedPlan.projectOverview || '';
  const regenerate = Boolean(payload.regenerate);
  const concurrency = Math.max(1, Math.min(Number(payload.concurrency) || 5, 8));
  let sections = createInitialSections(leaves, storedPlan.contentGenerationSections);
  const tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    return regenerate || section?.status === 'error' || !String(content).trim();
  });
  let logs = [`准备生成正文，共 ${leaves.length} 个小节。`];

  let technicalPlan = workspaceStore.updateTechnicalPlan({
    contentGenerationSections: sections,
    contentGenerationTask: updateTask({ status: 'running', progress: progressFor(leaves, sections), logs }),
  });
  updateTask({ status: 'running', progress: progressFor(leaves, sections), logs }, technicalPlan);

  if (!tasksToRun.length) {
    logs = [...logs, '正文已全部生成，无需重复生成。'];
    technicalPlan = workspaceStore.updateTechnicalPlan({
      contentGenerationTask: updateTask({ status: 'success', progress: 100, logs }),
    });
    updateTask({ status: 'success', progress: 100, logs }, technicalPlan);
    return;
  }

  function saveSection(item, partial, contentForOutline) {
    const prev = workspaceStore.loadTechnicalPlan() || {};
    sections = withSection(prev.contentGenerationSections || sections, item, partial);
    const currentOutlineData = prev.outlineData || outlineData;
    const outlineContent = contentForOutline ?? (sections[item.id].content || '');
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    const saved = workspaceStore.updateTechnicalPlan({
      contentGenerationSections: sections,
      outlineData: nextOutlineData,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections) }, saved);
    return saved;
  }

  async function runOne(context) {
    const { item, parentChapters, siblingChapters } = context;
    let rawContent = regenerate ? '' : sections[item.id]?.content || item.content || '';
    let content = stripRepeatedChapterTitle(rawContent, item);
    logs = [...logs, `开始生成：${item.id} ${item.title || '未命名章节'}`];
    saveSection(item, { status: 'running', content, error: undefined }, content);
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs }, workspaceStore.loadTechnicalPlan());

    try {
      await aiService.streamChat({
        messages: buildChapterContentMessages({ chapter: item, parentChapters, siblingChapters, projectOverview }),
        temperature: 0.7,
      }, (event) => {
        if (event.type !== 'chunk' || !event.chunk) {
          return;
        }
        rawContent += event.chunk;
        content = stripRepeatedChapterTitle(rawContent, item);
        saveSection(item, { status: 'running', content, error: undefined }, content);
      });

      content = stripRepeatedChapterTitle(rawContent, item);
      logs = [...logs, `生成完成：${item.id} ${item.title || '未命名章节'}`];
      saveSection(item, { status: 'success', content, error: undefined }, content);
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs }, workspaceStore.loadTechnicalPlan());
    } catch (error) {
      const message = error.message || '正文生成失败';
      logs = [...logs, `生成失败：${item.id} ${item.title || '未命名章节'}，${message}`];
      saveSection(item, { status: 'error', content, error: message }, content);
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs }, workspaceStore.loadTechnicalPlan());
    }
  }

  for (let index = 0; index < tasksToRun.length; index += concurrency) {
    const batch = tasksToRun.slice(index, index + concurrency);
    await Promise.all(batch.map((context) => runOne(context)));
  }

  const failedCount = leaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
  logs = [...logs, failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。'];
  technicalPlan = workspaceStore.updateTechnicalPlan({
    contentGenerationSections: sections,
    contentGenerationTask: updateTask({ status: 'success', progress: 100, logs }),
  });
  updateTask({ status: 'success', progress: 100, logs }, technicalPlan);
}

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle };
