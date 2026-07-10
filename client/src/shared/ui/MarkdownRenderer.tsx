import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { renderMarkdownHtml } from '../markdown/renderMarkdownHtml';

type MarkdownImageMode = 'default' | 'preview' | 'lazy';
type MarkdownLinkMode = 'default' | 'external' | 'text';

interface MarkdownRendererProps {
  children: string;
  allowRawHtml?: boolean;
  enableGfm?: boolean;
  imageMode?: MarkdownImageMode;
  imageClassName?: string;
  linkMode?: MarkdownLinkMode;
  linkTextClassName?: string;
  renderMermaid?: boolean;
  previewImageTitle?: string;
  onPreviewImage?: (src: string, alt: string) => void;
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

// 判断 Mermaid 代码是否属于当前支持的 flowchart 语法。
function isSupportedMermaidSyntax(code: string) {
  return /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/i.test(String(code || '').trim());
}

function MermaidPreview({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    const trimmedCode = String(code || '').trim();

    if (!trimmedCode) {
      setStatus('error');
      setErrorMessage('Mermaid 图代码为空');
      if (container) container.innerHTML = '';
      return undefined;
    }
    if (!isSupportedMermaidSyntax(trimmedCode)) {
      setStatus('error');
      setErrorMessage('仅支持流程图、层级图和职责关系图，且必须使用 flowchart TD/TB/LR/RL/BT 语法');
      if (container) container.innerHTML = '';
      return undefined;
    }

    setStatus('loading');
    setErrorMessage('');
    if (container) container.innerHTML = '';

    import('mermaid')
      .then((module) => {
        const mermaid = module.default;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
        return mermaid.render(`mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`, trimmedCode);
      })
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setStatus('success');
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Mermaid 图渲染失败');
      });

    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
    };
  }, [code]);

  return (
    <figure className={`mermaid-preview-card is-${status}`}>
      {status === 'loading' && <span>正在渲染 Mermaid 图...</span>}
      {status === 'error' && (
        <div className="mermaid-preview-error">
          <strong>Mermaid 图渲染失败</strong>
          <small>{errorMessage}</small>
          <pre>{code}</pre>
        </div>
      )}
      <div ref={containerRef} className="mermaid-preview-canvas" aria-hidden={status !== 'success'} />
    </figure>
  );
}

function getElementClassName(element: Element) {
  return element.getAttribute('class') || undefined;
}

function childrenFromDom(nodes: ChildNode[], renderNode: (node: ChildNode, index: number) => ReactNode) {
  return nodes.map((node, index) => renderNode(node, index));
}

