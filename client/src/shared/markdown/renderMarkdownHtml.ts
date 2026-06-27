import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import markdownItTaskLists from 'markdown-it-task-lists';

export interface RenderMarkdownHtmlOptions {
  allowRawHtml?: boolean;
  enableGfm?: boolean;
}

const rendererCache = new Map<string, MarkdownIt>();

function createMarkdownRenderer(options: Required<RenderMarkdownHtmlOptions>): MarkdownIt {
  const renderer = new MarkdownIt(options.enableGfm ? 'default' : 'commonmark', {
    html: options.allowRawHtml,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  renderer.use(markdownItCjkFriendly);
  if (options.enableGfm) {
    renderer.use(markdownItTaskLists, { enabled: true, label: true, labelAfter: true });
  }

  return renderer;
}

function getMarkdownRenderer(options: RenderMarkdownHtmlOptions = {}): MarkdownIt {
  const normalized: Required<RenderMarkdownHtmlOptions> = {
    allowRawHtml: options.allowRawHtml === true,
    enableGfm: options.enableGfm !== false,
  };
  const cacheKey = `${normalized.allowRawHtml ? 'html' : 'no-html'}:${normalized.enableGfm ? 'gfm' : 'commonmark'}`;
  const cached = rendererCache.get(cacheKey);
  if (cached) return cached;

  const renderer = createMarkdownRenderer(normalized);
  rendererCache.set(cacheKey, renderer);
  return renderer;
}

export function renderMarkdownHtml(content: string, options: RenderMarkdownHtmlOptions = {}): string {
  return getMarkdownRenderer(options).render(String(content || ''));
}
