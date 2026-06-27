const rendererCache = new Map();

async function loadMarkdownModules() {
  const [markdownItModule, cjkFriendlyModule, taskListsModule] = await Promise.all([
    import('markdown-it'),
    import('markdown-it-cjk-friendly'),
    import('markdown-it-task-lists'),
  ]);

  return {
    MarkdownIt: markdownItModule.default || markdownItModule,
    cjkFriendly: cjkFriendlyModule.default || cjkFriendlyModule,
    taskLists: taskListsModule.default || taskListsModule,
  };
}

async function createMarkdownRenderer(options) {
  const { MarkdownIt, cjkFriendly, taskLists } = await loadMarkdownModules();
  const renderer = new MarkdownIt(options.enableGfm ? 'default' : 'commonmark', {
    html: options.allowRawHtml,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  renderer.use(cjkFriendly);
  if (options.enableGfm) {
    renderer.use(taskLists, { enabled: true, label: true, labelAfter: true });
  }

  return renderer;
}

async function getMarkdownRenderer(options = {}) {
  const normalized = {
    allowRawHtml: options.allowRawHtml === true,
    enableGfm: options.enableGfm !== false,
  };
  const cacheKey = `${normalized.allowRawHtml ? 'html' : 'no-html'}:${normalized.enableGfm ? 'gfm' : 'commonmark'}`;
  const cached = rendererCache.get(cacheKey);
  if (cached) return cached;

  const renderer = await createMarkdownRenderer(normalized);
  rendererCache.set(cacheKey, renderer);
  return renderer;
}

async function renderMarkdownHtml(content, options = {}) {
  const renderer = await getMarkdownRenderer(options);
  return renderer.render(String(content || ''));
}

module.exports = { renderMarkdownHtml };
