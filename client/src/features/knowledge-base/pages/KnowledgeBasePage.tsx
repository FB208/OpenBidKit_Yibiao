import { Profiler, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Components } from 'react-markdown';
import { isLibreOfficeRequiredMessage, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeDocument, KnowledgeItem } from '../types';

declare global {
  interface Window {
    __knowledgeRenderDebugLogs?: Array<Record<string, unknown>>;
  }
}

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const emptyDocuments: KnowledgeDocument[] = [];
const documentRenderBatchSize = 80;
const knowledgeItemSourceComponents: Components = {
  a({ children }) {
    return <span className="knowledge-item-link-text">{children}</span>;
  },
  img({ node: _node, ...props }) {
    return <img {...props} loading="lazy" decoding="async" />;
  },
};

const statusLabels: Record<KnowledgeDocument['status'], string> = {
  pending: '等待处理',
  copying: '复制文件',
  converting: '转换 Markdown',
  extracting: '提取条目',
  ready_for_matching: '待匹配',
  matching: '匹配段落',
  recovering: '补漏中',
  analyzing: 'AI 整理中',
  saving: '保存结果',
  success: '完成',
  error: '失败',
};

type RenderDebugKind = 'item-source' | 'document-markdown' | 'document-items';

interface RenderDebugTrace {
  id: string;
  kind: RenderDebugKind;
  startedAt: number;
  documentId: string;
  documentName: string;
  itemId?: string;
  itemTitle?: string;
  contentLength: number;
  contentMetrics: Record<string, number>;
  longTasks: Array<Record<string, number | string>>;
  longTaskObserver?: PerformanceObserver;
  finished?: boolean;
}

let renderDebugSeq = 0;

const contentMetricKeys = [
  'chars',
  'lines',
  'htmlTags',
  'htmlTables',
  'htmlRows',
  'htmlCells',
  'markdownImages',
  'htmlImages',
  'importedAssets',
  'bareUrls',
  'markdownLinks',
] as const;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function countMatches(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function collectContentMetrics(content: string) {
  const text = String(content || '');
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    htmlTags: countMatches(text, /<[^>]+>/g),
    htmlTables: countMatches(text, /<table\b/gi),
    htmlRows: countMatches(text, /<tr\b/gi),
    htmlCells: countMatches(text, /<(?:td|th)\b/gi),
    markdownImages: countMatches(text, /!\[[^\]]*\]\([^)]*\)/g),
    htmlImages: countMatches(text, /<img\b/gi),
    importedAssets: countMatches(text, /yibiao-asset:\/\/imported-images/gi),
    bareUrls: countMatches(text, /\b(?:https?:\/\/|www\.)[^\s)）]+/gi),
    markdownLinks: countMatches(text, /\[[^\]]{0,200}\]\([^)]{1,500}\)/g),
  };
}

function collectItemsContentMetrics(items: KnowledgeItem[]) {
  const totals: Record<string, number> = Object.fromEntries(contentMetricKeys.map((key) => [key, 0]));
  let totalTitleChars = 0;
  let totalResumeChars = 0;
  let maxItemContentLength = 0;
  let maxItemId = '';
  let maxItemTitle = '';
  let itemsWithHtml = 0;
  let itemsWithTables = 0;
  let itemsWithImages = 0;
  let itemsWithImportedAssets = 0;
  let itemsWithBareUrls = 0;

  items.forEach((item) => {
    const content = String(item.content || '');
    const metrics = collectContentMetrics(content);
    contentMetricKeys.forEach((key) => {
      totals[key] += metrics[key];
    });
    totalTitleChars += String(item.title || '').length;
    totalResumeChars += String(item.resume || '').length;
    if (metrics.chars > maxItemContentLength) {
      maxItemContentLength = metrics.chars;
      maxItemId = item.id;
      maxItemTitle = item.title;
    }
    if (metrics.htmlTags) itemsWithHtml += 1;
    if (metrics.htmlTables) itemsWithTables += 1;
    if (metrics.markdownImages || metrics.htmlImages) itemsWithImages += 1;
    if (metrics.importedAssets) itemsWithImportedAssets += 1;
    if (metrics.bareUrls) itemsWithBareUrls += 1;
  });

  const metrics: Record<string, number> = {
    ...totals,
    itemCount: items.length,
    totalTitleChars,
    totalResumeChars,
    maxItemContentLength,
    itemsWithHtml,
    itemsWithTables,
    itemsWithImages,
    itemsWithImportedAssets,
    itemsWithBareUrls,
  };

  return {
    metrics,
    maxItemId,
    maxItemTitle,
  };
}

