import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { parseRestrictedHtml } from '../../../shared/bodyHtml/restrictedHtml';
import { PAPER_DIMENSIONS, type ExportFormatConfig } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { PageFooterChrome, PageHeaderChrome } from '../../export-format/HeaderFooterChrome';

const MM_TO_CSS_PX = 96 / 25.4;

type RenderBlockKind = 'raw' | 'heading' | 'content' | 'leaf';

interface SourceBlock {
  id: string;
  tag: string;
  html: string;
  headingLevel?: number;
  fallbackHeight: number;
}

interface RenderBlock {
  id: string;
  kind: RenderBlockKind;
  html: string;
  titleHtml?: string;
  headingLevel?: number;
  fullWidth: boolean;
  startsNewPage: boolean;
  fallbackHeight: number;
  sectionStart?: boolean;
  sectionEnd?: boolean;
  unbreakable?: boolean;
  sliceOffset?: number;
  sliceHeight?: number;
}

interface PreviewPage {
  spanning: RenderBlock[];
  columns: RenderBlock[][];
}

interface PreviewMetrics {
  bodyHeight: number;
  blockHeights: Record<string, number>;
}

export interface RestrictedHtmlRendererProps {
  value: string;
  config: ExportFormatConfig;
  columns?: 1 | 2;
  compact?: boolean;
}

function areMetricsEqual(left: PreviewMetrics, right: PreviewMetrics) {
  const leftKeys = Object.keys(left.blockHeights);
  const rightKeys = Object.keys(right.blockHeights);
  return left.bodyHeight === right.bodyHeight
    && leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left.blockHeights[key] === right.blockHeights[key]);
}

function fallbackHeight(tag: string) {
  if (tag === 'table' || tag === 'figure') return 320;
  if (/^h[1-6]$/.test(tag)) return 64;
  return 96;
}

/** 解析包含本地图片地址的可信展示模板。 */
function parseSourceBlocks(value: string): SourceBlock[] {
  return parseRestrictedHtml(value, { allowImageSrc: true }).blocks
    .filter((block) => block.valid)
    .map((block) => {
      const headingMatch = /^h([1-6])$/.exec(block.kind);
      return {
        id: block.id || `restricted-html-block-${block.index}`,
        tag: block.kind,
        html: block.html,
        headingLevel: headingMatch ? Number(headingMatch[1]) : undefined,
        fallbackHeight: fallbackHeight(block.kind),
      };
    });
}

function isLeafHeading(blocks: SourceBlock[], index: number) {
  const level = blocks[index].headingLevel;
  if (!level) return false;
  const nextHeading = blocks.slice(index + 1).find((block) => block.headingLevel);
  return !nextHeading || Number(nextHeading.headingLevel) <= level;
}

/** 将有效块转换为唯一的前端排版结构。 */
function buildRenderBlocks(sourceBlocks: SourceBlock[], config: ExportFormatConfig, columns: 1 | 2): RenderBlock[] {
  if (!config.heading_border.enabled) {
    return sourceBlocks.map((block) => ({
      id: block.id,
      kind: 'raw',
      html: block.html,
      headingLevel: block.headingLevel,
      fullWidth: columns === 2 && block.headingLevel === 1,
      startsNewPage: block.headingLevel === 1 && config.heading_level1_page_break_before,
      fallbackHeight: block.fallbackHeight,
      unbreakable: block.tag === 'figure',
    }));
  }

  const result: RenderBlock[] = [];
  let index = 0;
  while (index < sourceBlocks.length) {
    const block = sourceBlocks[index];
    if (block.headingLevel) {
      let contentEnd = index + 1;
      while (contentEnd < sourceBlocks.length && !sourceBlocks[contentEnd].headingLevel) contentEnd += 1;
      const content = sourceBlocks.slice(index + 1, contentEnd);
      const fullWidth = columns === 2 && block.headingLevel === 1;
      const startsNewPage = block.headingLevel === 1 && config.heading_level1_page_break_before;

      if (config.heading_border.min_heading_left_enabled && content.length && isLeafHeading(sourceBlocks, index)) {
        content.forEach((item, contentIndex) => {
          result.push({
            id: `${block.id}-leaf-${item.id}`,
            kind: 'leaf',
            html: item.html,
            titleHtml: contentIndex === 0 ? block.html : undefined,
            headingLevel: block.headingLevel,
            fullWidth,
            startsNewPage: contentIndex === 0 && startsNewPage,
            fallbackHeight: item.fallbackHeight + (contentIndex === 0 ? block.fallbackHeight : 0),
            sectionStart: contentIndex === 0,
            sectionEnd: contentIndex === content.length - 1,
            unbreakable: item.tag === 'figure',
          });
        });
        index = contentEnd;
        continue;
      }

      result.push({
        id: block.id,
        kind: 'heading',
        html: block.html,
        headingLevel: block.headingLevel,
        fullWidth,
        startsNewPage,
        fallbackHeight: block.fallbackHeight,
      });
      index += 1;
      continue;
    }

    let contentEnd = index + 1;
    while (contentEnd < sourceBlocks.length && !sourceBlocks[contentEnd].headingLevel) contentEnd += 1;
    const content = sourceBlocks.slice(index, contentEnd);
    content.forEach((item, contentIndex) => {
      result.push({
        id: `${item.id}-content`,
        kind: 'content',
        html: item.html,
        fullWidth: false,
        startsNewPage: false,
        fallbackHeight: item.fallbackHeight,
        sectionStart: contentIndex === 0,
        sectionEnd: contentIndex === content.length - 1,
        unbreakable: item.tag === 'figure',
      });
    });
    index = contentEnd;
  }
  return result;
}

