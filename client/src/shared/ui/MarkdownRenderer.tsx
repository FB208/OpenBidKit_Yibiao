import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

interface MarkdownRendererProps {
  children: string;
  components?: Components;
  allowRawHtml?: boolean;
  enableGfm?: boolean;
}

function markdownUrlTransform(value: string) {
  return value.startsWith('yibiao-asset://') ? value : defaultUrlTransform(value);
}

function normalizeExternalUrl(value: string | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^www\./i.test(raw) ? `https://${raw}` : raw;
}

function isExternalHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function openExternal(url: string) {
  if (window.yibiao?.openExternal) {
    void window.yibiao.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

const defaultMarkdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const externalUrl = normalizeExternalUrl(href);
    const isExternal = isExternalHttpUrl(externalUrl);

    return (
      <a
        {...props}
        href={isExternal ? externalUrl : href}
        rel={isExternal ? 'noreferrer' : props.rel}
        target={isExternal ? '_blank' : props.target}
        onClick={(event) => {
          if (!isExternal) return;
          event.preventDefault();
          event.stopPropagation();
          openExternal(externalUrl);
        }}
      >
        {children as ReactNode}
      </a>
    );
  },
};

function mergeMarkdownComponents(components?: Components): Components {
  return { ...defaultMarkdownComponents, ...(components || {}) };
}

function MarkdownRenderer({ children, components, allowRawHtml = true, enableGfm = true }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={enableGfm ? [remarkGfm] : []}
      rehypePlugins={allowRawHtml ? [rehypeRaw] : []}
      urlTransform={markdownUrlTransform}
      components={mergeMarkdownComponents(components)}
    >
      {children}
    </ReactMarkdown>
  );
}

export default MarkdownRenderer;
