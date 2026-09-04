import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { parseRestrictedHtml } from './restrictedHtml';
import { PAPER_DIMENSIONS, type ExportFormatConfig } from '../types/exportFormat';
import { buildExportFormatCssVars } from '../utils/exportFormatCss';
import { formatOutlineNumber } from '../utils/outlineNumbering';
import { PageFooterChrome, PageHeaderChrome } from '../ui/HeaderFooterChrome';

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
  tableMetrics: Record<string, TableMetrics>;
}

/** 可按行分页的表格拆分素材，行取自 tbody 且不含跨行合并。 */
interface TableParts {
  openTag: string;
  captionHtml: string;
  theadHtml: string;
  rowsHtml: string[];
  trailingHtml: string;
}

/** 表格块的分段高度；overhead 覆盖外层内边距、表格边框与外边距。 */
interface TableMetrics {
  overhead: number;
  titleHeight: number;
  captionHeight: number;
  theadHeight: number;
  rowHeights: number[];
}

export interface RestrictedHtmlRendererProps {
  value: string;
  config: ExportFormatConfig;
}

/** 双栏只在横版纸张上生效，纵版保留用户已保存的开关值但按单栏排版。 */
export function resolveRestrictedHtmlColumns(config: ExportFormatConfig): 1 | 2 {
  return config.page.orientation === 'landscape' && config.page.two_column ? 2 : 1;
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

function escapeAttributeValue(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function directChildren(parent: Element, tag: string) {
  return Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === tag);
}

/**
 * 解析可按行拆分的表格；只有 tbody 至少两行且没有跨行合并时才允许拆分。
 * 单行表格（图文、三图预设）和含 rowspan 的表格返回 null，由调用方整块移动，避免切开图片或合并单元格。
 */
function parseTableParts(html: string): TableParts | null {
  if (!/^\s*<table[\s>]/i.test(html)) return null;
  const roots = Array.from(new DOMParser().parseFromString(html, 'text/html').body.children);
  const table = roots[0];
  if (!table || table.tagName.toLowerCase() !== 'table') return null;
  const tbody = directChildren(table, 'tbody')[0];
  if (!tbody) return null;
  const rows = directChildren(tbody, 'tr');
  if (rows.length < 2) return null;
  if (rows.some((row) => Array.from(row.children).some((cell) => Number(cell.getAttribute('rowspan') || 1) > 1))) return null;
  const attributes = Array.from(table.attributes)
    .map((attribute) => ` ${attribute.name}="${escapeAttributeValue(attribute.value)}"`)
    .join('');
  return {
    openTag: `<table${attributes}>`,
    captionHtml: directChildren(table, 'caption')[0]?.outerHTML || '',
    theadHtml: directChildren(table, 'thead')[0]?.outerHTML || '',
    // 标注整表内的原始行号奇偶，分段后隔行底色不随分片重新计数。
    rowsHtml: rows.map((row, index) => {
      if (index % 2 === 1) row.setAttribute('data-yb-row-even', '');
      return row.outerHTML;
    }),
    trailingHtml: roots.slice(1).map((node) => node.outerHTML).join(''),
  };
}

/** 生成一段表格分片；表名只出现在首段，表头行每段重复，表注跟随末段。 */
function buildTableChunkHtml(parts: TableParts, from: number, to: number, isFirstChunk: boolean, isLastChunk: boolean) {
  const caption = isFirstChunk ? parts.captionHtml : '';
  const trailing = isLastChunk ? parts.trailingHtml : '';
  return `${parts.openTag}${caption}${parts.theadHtml}<tbody data-yb-rows>${parts.rowsHtml.slice(from, to).join('')}</tbody></table>${trailing}`;
}

function escapeHtmlText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 按导出模板的编号设置，为标题块补上编号前缀。 */
function withHeadingNumber(html: string, level: number, outlineId: string, config: ExportFormatConfig) {
  const prefix = formatOutlineNumber(outlineId, config.headings[level - 1]);
  if (!prefix) return html;
  const separator = /[、，。；：）)】\]》〉]$/.test(prefix) ? '' : ' ';
  return html.replace(/^<h[1-6][^>]*>/i, (openTag) => `${openTag}${escapeHtmlText(prefix)}${separator}`);
}