function collectDomMetrics(element: HTMLElement | null) {
  if (!element) return {};
  return {
    domNodes: element.querySelectorAll('*').length,
    tables: element.querySelectorAll('table').length,
    rows: element.querySelectorAll('tr').length,
    cells: element.querySelectorAll('td, th').length,
    images: element.querySelectorAll('img').length,
    links: element.querySelectorAll('a').length,
    textChars: element.textContent?.length || 0,
    htmlChars: element.innerHTML.length,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function logRenderDebug(trace: RenderDebugTrace | null | undefined, event: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  const entry = {
    traceId: trace.id,
    kind: trace.kind,
    event,
    elapsedMs: roundMs(nowMs() - trace.startedAt),
    documentId: trace.documentId,
    itemId: trace.itemId,
    ...payload,
  };
  if (typeof window !== 'undefined') {
    window.__knowledgeRenderDebugLogs = window.__knowledgeRenderDebugLogs || [];
    window.__knowledgeRenderDebugLogs.push(entry);
  }
  console.info('[knowledge-render-debug]', entry);
}

function startLongTaskObserver(trace: RenderDebugTrace) {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const task = {
          startMs: roundMs(entry.startTime - trace.startedAt),
          durationMs: roundMs(entry.duration),
          name: entry.name || 'longtask',
        };
        trace.longTasks.push(task);
        logRenderDebug(trace, 'longtask', task);
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    trace.longTaskObserver = observer;
  } catch (error) {
    logRenderDebug(trace, 'longtask:observer-unavailable', { message: error instanceof Error ? error.message : String(error) });
  }
}

function createRenderDebugTrace(kind: RenderDebugKind, document: KnowledgeDocument, content: string, item?: KnowledgeItem) {
  const trace: RenderDebugTrace = {
    id: `${kind}-${Date.now()}-${++renderDebugSeq}`,
    kind,
    startedAt: nowMs(),
    documentId: document.id,
    documentName: document.file_name,
    itemId: item?.id,
    itemTitle: item?.title,
    contentLength: String(content || '').length,
    contentMetrics: collectContentMetrics(content),
    longTasks: [],
  };
  startLongTaskObserver(trace);
  logRenderDebug(trace, 'trace:start', {
    documentName: trace.documentName,
    itemTitle: trace.itemTitle,
    contentLength: trace.contentLength,
    metrics: trace.contentMetrics,
  });
  console.table([{ traceId: trace.id, ...trace.contentMetrics }]);
  return trace;
}

function updateTraceContentMetrics(trace: RenderDebugTrace | null | undefined, content: string) {
  if (!trace || trace.finished) return;
  const metrics = collectContentMetrics(content);
  trace.contentLength = String(content || '').length;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'content:metrics', {
    contentLength: trace.contentLength,
    metrics,
  });
}

function updateTraceItemsMetrics(trace: RenderDebugTrace | null | undefined, items: KnowledgeItem[]) {
  if (!trace || trace.finished) return;
  const { metrics, maxItemId, maxItemTitle } = collectItemsContentMetrics(items);
  trace.contentLength = metrics.chars;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'items:metrics', {
    itemCount: items.length,
    contentLength: trace.contentLength,
    metrics,
    maxItemId,
    maxItemTitle,
  });
}

function finishRenderDebugTrace(trace: RenderDebugTrace | null | undefined, reason: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  logRenderDebug(trace, 'trace:finish', {
    reason,
    totalMs: roundMs(nowMs() - trace.startedAt),
    longTaskCount: trace.longTasks.length,
    ...payload,
  });
  if (trace.longTasks.length) {
    console.table(trace.longTasks.map((task) => ({ traceId: trace.id, ...task })));
  }
  trace.longTaskObserver?.disconnect();
  trace.finished = true;
}

function logProfilerRender(
  trace: RenderDebugTrace | null | undefined,
  profilerId: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  logRenderDebug(trace, 'react-profiler', {
    profilerId,
    phase,
    actualDurationMs: roundMs(actualDuration),
    baseDurationMs: roundMs(baseDuration),
    profilerStartMs: roundMs(startTime - (trace?.startedAt || 0)),
    profilerCommitMs: roundMs(commitTime - (trace?.startedAt || 0)),
  });
}

type KnowledgeViewer = {
  document: KnowledgeDocument;
  mode: 'analysis' | 'items' | 'markdown';
};