/** 按导出模板样式，将受限 HTML 渲染为分页的真实前端 DOM。 */
export function RestrictedHtmlRenderer({
  value,
  config,
  columns = 1,
  compact = false,
}: RestrictedHtmlRendererProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [metrics, setMetrics] = useState<PreviewMetrics>({ bodyHeight: 0, blockHeights: {} });
  const sourceBlocks = useMemo(() => parseSourceBlocks(value), [value]);
  const renderBlocks = useMemo(() => buildRenderBlocks(sourceBlocks, config, columns), [columns, config, sourceBlocks]);
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(config) as CSSProperties, [config]);
  const dimensions = PAPER_DIMENSIONS[config.page.paper_size] || PAPER_DIMENSIONS.a4;
  const pageWidthMm = config.page.orientation === 'landscape' ? dimensions.height : dimensions.width;
  const pageHeightMm = config.page.orientation === 'landscape' ? dimensions.width : dimensions.height;
  const pageWidthPx = pageWidthMm * MM_TO_CSS_PX;
  const pageHeightPx = pageHeightMm * MM_TO_CSS_PX;
  const previewScale = stageWidth ? Math.min(1, stageWidth / pageWidthPx) : 1;

  useEffect(() => {
    if (!stageRef.current) return;
    const stage = stageRef.current;
    const updateWidth = () => setStageWidth(Math.max(0, stage.clientWidth));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const measureRoot = measureRef.current;
    if (!measureRoot) return;

    let frameId = 0;
    const measure = () => {
      const body = measureRoot.querySelector<HTMLElement>('[data-content-preview-measure-body="true"]');
      if (!body) return;
      const blockHeights: Record<string, number> = {};
      measureRoot.querySelectorAll<HTMLElement>('[data-content-preview-block-id]').forEach((block) => {
        const blockId = block.dataset.contentPreviewBlockId;
        if (blockId) blockHeights[blockId] = Math.ceil(block.getBoundingClientRect().height);
      });
      const nextMetrics = {
        bodyHeight: Math.floor(body.getBoundingClientRect().height),
        blockHeights,
      };
      setMetrics((previous) => areMetricsEqual(previous, nextMetrics) ? previous : nextMetrics);
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(measureRoot);
    measureRoot.querySelectorAll<HTMLElement>('[data-content-preview-block-id]').forEach((block) => observer.observe(block));
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [pageHeightPx, pageWidthPx, previewStyle, renderBlocks]);

  const previewPages = useMemo<PreviewPage[]>(() => {
    const bodyHeight = metrics.bodyHeight || Math.max(240, Math.round(pageHeightPx * 0.68));
    const createPage = (): PreviewPage => ({
      spanning: [],
      columns: Array.from({ length: columns }, () => []),
    });
    const pages = [createPage()];
    let page = pages[0];
    let columnIndex = 0;
    let columnHeights = Array.from({ length: columns }, () => 0);
    let spanningHeight = 0;

    const hasPageContent = () => page.spanning.length > 0 || page.columns.some((column) => column.length > 0);
    const hasColumnContent = () => page.columns.some((column) => column.length > 0);
    const startPage = () => {
      page = createPage();
      pages.push(page);
      columnIndex = 0;
      columnHeights = Array.from({ length: columns }, () => 0);
      spanningHeight = 0;
    };
    const nextColumn = () => {
      columnIndex += 1;
      if (columnIndex >= columns) startPage();
    };
    // ponytail: 预览按像素连续切片；需要避开表格行边界时再扩展为语义拆分。
    const createSlice = (block: RenderBlock, offset: number, height: number, index: number): RenderBlock => ({
      ...block,
      id: `${block.id}-slice-${index}`,
      startsNewPage: false,
      sliceOffset: offset,
      sliceHeight: height,
    });

    renderBlocks.forEach((block, blockIndex) => {
      const blockHeight = Math.max(1, metrics.blockHeights[block.id] || block.fallbackHeight);
      const nextBlock = renderBlocks[blockIndex + 1];
      const keepWithNext = Boolean(block.headingLevel)
        && block.kind !== 'leaf'
        && nextBlock !== undefined
        && !nextBlock.headingLevel;
      const nextBlockHeight = keepWithNext && nextBlock
        ? Math.max(1, metrics.blockHeights[nextBlock.id] || nextBlock.fallbackHeight)
        : 0;
      if (block.startsNewPage && hasPageContent()) startPage();

      if (block.fullWidth) {
        const requiredHeight = blockHeight + nextBlockHeight;
        if (
          hasColumnContent()
          || (hasPageContent() && requiredHeight <= bodyHeight && spanningHeight + requiredHeight > bodyHeight)
          || (hasPageContent() && spanningHeight + blockHeight > bodyHeight)
        ) startPage();
        if (block.unbreakable) {
          page.spanning.push(block);
          spanningHeight += blockHeight;
          return;
        }
        let offset = 0;
        let sliceIndex = 0;
        while (offset < blockHeight) {
          const sliceHeight = Math.min(blockHeight - offset, bodyHeight - spanningHeight);
          page.spanning.push(sliceHeight === blockHeight ? block : createSlice(block, offset, sliceHeight, sliceIndex));
          spanningHeight += sliceHeight;
          offset += sliceHeight;
          sliceIndex += 1;
          if (offset < blockHeight) startPage();
        }
        return;
      }

      let columnHeight = Math.max(1, bodyHeight - spanningHeight);
      const requiredHeight = blockHeight + nextBlockHeight;
      const remainingHeight = columnHeight - columnHeights[columnIndex];
      if (keepWithNext && requiredHeight <= columnHeight && requiredHeight > remainingHeight) {
        if (page.columns[columnIndex].length > 0) nextColumn();
        else if (hasPageContent()) startPage();
        columnHeight = Math.max(1, bodyHeight - spanningHeight);
      }
      if (spanningHeight >= bodyHeight || (blockHeight <= bodyHeight && blockHeight > columnHeight)) {
        startPage();
        columnHeight = bodyHeight;
      }
      if (page.columns[columnIndex].length > 0 && columnHeights[columnIndex] + blockHeight > columnHeight) {
        nextColumn();
        columnHeight = Math.max(1, bodyHeight - spanningHeight);
      }
      if (blockHeight <= columnHeight - columnHeights[columnIndex]) {
        page.columns[columnIndex].push(block);
        columnHeights[columnIndex] += blockHeight;
        return;
      }
      if (block.unbreakable) {
        page.columns[columnIndex].push(block);
        columnHeights[columnIndex] += blockHeight;
        return;
      }

      let offset = 0;
      let sliceIndex = 0;
      while (offset < blockHeight) {
        const availableHeight = columnHeight - columnHeights[columnIndex];
        if (availableHeight <= 0) {
          nextColumn();
          columnHeight = Math.max(1, bodyHeight - spanningHeight);
          continue;
        }
        const sliceHeight = Math.min(blockHeight - offset, availableHeight);
        page.columns[columnIndex].push(createSlice(block, offset, sliceHeight, sliceIndex));
        columnHeights[columnIndex] += sliceHeight;
        offset += sliceHeight;
        sliceIndex += 1;
        if (offset < blockHeight) {
          nextColumn();
          columnHeight = Math.max(1, bodyHeight - spanningHeight);
        }
      }
    });

    return pages.filter((item) => item.spanning.length > 0 || item.columns.some((column) => column.length > 0));
  }, [columns, metrics.blockHeights, metrics.bodyHeight, pageHeightPx, renderBlocks]);

  const renderBlockContent = (block: RenderBlock) => {
    const sectionClasses = `${block.sectionStart ? ' is-section-start' : ''}${block.sectionEnd ? ' is-section-end' : ''}`;
    if (block.kind === 'heading') {
      return (
        <div
          className={`export-template-chapter-heading-row is-level-${block.headingLevel}`}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      );
    }
    if (block.kind === 'content') {
      return <div className={`export-template-chapter-content-row${sectionClasses}`} dangerouslySetInnerHTML={{ __html: block.html }} />;
    }
    if (block.kind === 'leaf') {
      return (
        <div className={`export-template-chapter-leaf-row is-level-${block.headingLevel}${sectionClasses}`}>
          <div className="export-template-chapter-leaf-title" dangerouslySetInnerHTML={{ __html: block.titleHtml || '' }} />
          <div className="export-template-chapter-leaf-content" dangerouslySetInnerHTML={{ __html: block.html }} />
        </div>
      );
    }
    return null;
  };

  const renderBlock = (block: RenderBlock, measure = false) => {
    const commonProps = {
      key: block.id,
      className: `export-template-preview-block content-layout-preview-block${block.fullWidth ? ' is-spanning' : ' is-column'}${block.sliceHeight ? ' is-sliced' : ''}`,
      'data-content-preview-block-id': measure ? block.id : undefined,
      'aria-hidden': block.sliceOffset ? true : undefined,
      style: block.sliceHeight ? {
        height: `${block.sliceHeight}px`,
        '--content-preview-slice-offset': `${block.sliceOffset || 0}px`,
      } as CSSProperties : undefined,
    };
    if (block.kind === 'raw') {
      return <div {...commonProps} dangerouslySetInnerHTML={{ __html: block.html }} />;
    }
    return <div {...commonProps}>{renderBlockContent(block)}</div>;
  };

  const renderPageContent = (page: PreviewPage, measure = false) => {
    const content = (
      <div
        className={`restricted-html-preview content-template-restricted-preview content-layout-preview-page-content${columns === 2 ? ' is-two-column' : ''}`}
        data-content-preview-measure-body={measure ? 'true' : undefined}
      >
        {measure ? (
          <div className="restricted-html-document content-layout-preview-measure-flow">
            {renderBlocks.map((block) => renderBlock(block, true))}
          </div>
        ) : (
          <div className="restricted-html-document">
            {page.spanning.map((block) => renderBlock(block))}
            {page.columns.some((column) => column.length > 0) && (
              <div className={`content-layout-preview-columns${columns === 2 ? ' is-two-column' : ''}`}>
                {page.columns.map((column, index) => (
                  <div className="content-layout-preview-column" key={index}>
                    {column.map((block) => renderBlock(block))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
    return config.heading_border.enabled
      ? <section className="export-template-chapter-frame is-fragment content-layout-preview-frame">{content}</section>
      : content;
  };

  const paperStyle: CSSProperties = {
    ...previewStyle,
    width: `${pageWidthPx}px`,
    height: `${pageHeightPx}px`,
    minHeight: 0,
    transform: `scale(${previewScale})`,
  };
  const pageShellStyle: CSSProperties = {
    width: `${pageWidthPx * previewScale}px`,
    height: `${pageHeightPx * previewScale}px`,
  };
  const visiblePages = compact ? previewPages.slice(0, 1) : previewPages;

  return (
    <div ref={stageRef} className={`content-layout-preview-stage${compact ? ' is-compact' : ''}`}>
      <div className="export-template-preview-scale-box" style={{ width: `${pageWidthPx * previewScale}px` }}>
        <div className="export-template-preview-page-stack">
          {visiblePages.map((page, pageIndex) => (
            <div className="export-template-preview-page-shell" style={pageShellStyle} key={pageIndex}>
              <div className="content-layout-preview-paper export-format-paper export-format-preview-content" style={paperStyle}>
                <PageHeaderChrome config={config} pageIndex={pageIndex} />
                <div className="export-format-paper-body">
                  {renderBlocks.length ? renderPageContent(page) : <p className="restricted-html-empty">暂无正文内容</p>}
                </div>
                <PageFooterChrome config={config} pageIndex={pageIndex} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="content-layout-preview-measure" ref={measureRef} aria-hidden="true">
        <div
          className="content-layout-preview-paper export-format-paper export-format-preview-content"
          style={{ ...paperStyle, width: `${pageWidthPx}px`, height: `${pageHeightPx}px`, minHeight: 0, transform: 'none' }}
        >
          <PageHeaderChrome config={config} pageIndex={0} />
          <div className="export-format-paper-body">
            {renderPageContent({ spanning: [], columns: Array.from({ length: columns }, () => []) }, true)}
          </div>
          <PageFooterChrome config={config} pageIndex={0} />
        </div>
      </div>
    </div>
  );
}