/** 解析包含本地图片地址的可信展示模板，并按模板设置生成标题编号。 */
function parseSourceBlocks(value: string, config: ExportFormatConfig): SourceBlock[] {
  const counters = [0, 0, 0, 0, 0, 0];
  return parseRestrictedHtml(value, { allowImageSrc: true }).blocks
    .filter((block) => block.valid)
    .map((block) => {
      const headingMatch = /^h([1-6])$/.exec(block.kind);
      const headingLevel = headingMatch ? Number(headingMatch[1]) : undefined;
      let html = block.html;
      if (headingLevel) {
        counters[headingLevel - 1] += 1;
        for (let deeper = headingLevel; deeper < counters.length; deeper += 1) counters[deeper] = 0;
        html = withHeadingNumber(html, headingLevel, counters.slice(0, headingLevel).join('.'), config);
      }
      return {
        id: block.id || `restricted-html-block-${block.index}`,
        tag: block.kind,
        html,
        headingLevel,
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
}: RestrictedHtmlRendererProps) {
  const columns = resolveRestrictedHtmlColumns(config);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [metrics, setMetrics] = useState<PreviewMetrics>({ bodyHeight: 0, blockHeights: {}, tableMetrics: {} });
  const sourceBlocks = useMemo(() => parseSourceBlocks(value, config), [config, value]);
  const renderBlocks = useMemo(() => buildRenderBlocks(sourceBlocks, config, columns), [columns, config, sourceBlocks]);
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(config) as CSSProperties, [config]);
  const tableParts = useMemo(() => {
    const parts: Record<string, TableParts> = {};
    renderBlocks.forEach((block) => {
      const blockParts = parseTableParts(block.html);
      if (blockParts) parts[block.id] = blockParts;
    });
    return parts;
  }, [renderBlocks]);
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
      const tableMetrics: Record<string, TableMetrics> = {};
      const elementHeight = (element: Element | null | undefined) => (
        element ? Math.ceil(element.getBoundingClientRect().height) : 0
      );
      measureRoot.querySelectorAll<HTMLElement>('[data-content-preview-block-id]').forEach((block) => {
        const blockId = block.dataset.contentPreviewBlockId;
        if (!blockId) return;
        const blockHeight = Math.ceil(block.getBoundingClientRect().height);
        blockHeights[blockId] = blockHeight;

        // 文档顺序中的首个 table 即块的外层表格，图组单元格内的嵌套表格排在其后。
        const table = block.querySelector('table');
        const tbody = table ? directChildren(table, 'tbody')[0] : null;
        if (!table || !tbody) return;
        const rowHeights = directChildren(tbody, 'tr').map(elementHeight);
        const titleHeight = elementHeight(block.querySelector('.export-template-chapter-leaf-title'));
        const captionHeight = elementHeight(directChildren(table, 'caption')[0]);
        const theadHeight = elementHeight(directChildren(table, 'thead')[0]);
        const rowsHeight = rowHeights.reduce((total, height) => total + height, 0);
        tableMetrics[blockId] = {
          overhead: Math.max(0, blockHeight - titleHeight - captionHeight - theadHeight - rowsHeight),
          titleHeight,
          captionHeight,
          theadHeight,
          rowHeights,
        };
      });
      const nextMetrics = {
        bodyHeight: Math.floor(body.getBoundingClientRect().height),
        blockHeights,
        tableMetrics,
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
    // 段落与列表按像素连续切片；表格一律走行级分段，图片块整体移动，均不做像素切割。
    const createSlice = (block: RenderBlock, offset: number, height: number, index: number): RenderBlock => ({
      ...block,
      id: `${block.id}-slice-${index}`,
      startsNewPage: false,
      sliceOffset: offset,
      sliceHeight: height,
    });

    /** 取表格块的分段高度；缺测量数据时按整块高度均摊，保证首屏也能排版。 */
    const tableMetricsOf = (block: RenderBlock, parts: TableParts): TableMetrics => {
      const measured = metrics.tableMetrics[block.id];
      if (measured && measured.rowHeights.length === parts.rowsHtml.length) return measured;
      const blockHeight = Math.max(1, metrics.blockHeights[block.id] || block.fallbackHeight);
      const rowHeight = Math.max(1, Math.floor(blockHeight / parts.rowsHtml.length));
      return {
        overhead: 0,
        titleHeight: 0,
        captionHeight: 0,
        theadHeight: 0,
        rowHeights: parts.rowsHtml.map(() => rowHeight),
      };
    };

    /** 首段之外重复表头但不重复表名，因此两种分段的固定高度不同。 */
    const tableChunkFixedHeight = (tableSize: TableMetrics, isFirstChunk: boolean) => (
      tableSize.overhead + tableSize.theadHeight
      + (isFirstChunk ? tableSize.titleHeight + tableSize.captionHeight : 0)
    );

    /** 表格首段至少要容纳一行，用于判断标题能否与表格同页。 */
    const minimalTableHeight = (block: RenderBlock, parts: TableParts) => {
      const tableSize = tableMetricsOf(block, parts);
      return tableChunkFixedHeight(tableSize, true) + (tableSize.rowHeights[0] || 0);
    };

    interface TablePackContext {
      available: () => number;
      exhausted: () => boolean;
      place: (chunk: RenderBlock, height: number) => void;
      advance: () => void;
    }

    /**
     * 按 tbody 行边界把表格铺进当前区域，放不下的行继续到下一栏或下一页。
     * 行是最小单位，单元格内的图片不会被切开；整行超过一整页时单独成段并允许溢出。
     */
    const packTableRows = (block: RenderBlock, parts: TableParts, context: TablePackContext) => {
      const tableSize = tableMetricsOf(block, parts);
      const rowCount = parts.rowsHtml.length;
      let rowIndex = 0;
      let chunkIndex = 0;

      while (rowIndex < rowCount) {
        const isFirstChunk = chunkIndex === 0;
        const limit = context.available();
        let used = tableChunkFixedHeight(tableSize, isFirstChunk);
        let end = rowIndex;
        while (end < rowCount && used + (tableSize.rowHeights[end] || 0) <= limit) {
          used += tableSize.rowHeights[end] || 0;
          end += 1;
        }
        if (end === rowIndex) {
          if (!context.exhausted()) {
            context.advance();
            continue;
          }
          end = rowIndex + 1;
          used += tableSize.rowHeights[rowIndex] || 0;
        }

        context.place({
          ...block,
          id: `${block.id}-rows-${chunkIndex}`,
          html: buildTableChunkHtml(parts, rowIndex, end, isFirstChunk, end === rowCount),
          titleHtml: isFirstChunk ? block.titleHtml : undefined,
          startsNewPage: false,
          sectionStart: isFirstChunk ? block.sectionStart : false,
          sectionEnd: end === rowCount ? block.sectionEnd : false,
        }, used);

        rowIndex = end;
        chunkIndex += 1;
        if (rowIndex < rowCount) context.advance();
      }
    };

    renderBlocks.forEach((block, blockIndex) => {
      const blockHeight = Math.max(1, metrics.blockHeights[block.id] || block.fallbackHeight);
      const nextBlock = renderBlocks[blockIndex + 1];
      const keepWithNext = Boolean(block.headingLevel)
        && block.kind !== 'leaf'
        && nextBlock !== undefined
        && !nextBlock.headingLevel;
      const nextBlockParts = keepWithNext && nextBlock ? tableParts[nextBlock.id] : undefined;
      const nextBlockHeight = keepWithNext && nextBlock
        ? (nextBlockParts
          ? minimalTableHeight(nextBlock, nextBlockParts)
          : Math.max(1, metrics.blockHeights[nextBlock.id] || nextBlock.fallbackHeight))
        : 0;
      const blockTableParts = tableParts[block.id];
      // 表格永不像素切片：可按行拆分的走行级分段，其余（单行图组、含 rowspan）整块移动。
      const atomicTable = block.html.trimStart().startsWith('<table') && !blockTableParts;
      if (block.startsNewPage && hasPageContent()) startPage();

      if (block.fullWidth) {
        const requiredHeight = blockHeight + nextBlockHeight;
        if (
          hasColumnContent()
          || (hasPageContent() && requiredHeight <= bodyHeight && spanningHeight + requiredHeight > bodyHeight)
          || (hasPageContent() && spanningHeight + blockHeight > bodyHeight)
        ) startPage();
        if (block.unbreakable || atomicTable) {
          page.spanning.push(block);
          spanningHeight += blockHeight;
          return;
        }
        if (blockTableParts) {
          packTableRows(block, blockTableParts, {
            available: () => bodyHeight - spanningHeight,
            exhausted: () => !hasPageContent(),
            place: (chunk, height) => {
              page.spanning.push(chunk);
              spanningHeight += height;
            },
            advance: startPage,
          });
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
      // 可拆表格直接按行铺满当前栏，不走整块换栏，避免在正文中间留下大段空白。
      if (blockTableParts) {
        packTableRows(block, blockTableParts, {
          available: () => Math.max(1, bodyHeight - spanningHeight) - columnHeights[columnIndex],
          exhausted: () => page.columns[columnIndex].length === 0 && !hasPageContent(),
          place: (chunk, height) => {
            page.columns[columnIndex].push(chunk);
            columnHeights[columnIndex] += height;
          },
          advance: nextColumn,
        });
        return;
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
      if (block.unbreakable || atomicTable) {
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

  return (
    <div ref={stageRef} className="content-layout-preview-stage">
      <div className="export-template-preview-scale-box" style={{ width: `${pageWidthPx * previewScale}px` }}>
        <div className="export-template-preview-page-stack">
          {previewPages.map((page, pageIndex) => (
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