function KnowledgeBasePage() {
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<KnowledgeViewer | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerTrace, setViewerTrace] = useState<RenderDebugTrace | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [itemsPreview, setItemsPreview] = useState<KnowledgeItem[]>([]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<KnowledgeAnalysisSnapshot | null>(null);
  const [batchSize, setBatchSize] = useState(20);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const viewerRequestIdRef = useRef(0);
  const viewerTraceRef = useRef<RenderDebugTrace | null>(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];
  const documentsByFolder = useMemo(() => {
    const grouped = new Map<string, KnowledgeDocument[]>();
    index.documents.forEach((document) => {
      const folderDocuments = grouped.get(document.folder_id);
      if (folderDocuments) {
        folderDocuments.push(document);
        return;
      }
      grouped.set(document.folder_id, [document]);
    });
    return grouped;
  }, [index.documents]);
  const documents = activeFolder ? documentsByFolder.get(activeFolder.id) || emptyDocuments : emptyDocuments;
  const visibleDocuments = documents.slice(0, Math.min(visibleDocumentCount, documents.length));

  useEffect(() => {
    void loadInitialData();
    window.addEventListener('focus', loadDeveloperMode);
    document.addEventListener('visibilitychange', loadDeveloperMode);
    const unsubscribe = window.yibiao?.knowledgeBase.onEvent(({ document }) => {
      const parseMessage = document.error || document.message;
      if (document.status === 'error'
        && isLibreOfficeRequiredMessage(parseMessage)
        && !documentParseNoticeIdsRef.current.has(document.id)) {
        documentParseNoticeIdsRef.current.add(document.id);
        showDocumentParseNotice(parseMessage);
      }
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.some((item) => item.id === document.id)
          ? prev.documents.map((item) => (item.id === document.id ? document : item))
          : [...prev.documents, document],
      }));
      setViewer((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
      setAnalysisSnapshot((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
    });
    return () => {
      window.removeEventListener('focus', loadDeveloperMode);
      document.removeEventListener('visibilitychange', loadDeveloperMode);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setVisibleDocumentCount(documentRenderBatchSize);
  }, [activeFolder?.id, documents.length]);

  useEffect(() => {
    if (visibleDocumentCount >= documents.length) return undefined;
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setVisibleDocumentCount((count) => Math.min(count + documentRenderBatchSize, documents.length));
      });
    }, 24);
    return () => window.clearTimeout(timeoutId);
  }, [documents.length, visibleDocumentCount]);

  useEffect(() => {
    if (developerMode) return;
    const pendingDocuments = index.documents.filter((document) => document.status === 'ready_for_matching' && !autoMatchingIdsRef.current.has(document.id));
    pendingDocuments.forEach((document) => {
      autoMatchingIdsRef.current.add(document.id);
      void startMatching(document, 20, { silent: true });
    });
  }, [developerMode, index.documents]);

  useEffect(() => {
    if (!developerMode && viewer?.mode === 'analysis') {
      viewerRequestIdRef.current += 1;
      setViewer(null);
      setViewerLoading(false);
      setAnalysisSnapshot(null);
    }
  }, [developerMode, viewer?.mode]);

  useEffect(() => {
    if ((!activeFolderId || !index.folders.some((folder) => folder.id === activeFolderId)) && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);

  useEffect(() => {
    if (viewer?.mode === 'analysis') {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);

  const loadInitialData = async () => {
    try {
      setListLoading(true);
      const [config, data] = await Promise.all([
        window.yibiao?.config.load(),
        window.yibiao?.knowledgeBase.list(),
      ]);
      setDeveloperMode(Boolean(config?.developer_mode));
      if (data) {
        setIndex(data);
        setActiveFolderId((currentId) => (
          data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || ''
        ));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setListLoading(false);
    }
  };

  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn('读取开发者模式失败', error);
      setDeveloperMode(false);
    }
  };

  const loadAnalysis = async (documentId: string, options?: { silent?: boolean }) => {
    try {
      const data = await window.yibiao?.knowledgeBase.readAnalysis(documentId);
      if (data) setAnalysisSnapshot(data);
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '读取分析结果失败', 'error');
      }
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast('请输入文件夹名称', 'info');
      return;
    }

    try {
      setCreatingFolder(true);
      const folder = await window.yibiao?.knowledgeBase.createFolder(name.trim());
      if (!folder) return;
      setIndex((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
      setActiveFolderId(folder.id);
      setNewFolderName('');
      setShowCreateFolder(false);
      showToast('文件夹已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const uploadDocuments = async () => {
    if (!activeFolder) {
      showToast('请先创建文件夹', 'info');
      return;
    }

    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.uploadDocuments(activeFolder.id);
      if (!result?.success) {
        const message = result?.message || '未选择文档';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'info');
        return;
      }
      if (result.documents?.length) {
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, result.documents || []) }));
      }
      showToast(result.message, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传文档失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt('请输入新的文件夹名称', currentName)?.trim();
    if (!name || name === currentName) return;

    try {
      const folder = await window.yibiao?.knowledgeBase.renameFolder(folderId, name);
      if (!folder) return;
      setIndex((prev) => ({
        ...prev,
        folders: prev.folders.map((item) => (item.id === folder.id ? folder : item)),
      }));
      showToast('文件夹已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名文件夹失败', 'error');
    }
  };

  const deleteFolder = async (folderId: string, folderName: string) => {
    const count = documentsByFolder.get(folderId)?.length || 0;
    if (!window.confirm(`确定删除文件夹“${folderName}”吗？其中 ${count} 个文档也会一起删除。`)) return;

    try {
      const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
      const folders = index.folders.filter((item) => item.id !== folderId);
      const documents = index.documents.filter((document) => document.folder_id !== folderId);
      setIndex({ folders, documents });
      if (activeFolderId === folderId) {
        setActiveFolderId(folders[0]?.id || '');
      }
      setViewer((prev) => (prev?.document.folder_id === folderId ? null : prev));
      showToast(result?.message || '文件夹已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文件夹失败', 'error');
    }
  };

  const deleteDocument = async (document: KnowledgeDocument) => {
    if (!window.confirm(`确定删除文档“${document.file_name}”吗？`)) return;

    try {
      const result = await window.yibiao?.knowledgeBase.deleteDocument(document.id);
      setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document.id) }));
      setViewer((prev) => (prev?.document.id === document.id ? null : prev));
      showToast(result?.message || '文档已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文档失败', 'error');
    }
  };

  const finishActiveViewerTrace = (reason: string, payload: Record<string, unknown> = {}) => {
    finishRenderDebugTrace(viewerTraceRef.current, reason, payload);
    viewerTraceRef.current = null;
    setViewerTrace(null);
  };

  const createViewerTrace = (document: KnowledgeDocument, mode: KnowledgeViewer['mode'], requestId: number) => {
    finishActiveViewerTrace('viewer-trace-replaced', { nextMode: mode, requestId });
    if (!developerMode || mode === 'analysis') {
      return null;
    }

    const kind: RenderDebugKind = mode === 'markdown' ? 'document-markdown' : 'document-items';
    const trace = createRenderDebugTrace(kind, document, '');
    viewerTraceRef.current = trace;
    setViewerTrace(trace);
    logRenderDebug(trace, 'click:open-document', {
      mode,
      requestId,
      status: document.status,
      itemCount: document.item_count || 0,
      blockCount: document.block_count || 0,
      filteredBlockCount: document.filtered_block_count || 0,
      candidateItemCount: document.candidate_item_count || 0,
    });
    return trace;
  };

  const openDocument = async (document: KnowledgeDocument, mode: KnowledgeViewer['mode']) => {
    if (mode === 'analysis' && !developerMode) {
      return;
    }
    const requestId = viewerRequestIdRef.current + 1;
    viewerRequestIdRef.current = requestId;
    const trace = createViewerTrace(document, mode, requestId);
    setViewerLoading(mode !== 'analysis');
    logRenderDebug(trace, 'state:loading-start', { loading: mode !== 'analysis' });
    startTransition(() => {
      setViewer({ document, mode });
      setMarkdownPreview('');
      setItemsPreview([]);
      if (mode === 'analysis') {
        setAnalysisSnapshot(null);
      }
    });
    logRenderDebug(trace, 'state:viewer-transition-scheduled', { mode });
    if (mode === 'analysis') {
      await loadAnalysis(document.id);
      return;
    }

    try {
      if (mode === 'markdown') {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readMarkdown', requestId });
        const markdown = await window.yibiao?.knowledgeBase.readMarkdown(document.id);
        const content = markdown || '';
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readMarkdown',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          contentLength: content.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceContentMetrics(trace, content);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-markdown-preview', { contentLength: content.length });
          setMarkdownPreview(content);
        }
      } else {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readItems', requestId });
        const items = await window.yibiao?.knowledgeBase.readItems(document.id);
        const nextItems = items || [];
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readItems',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          itemCount: nextItems.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceItemsMetrics(trace, nextItems);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-items-preview', { itemCount: nextItems.length });
          setItemsPreview(nextItems);
        }
      }
    } catch (error) {
      if (viewerRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'ipc:read:error', { message: error instanceof Error ? error.message : String(error) });
        finishRenderDebugTrace(trace, 'read-error');
        showToast(error instanceof Error ? error.message : '读取文档结果失败', 'error');
      }
    } finally {
      if (viewerRequestIdRef.current === requestId) {
        setViewerLoading(false);
        logRenderDebug(trace, 'state:loading-false');
      }
    }
  };

  const closeViewer = () => {
    viewerRequestIdRef.current += 1;
    finishActiveViewerTrace('viewer-closed');
    startTransition(() => {
      setViewer(null);
      setViewerLoading(false);
      setViewerTrace(null);
      setItemsPreview([]);
      setMarkdownPreview('');
      setAnalysisSnapshot(null);
    });
  };

  const startMatching = async (targetDocument = viewer?.document, batchSizeOverride = batchSize, options?: { silent?: boolean }) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id, batchSizeOverride);
      if (!options?.silent) {
        showToast(result?.message || '已提交匹配任务', result?.success ? 'success' : 'info');
      }
      if (developerMode) {
        await loadAnalysis(targetDocument.id, { silent: true });
      }
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '启动段落匹配失败', 'error');
      }
    } finally {
      setStartingMatching(false);
    }
  };

  if (viewer) {
    return (
      <KnowledgeDocumentViewer
        document={viewer.document}
        mode={viewer.mode}
        itemsPreview={itemsPreview}
        markdownPreview={markdownPreview}
        analysisSnapshot={analysisSnapshot}
        viewerLoading={viewerLoading}
        viewerTrace={viewerTrace}
        batchSize={batchSize}
        startingMatching={startingMatching}
        developerMode={developerMode}
        onBatchSizeChange={setBatchSize}
        onBack={closeViewer}
        onModeChange={(mode) => void openDocument(viewer.document, mode)}
        onStartMatching={() => void startMatching()}
        onRefreshAnalysis={() => void loadAnalysis(viewer.document.id)}
      />
    );
  }

  return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{activeFolder?.name || '未选择文件夹'}</strong>
          <small>{index.folders.length} 个文件夹 / {index.documents.length} 个文档</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={() => setShowCreateFolder((value) => !value)}>新建文件夹</button>
          <button type="button" className="primary-action" onClick={uploadDocuments} disabled={loading || !activeFolder}>
            {loading ? '处理中...' : '上传文档'}
          </button>
        </div>
      </section>

      {showCreateFolder && (
        <form
          className="knowledge-create-folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="输入文件夹名称"
          />
          <button type="submit" className="primary-action" disabled={creatingFolder}>{creatingFolder ? '创建中...' : '创建'}</button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              setNewFolderName('');
              setShowCreateFolder(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <span>{index.folders.length} 个</span>
          </div>
          {listLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识库...</strong>
              <p>请稍候，正在加载文件夹和文档列表。</p>
            </div>
          ) : index.folders.length ? (
            <div className="knowledge-folder-list">
              {index.folders.map((folder) => {
                const count = documentsByFolder.get(folder.id)?.length || 0;
                return (
                  <article key={folder.id} className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''}`}>
                    <button type="button" className="knowledge-folder-main" onClick={() => startTransition(() => setActiveFolderId(folder.id))}>
                      <span aria-hidden="true">F</span>
                      <strong>{folder.name}</strong>
                      <small>{count} 个文档</small>
                    </button>
                    <div className="knowledge-folder-actions">
                      <button type="button" onClick={() => void renameFolder(folder.id, folder.name)}>重命名</button>
                      <button type="button" className="is-danger" onClick={() => void deleteFolder(folder.id, folder.name)}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>先创建一个文件夹，再上传历史资料。</p>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          <div className="knowledge-panel-head">
            <strong>{activeFolder?.name || '未选择文件夹'}</strong>
            <span>{documents.length} 个文档</span>
          </div>

          {listLoading ? (
            <div className="knowledge-empty-box large">
              <strong>正在读取知识库...</strong>
              <p>文档列表加载完成后会自动显示。</p>
            </div>
          ) : documents.length ? (
            <div className="knowledge-document-list">
              {visibleDocuments.map((document) => (
                <article className="knowledge-document-card" key={document.id}>
                  <div className="knowledge-document-title">
                    <div className="knowledge-document-name">
                      <strong>{document.file_name}</strong>
                      {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
                    </div>
                    <span className={`knowledge-status is-${document.status}`}>{statusLabels[document.status]}</span>
                  </div>
                  <div className="knowledge-progress-track" aria-label={`处理进度 ${document.progress}%`}>
                    <span style={{ width: `${Math.max(0, Math.min(100, document.progress || 0))}%` }} />
                  </div>
                  <div className="knowledge-document-meta">
                    <span>{document.message}</span>
                    <span>{document.item_count || 0} 条知识</span>
                    <span>{document.candidate_item_count || 0} 个候选</span>
                    <span>{document.block_count || 0} 个 block</span>
                  </div>
                  <div className="knowledge-document-actions">
                    {developerMode && <button type="button" onClick={() => void openDocument(document, 'analysis')} disabled={!canOpenAnalysis(document)}>分析调试</button>}
                    <button type="button" onClick={() => void openDocument(document, 'items')} disabled={document.status !== 'success'}>查看条目</button>
                    <button type="button" onClick={() => void openDocument(document, 'markdown')} disabled={!canOpenMarkdown(document)}>查看 Markdown</button>
                    <button type="button" className="is-danger" onClick={() => void deleteDocument(document)}>删除</button>
                  </div>
                </article>
              ))}
              {visibleDocuments.length < documents.length && (
                <div className="knowledge-empty-box">
                  <strong>正在加载更多文档...</strong>
                  <p>已显示 {visibleDocuments.length} / {documents.length} 个文档。</p>
                </div>
              )}
            </div>
          ) : (
            <div className="knowledge-empty-box large">
              <strong>当前文件夹暂无文档</strong>
              <p>支持上传 .doc、.docx、.wps、.pdf、.md 文档。</p>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

interface KnowledgeDocumentViewerProps {
  document: KnowledgeDocument;
  mode: KnowledgeViewer['mode'];
  itemsPreview: KnowledgeItem[];
  markdownPreview: string;
  analysisSnapshot: KnowledgeAnalysisSnapshot | null;
  viewerLoading: boolean;
  viewerTrace: RenderDebugTrace | null;
  batchSize: number;
  startingMatching: boolean;
  developerMode: boolean;
  onBatchSizeChange: (value: number) => void;
  onBack: () => void;
  onModeChange: (mode: KnowledgeViewer['mode']) => void;
  onStartMatching: () => void;
  onRefreshAnalysis: () => void;
}

function KnowledgeDocumentViewer({
  document,
  mode,
  itemsPreview,
  markdownPreview,
  analysisSnapshot,
  viewerLoading,
  viewerTrace,
  batchSize,
  startingMatching,
  developerMode,
  onBatchSizeChange,
  onBack,
  onModeChange,
  onStartMatching,
  onRefreshAnalysis,
}: KnowledgeDocumentViewerProps) {
  const { showToast } = useToast();
  const [sourceItem, setSourceItem] = useState<KnowledgeItem | null>(null);
  const [sourceRendering, setSourceRendering] = useState(false);
  const [sourceTrace, setSourceTrace] = useState<RenderDebugTrace | null>(null);
  const renderRequestIdRef = useRef(0);
  const sourceTraceRef = useRef<RenderDebugTrace | null>(null);

  useEffect(() => {
    finishRenderDebugTrace(sourceTraceRef.current, 'viewer-reset');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
    renderRequestIdRef.current += 1;
  }, [document.id, mode]);

  const openSourceItem = (item: KnowledgeItem) => {
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-trace-replaced');
    const trace = developerMode ? createRenderDebugTrace('item-source', document, item.content || '', item) : null;
    sourceTraceRef.current = trace;

    setSourceItem(item);
    setSourceRendering(true);
    setSourceTrace(trace);
    logRenderDebug(trace, 'click:open-source');
    window.requestAnimationFrame(() => {
      if (renderRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'raf:release-markdown-render');
        setSourceRendering(false);
      }
    });
  };

  const closeSourceItem = () => {
    renderRequestIdRef.current += 1;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-view-closed');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
  };

  const copyDebugLogs = async () => {
    const logs = window.__knowledgeRenderDebugLogs || [];
    if (!logs.length) {
      showToast('暂无渲染调试日志', 'info');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      showToast(`渲染调试日志已复制（${logs.length} 条）`, 'success');
    } catch (error) {
      console.warn('复制渲染调试日志失败', error);
      showToast('复制调试日志失败', 'error');
    }
  };

  return (
    <div className="page-stack knowledge-viewer-page">
      <section className="knowledge-workspace-bar knowledge-viewer-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{document.file_name}</strong>
          {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
          <small>{mode === 'analysis' ? '分析调试' : mode === 'items' ? `${document.item_count || 0} 条知识` : 'Markdown 原文'}</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={onBack}>返回知识库</button>
          {developerMode && <button type="button" className="secondary-action" onClick={() => void copyDebugLogs()}>复制调试日志</button>}
          {developerMode && <button type="button" className={`secondary-action ${mode === 'analysis' ? 'is-active' : ''}`} onClick={() => onModeChange('analysis')}>分析调试</button>}
          <button type="button" className={`secondary-action ${mode === 'items' ? 'is-active' : ''}`} onClick={() => onModeChange('items')} disabled={document.status !== 'success'}>知识条目</button>
          <button type="button" className={`secondary-action ${mode === 'markdown' ? 'is-active' : ''}`} onClick={() => onModeChange('markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
        </div>
      </section>

      <section className="knowledge-viewer-panel">
        {mode === 'analysis' && developerMode ? (
          <KnowledgeAnalysisView
            document={document}
            snapshot={analysisSnapshot}
            batchSize={batchSize}
            startingMatching={startingMatching}
            onBatchSizeChange={onBatchSizeChange}
            onStartMatching={onStartMatching}
            onRefresh={onRefreshAnalysis}
          />
        ) : mode === 'items' ? (
          viewerLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识条目...</strong>
              <p>条目较多时需要稍等片刻。</p>
            </div>
          ) : (
            <DebuggableMarkdownContent
              className="knowledge-item-list knowledge-viewer-item-list"
              debugTrace={mode === 'items' ? viewerTrace : null}
              developerMode={developerMode}
              profilerId="knowledge-items-list"
            >
              {itemsPreview.length ? itemsPreview.map((item) => (
                <KnowledgeItemCard
                  key={item.id}
                  item={item}
                  developerMode={developerMode}
                  onOpenSource={() => openSourceItem(item)}
                />
              )) : <div className="knowledge-empty-box"><strong>暂无知识条目</strong><p>文档完成整理后会显示结果。</p></div>}
            </DebuggableMarkdownContent>
          )
        ) : (
          <div className="markdown-viewer knowledge-viewer-markdown">
            {viewerLoading ? (
              <div className="knowledge-empty-box large">
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <DebuggableMarkdownContent
                className="knowledge-markdown-debug-content"
                debugTrace={mode === 'markdown' ? viewerTrace : null}
                developerMode={developerMode}
                profilerId="knowledge-document-markdown"
              >
                <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
              </DebuggableMarkdownContent>
            )}
          </div>
        )}
      </section>

      <Dialog.Root open={Boolean(sourceItem)} onOpenChange={(open) => !open && closeSourceItem()}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-source-modal" />
          {sourceItem && (
            <KnowledgeItemSourceDialog
              item={sourceItem}
              developerMode={developerMode}
              rendering={sourceRendering}
              debugTrace={sourceTrace}
              onClose={closeSourceItem}
            />
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

interface KnowledgeItemCardProps {
  item: KnowledgeItem;
  developerMode: boolean;
  onOpenSource: () => void;
}

function KnowledgeItemCard({ item, developerMode, onOpenSource }: KnowledgeItemCardProps) {
  return (
    <article className="knowledge-item-card">
      {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
      <strong>{item.title}</strong>
      <p>{item.resume}</p>
      <button type="button" className="knowledge-item-source-action" onClick={onOpenSource}>查看原文</button>
    </article>
  );
}

interface KnowledgeItemSourceViewerProps {
  item: KnowledgeItem;
  developerMode: boolean;
  rendering: boolean;
  debugTrace: RenderDebugTrace | null;
  onClose: () => void;
}

function KnowledgeItemSourceDialog({ item, developerMode, rendering, debugTrace, onClose }: KnowledgeItemSourceViewerProps) {
  useLayoutEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return;
    logRenderDebug(debugTrace, 'loading:commit');
  }, [debugTrace, developerMode, rendering]);

  useEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'loading:next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode, rendering]);

  return (
    <Dialog.Content className="knowledge-source-dialog-card knowledge-source-viewer">
      <div className="knowledge-source-head">
        <div>
          <span>知识条目原文</span>
          <Dialog.Title>{item.title}</Dialog.Title>
          <Dialog.Description>查看该知识条目对应的原始 Markdown 片段。</Dialog.Description>
          {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
        </div>
        <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
      </div>
      {rendering ? (
        <div className="knowledge-empty-box large knowledge-source-loading">
          <span className="inline-spinner" aria-hidden="true" />
          <strong>正在渲染原文...</strong>
          <p>内容较大时需要稍等片刻。</p>
        </div>
      ) : (
        <DebuggableMarkdownContent
          className="markdown-viewer knowledge-source-content"
          debugTrace={debugTrace}
          developerMode={developerMode}
          profilerId="knowledge-item-source"
        >
          <MarkdownRenderer enableGfm={false} components={knowledgeItemSourceComponents}>
            {item.content || '暂无原文内容'}
          </MarkdownRenderer>
        </DebuggableMarkdownContent>
      )}
    </Dialog.Content>
  );
}

interface DebuggableMarkdownContentProps {
  children: ReactNode;
  className: string;
  debugTrace: RenderDebugTrace | null;
  developerMode: boolean;
  profilerId: string;
}

function DebuggableMarkdownContent({ children, className, debugTrace, developerMode, profilerId }: DebuggableMarkdownContentProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!developerMode || !debugTrace) return;
    logRenderDebug(debugTrace, 'dom:commit', collectDomMetrics(contentRef.current));
  });

  useEffect(() => {
    if (!developerMode || !debugTrace) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'dom:next-frame-visible', collectDomMetrics(contentRef.current));
      finishRenderDebugTrace(debugTrace, 'next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode]);

  const content = <div ref={contentRef} className={className}>{children}</div>;
  if (!developerMode || !debugTrace) return content;

  return (
    <Profiler
      id={profilerId}
      onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        logProfilerRender(debugTrace, id, phase, actualDuration, baseDuration, startTime, commitTime);
      }}
    >
      {content}
    </Profiler>
  );
}

interface KnowledgeAnalysisViewProps {
  document: KnowledgeDocument;
  snapshot: KnowledgeAnalysisSnapshot | null;
  batchSize: number;
  startingMatching: boolean;
  onBatchSizeChange: (value: number) => void;
  onStartMatching: () => void;
  onRefresh: () => void;
}

function KnowledgeAnalysisView({ document, snapshot, batchSize, startingMatching, onBatchSizeChange, onStartMatching, onRefresh }: KnowledgeAnalysisViewProps) {
  const report = snapshot?.report;
  const canStart = ['ready_for_matching', 'success', 'error'].includes(document.status) && Boolean(snapshot?.candidate_items.length);

  return (
    <div className="knowledge-analysis-view">
      <div className="knowledge-analysis-command">
        <div>
          <strong>分批段落匹配</strong>
          <p>候选条目已由 AI 两轮抽取生成。这里设置每批投入多少条知识条目，程序会用稳定全文前缀循环匹配段落并执行补漏。</p>
        </div>
        <label>
          <span>每批条目数</span>
          <input
            type="number"
            min={1}
            max={100}
            value={batchSize}
            onChange={(event) => onBatchSizeChange(Number(event.target.value) || 1)}
          />
        </label>
        <button type="button" className="primary-action" onClick={onStartMatching} disabled={!canStart || startingMatching}>
          {startingMatching ? '提交中...' : document.status === 'success' ? '重新匹配' : '开始匹配'}
        </button>
        <button type="button" className="secondary-action" onClick={onRefresh}>刷新</button>
      </div>

      <div className="knowledge-analysis-stats">
        <StatCard label="有效 block" value={snapshot?.block_count ?? document.block_count ?? 0} />
        <StatCard label="筛除 block" value={snapshot?.filtered_blocks_count ?? document.filtered_block_count ?? 0} />
        <StatCard label="候选条目" value={snapshot?.candidate_items.length ?? document.candidate_item_count ?? 0} />
        <StatCard label="最终条目" value={report?.final_items_count ?? document.item_count ?? 0} />
        <StatCard label="覆盖率" value={report ? `${Math.round(report.coverage_rate * 100)}%` : '-'} />
        <StatCard label="补漏新增" value={report?.new_items_from_recovery_count ?? 0} />
        <StatCard label="Markdown 字符" value={formatInteger(snapshot?.markdown_chars)} />
        <StatCard label="保留 block 字符" value={formatInteger(snapshot?.kept_block_chars)} />
        <StatCard label="条目覆盖字符" value={formatInteger(snapshot?.covered_unique_content_chars)} />
        <StatCard label="原文真实覆盖率" value={formatPercent(snapshot?.coverage_rate_vs_markdown)} />
      </div>

      {report && (
        <div className="knowledge-analysis-report">
          <strong>处理报告</strong>
          <span>已匹配 {report.matched_blocks_count} 个 block</span>
          <span>AI 舍弃 {report.discarded_blocks_count} 个 block</span>
          <span>重试后系统舍弃 {report.system_discarded_after_retry_count} 个 block</span>
          <span>补漏轮次 {report.recovery_attempt_count}</span>
          <span>批次大小 {report.batch_size}</span>
        </div>
      )}

      {snapshot?.debug_log_path && (
        <div className="knowledge-analysis-debug-log">
          <strong>开发者日志</strong>
          <code>{snapshot.debug_log_path}</code>
        </div>
      )}

      <div className="knowledge-analysis-grid">
        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>候选知识条目</strong>
            <span>{snapshot?.candidate_items.length || 0} 条</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot?.candidate_items.length ? snapshot.candidate_items.map((item) => (
              <article className="knowledge-candidate-card" key={item.id}>
                <small>{item.id}</small>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
              </article>
            )) : <div className="knowledge-empty-box"><strong>暂无候选条目</strong><p>上传处理完成后会显示 AI 提取出的知识条目。</p></div>}
          </div>
        </section>

        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>舍弃记录</strong>
            <span>{(snapshot?.discarded.length || 0) + (snapshot?.system_discarded_after_retry.length || 0)} 组</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot && (snapshot.discarded.length || snapshot.system_discarded_after_retry.length) ? (
              [...snapshot.discarded, ...snapshot.system_discarded_after_retry].map((item, index) => (
                <article className="knowledge-candidate-card" key={`${item.reason}-${index}`}>
                  <small>{item.block_ids.length} 个 block</small>
                  <strong>{item.reason}</strong>
                  <p>{item.block_ids.join('、')}</p>
                </article>
              ))
            ) : <div className="knowledge-empty-box"><strong>暂无舍弃记录</strong><p>完成段落匹配和补漏后会显示。</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatInteger(value?: number) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '-';
}

function formatPercent(value?: number) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '-';
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="knowledge-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function canOpenAnalysis(document: KnowledgeDocument) {
  return !['pending', 'copying', 'converting', 'extracting'].includes(document.status);
}

function canOpenMarkdown(document: KnowledgeDocument) {
  return !['pending', 'copying'].includes(document.status);
}

function mergeDocuments(prev: KnowledgeDocument[], next: KnowledgeDocument[]) {
  const byId = new Map(prev.map((document) => [document.id, document]));
  next.forEach((document) => byId.set(document.id, document));
  return Array.from(byId.values());
}

export default KnowledgeBasePage;