function MarkdownRenderer({
  children,
  allowRawHtml = true,
  enableGfm = true,
  imageMode = 'default',
  imageClassName,
  linkMode = 'external',
  linkTextClassName,
  renderMermaid = false,
  previewImageTitle = '点击放大查看',
  onPreviewImage,
}: MarkdownRendererProps) {
  const html = useMemo(() => renderMarkdownHtml(children, { allowRawHtml, enableGfm }), [allowRawHtml, children, enableGfm]);

  const content = useMemo(() => {
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = document.body.firstElementChild;
    const renderNode = (node: ChildNode, index: number): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      const childNodes = Array.from(element.childNodes);
      const renderedChildren = childrenFromDom(childNodes, renderNode);
      const className = getElementClassName(element);
      const key = `${tag}-${index}`;

      if (tag === 'br') return <br key={key} />;
      if (tag === 'hr') return <hr key={key} />;
      if (tag === 'a') {
        const href = element.getAttribute('href') || '';
        const externalUrl = normalizeExternalUrl(href);
        if (linkMode === 'text') {
          return <span key={key} className={linkTextClassName}>{renderedChildren}</span>;
        }

        const isExternal = linkMode === 'external' && isExternalHttpUrl(externalUrl);
        return (
          <a
            key={key}
            className={className}
            href={isExternal ? externalUrl : href}
            rel={isExternal ? 'noreferrer' : undefined}
            target={isExternal ? '_blank' : undefined}
            onClick={(event) => {
              if (!isExternal) return;
              event.preventDefault();
              event.stopPropagation();
              openExternal(externalUrl);
            }}
          >
            {renderedChildren}
          </a>
        );
      }

      if (tag === 'img') {
        const src = element.getAttribute('src') || '';
        const alt = element.getAttribute('alt') || '正文图片';
        const previewEnabled = imageMode === 'preview' && Boolean(src) && Boolean(onPreviewImage);
        const handlePreview = () => {
          if (previewEnabled) onPreviewImage?.(src, alt);
        };
        const handleKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
          if (!previewEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          handlePreview();
        };

        return (
          <img
            key={key}
            src={src}
            alt={alt}
            className={imageClassName || className}
            loading={imageMode === 'lazy' ? 'lazy' : undefined}
            decoding={imageMode === 'lazy' ? 'async' : undefined}
            role={previewEnabled ? 'button' : undefined}
            tabIndex={previewEnabled ? 0 : undefined}
            title={previewEnabled ? previewImageTitle : undefined}
            onClick={previewEnabled ? handlePreview : undefined}
            onKeyDown={previewEnabled ? handleKeyDown : undefined}
          />
        );
      }

      if (tag === 'pre' && renderMermaid) {
        const code = element.querySelector('code');
        if (code && /\blanguage-mermaid\b/i.test(code.getAttribute('class') || '')) {
          return <MermaidPreview key={key} code={(code.textContent || '').replace(/\n$/, '')} />;
        }
      }

      if (tag === 'input' && (element.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        return (
          <input
            key={key}
            id={element.getAttribute('id') || undefined}
            type="checkbox"
            checked={element.hasAttribute('checked')}
            disabled
            readOnly
            className={className}
          />
        );
      }

      const props = { key, className };
      if (tag === 'p') {
        const isFigureCaption = /^图[:：]/.test((element.textContent || '').trim());
        return <p {...props} className={[className, isFigureCaption ? 'markdown-figure-caption' : ''].filter(Boolean).join(' ') || undefined}>{renderedChildren}</p>;
      }

      if (tag === 'h1') return <h1 {...props}>{renderedChildren}</h1>;
      if (tag === 'h2') return <h2 {...props}>{renderedChildren}</h2>;
      if (tag === 'h3') return <h3 {...props}>{renderedChildren}</h3>;
      if (tag === 'h4') return <h4 {...props}>{renderedChildren}</h4>;
      if (tag === 'h5') return <h5 {...props}>{renderedChildren}</h5>;
      if (tag === 'h6') return <h6 {...props}>{renderedChildren}</h6>;
      if (tag === 'strong') return <strong {...props}>{renderedChildren}</strong>;
      if (tag === 'b') return <b {...props}>{renderedChildren}</b>;
      if (tag === 'em') return <em {...props}>{renderedChildren}</em>;
      if (tag === 'i') return <i {...props}>{renderedChildren}</i>;
      if (tag === 'del') return <del {...props}>{renderedChildren}</del>;
      if (tag === 's') return <s {...props}>{renderedChildren}</s>;
      if (tag === 'ul') return <ul {...props}>{renderedChildren}</ul>;
      if (tag === 'ol') return <ol {...props}>{renderedChildren}</ol>;
      if (tag === 'li') return <li {...props}>{renderedChildren}</li>;
      if (tag === 'table') {
        return (
          <div key={key} className="markdown-table-scroll">
            <table className={className}>{renderedChildren}</table>
          </div>
        );
      }
      if (tag === 'thead') return <thead {...props}>{renderedChildren}</thead>;
      if (tag === 'tbody') return <tbody {...props}>{renderedChildren}</tbody>;
      if (tag === 'tr') return <tr {...props}>{renderedChildren}</tr>;
      if (tag === 'th') return <th {...props}>{renderedChildren}</th>;
      if (tag === 'td') return <td {...props}>{renderedChildren}</td>;
      if (tag === 'blockquote') return <blockquote {...props}>{renderedChildren}</blockquote>;
      if (tag === 'pre') return <pre {...props}>{renderedChildren}</pre>;
      if (tag === 'code') return <code {...props}>{renderedChildren}</code>;
      if (tag === 'mark') return <mark {...props}>{renderedChildren}</mark>;
      if (tag === 'small') return <small {...props}>{renderedChildren}</small>;
      if (tag === 'sub') return <sub {...props}>{renderedChildren}</sub>;
      if (tag === 'sup') return <sup {...props}>{renderedChildren}</sup>;
      if (tag === 'label') return <label {...props} htmlFor={element.getAttribute('for') || undefined}>{renderedChildren}</label>;
      if (tag === 'span') return <span {...props}>{renderedChildren}</span>;
      if (tag === 'div') return <div {...props}>{renderedChildren}</div>;
      if (tag === 'section') return <section {...props}>{renderedChildren}</section>;
      if (tag === 'article') return <article {...props}>{renderedChildren}</article>;

      return <span key={key}>{renderedChildren}</span>;
    };

    return Array.from(root?.childNodes || []).map((node, index) => renderNode(node, index));
  }, [enableGfm, html, imageClassName, imageMode, linkMode, linkTextClassName, onPreviewImage, previewImageTitle, renderMermaid]);

  return <>{content}</>;
}

export default MarkdownRenderer;
