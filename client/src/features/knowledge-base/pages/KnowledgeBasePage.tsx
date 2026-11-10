import { Profiler, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ArchiveIcon, ChevronLeftIcon, DotsVerticalIcon, DragHandleDots2Icon, LayersIcon, MagnifyingGlassIcon, Pencil1Icon, PlusIcon, TrashIcon, UploadIcon } from '@radix-ui/react-icons';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, EmptyState, InlineSpinner, isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeBaseSearchPage, KnowledgeBaseSearchResult, KnowledgeDocument, KnowledgeItem } from '../types';

declare global {
  interface Window {
    __knowledgeRenderDebugLogs?: Array<Record<string, unknown>>;
  }
}

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const emptyDocuments: KnowledgeDocument[] = [];
const documentRenderBatchSize = 80;
const ALL_DOCUMENTS_FOLDER_ID = 'all';

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
type KnowledgeDropPosition = 'before' | 'after';
type KnowledgeDragPayload =
  | { kind: 'folder'; folderId: string }
  | { kind: 'document'; documentId: string; folderId: string };

interface KnowledgeDocumentDropTarget {
  documentId: string;
  position: KnowledgeDropPosition;
}

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
  targetItemId?: string;
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
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [folderNameForm, setFolderNameForm] = useState<
    | { mode: 'create' }
    | { mode: 'rename'; folderId: string; currentName: string }
    | null
  >(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [savingFolderName, setSavingFolderName] = useState(false);
  const [retryingDocumentIds, setRetryingDocumentIds] = useState<Set<string>>(() => new Set());
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const [dragPayload, setDragPayload] = useState<KnowledgeDragPayload | null>(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [documentDropTarget, setDocumentDropTarget] = useState<KnowledgeDocumentDropTarget | null>(null);
  const [dragSaving, setDragSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: 'folder'; folderId: string; folderName: string; count: number }
    | { type: 'document'; document: KnowledgeDocument }
    | null
  >(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [submittedSearchKeyword, setSubmittedSearchKeyword] = useState('');
  const [searchPage, setSearchPage] = useState<KnowledgeBaseSearchPage | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const documentListRef = useRef<HTMLDivElement | null>(null);
  const documentListScrollRef = useRef(0);
  const folderNameCancelRef = useRef(false);
  const searchRequestIdRef = useRef(0);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const viewerRequestIdRef = useRef(0);
  const viewerTraceRef = useRef<RenderDebugTrace | null>(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const isAllDocuments = activeFolderId === ALL_DOCUMENTS_FOLDER_ID;
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
  const folderNameById = useMemo(() => new Map(index.folders.map((folder) => [folder.id, folder.name])), [index.folders]);
  const documents = isAllDocuments ? index.documents : activeFolder ? documentsByFolder.get(activeFolder.id) || emptyDocuments : emptyDocuments;
  const canUploadToActiveFolder = Boolean(activeFolder) && !isAllDocuments;
  const visibleDocuments = documents.slice(0, Math.min(visibleDocumentCount, documents.length));

  useEffect(() => {
    trackPageView(viewer ? `knowledge-base/viewer/${viewer.mode}` : 'knowledge-base/library');
  }, [viewer?.mode]);

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
  }, [activeFolderId, documents.length]);

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
      void startMatching(document, { silent: true });
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
    if (isAllDocuments) return;
    if ((!activeFolderId || !index.folders.some((folder) => folder.id === activeFolderId)) && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, isAllDocuments, index.folders]);

  // 查看器关闭后恢复文档列表滚动位置。
  useLayoutEffect(() => {
    if (!viewer && documentListRef.current) {
      documentListRef.current.scrollTop = documentListScrollRef.current;
    }
  }, [viewer]);

  useEffect(() => {
    if (viewer?.mode === 'analysis') {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);

  const loadInitialData = async () => {
    try {
      setListLoading(true);
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
      const data = await window.yibiao?.knowledgeBase.list();
      if (data) {
        setIndex(data);
        setActiveFolderId((currentId) => (
          data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || ''
        ));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setLoading(false);
      setListLoading(false);
    }
  };

  const applyKnowledgeIndex = (data: KnowledgeBaseIndex) => {
    setIndex(data);
    setActiveFolderId((currentId) => (
      data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || ''
    ));
  };

  const clearDragState = () => {
    setDragPayload(null);
    setFolderDropTargetId(null);
    setDocumentDropTarget(null);
  };

  const isExternalFileDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes('Files') && !dragPayload;

  const handlePanelFileDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isExternalFileDrag(event) || !canUploadToActiveFolder) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setFileDragOver(true);
  };

  const handlePanelFileDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setFileDragOver(false);
  };

  const handlePanelFileDrop = async (event: DragEvent<HTMLElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    setFileDragOver(false);
    if (!canUploadToActiveFolder) return;
    const filePaths = Array.from(event.dataTransfer.files)
      .map((file) => window.yibiao?.file.getPathForFile(file) || '')
      .filter(Boolean);
    if (!filePaths.length) return;
    await uploadDocuments(filePaths);
  };

  const getDropPosition = (event: DragEvent<HTMLElement>): KnowledgeDropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const startFolderDrag = (event: DragEvent<HTMLElement>, folderId: string) => {
    if (dragSaving) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `folder:${folderId}`);
    setDragPayload({ kind: 'folder', folderId });
  };

  const startDocumentDrag = (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (dragSaving || !canMoveKnowledgeDocument(document)) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `document:${document.id}`);
    setDragPayload({ kind: 'document', documentId: document.id, folderId: document.folder_id });
  };

  const handleFolderDragOver = (event: DragEvent<HTMLElement>, folderId: string) => {
    if (!dragPayload || dragSaving) return;
    if (dragPayload.kind === 'folder' && dragPayload.folderId === folderId) return;
    if (dragPayload.kind === 'document' && dragPayload.folderId === folderId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setFolderDropTargetId(folderId);
    setDocumentDropTarget(null);
  };

  const handleFolderDrop = async (event: DragEvent<HTMLElement>, folderId: string) => {
    if (!dragPayload || dragSaving) return;
    event.preventDefault();
    const payload = dragPayload;
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      const result = payload.kind === 'folder'
        ? await window.yibiao?.knowledgeBase.reorderFolder(payload.folderId, folderId, position)
        : await window.yibiao?.knowledgeBase.moveDocument(payload.documentId, folderId, null, 'after');
      if (!result?.success) {
        throw new Error(result?.message || '拖拽操作失败');
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error('拖拽操作已保存，但读取知识库列表失败');
      applyKnowledgeIndex(data);
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '拖拽操作失败', 'error');
    } finally {
      setDragSaving(false);
      clearDragState();
    }
  };

  const handleDocumentDragOver = (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (!dragPayload || dragPayload.kind !== 'document' || dragSaving || dragPayload.documentId === document.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setFolderDropTargetId(null);
    setDocumentDropTarget({ documentId: document.id, position: getDropPosition(event) });
  };

  const handleDocumentDrop = async (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (!dragPayload || dragPayload.kind !== 'document' || dragSaving || dragPayload.documentId === document.id) return;
    event.preventDefault();
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      const result = await window.yibiao?.knowledgeBase.moveDocument(dragPayload.documentId, document.folder_id, document.id, position);
      if (!result?.success) {
        throw new Error(result?.message || '文档排序失败');
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error('文档排序已保存，但读取知识库列表失败');
      applyKnowledgeIndex(data);
      setActiveFolderId(document.folder_id);
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文档排序失败', 'error');
    } finally {
      setDragSaving(false);
      clearDragState();
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

  const fetchGlobalSearch = async (keyword: string, page: number) => {
    const requestId = ++searchRequestIdRef.current;
    setSearchError('');
    setSearchLoading(true);
    try {
      const result = await window.yibiao.knowledgeBase.search({ keyword, page });
      if (searchRequestIdRef.current !== requestId) return;
      setSearchPage(result);
    } catch (error) {
      if (searchRequestIdRef.current === requestId) {
        const message = error instanceof Error ? error.message : '知识库检索失败';
        setSearchError(message);
        showToast(message, 'error');
      }
    } finally {
      if (searchRequestIdRef.current === requestId) setSearchLoading(false);
    }
  };

  const runGlobalSearch = async () => {
    const keyword = searchKeyword.trim();
    if (!keyword) {
      clearGlobalSearch();
      return;
    }
    setSubmittedSearchKeyword(keyword);
    setSearchPage(null);
    await fetchGlobalSearch(keyword, 1);
  };

  const clearGlobalSearch = () => {
    searchRequestIdRef.current += 1;
    setSearchKeyword('');
    setSubmittedSearchKeyword('');
    setSearchPage(null);
    setSearchError('');
    setSearchLoading(false);
  };

  const openSearchResult = async (result: KnowledgeBaseSearchResult) => {
    const document = index.documents.find((item) => item.id === result.document_id);
    if (!document) {
      showToast('对应知识文档已不存在，请重新检索', 'info');
      return;
    }
    setActiveFolderId(result.folder_id);
    await openDocument(document, 'items', result.item_id);
  };


  const openCreateFolderForm = () => {
    folderNameCancelRef.current = false;
    setFolderNameForm({ mode: 'create' });
    setFolderNameInput('');
  };

  const openRenameFolderForm = (folderId: string, currentName: string) => {
    folderNameCancelRef.current = false;
    setFolderNameForm({ mode: 'rename', folderId, currentName });
    setFolderNameInput(currentName);
  };

  const closeFolderNameForm = () => {
    setFolderNameForm(null);
    setFolderNameInput('');
  };

  const submitFolderNameForm = async () => {
    if (!folderNameForm || savingFolderName) return;
    const name = folderNameInput.trim();
    if (!name) {
      closeFolderNameForm();
      return;
    }
    if (folderNameForm?.mode === 'rename' && name === folderNameForm.currentName) {
      closeFolderNameForm();
      return;
    }

    try {
      setSavingFolderName(true);
      if (folderNameForm?.mode === 'rename') {
        const folder = await window.yibiao?.knowledgeBase.renameFolder(folderNameForm.folderId, name);
        if (!folder) return;
        setIndex((prev) => ({
          ...prev,
          folders: prev.folders.map((item) => (item.id === folder.id ? folder : item)),
        }));
        showToast('文件夹已重命名', 'success');
      } else {
        const folder = await window.yibiao?.knowledgeBase.createFolder(name);
        if (!folder) return;
        setIndex((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
        setActiveFolderId(folder.id);
        showToast('文件夹已创建', 'success');
      }
      closeFolderNameForm();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : folderNameForm?.mode === 'rename' ? '重命名文件夹失败' : '创建文件夹失败',
        'error',
      );
    } finally {
      setSavingFolderName(false);
    }
  };

  const uploadDocuments = async (filePaths?: string[]) => {
    if (!activeFolder || isAllDocuments) {
      showToast('请先选择文件夹', 'info');
      return;
    }

    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.uploadDocuments(activeFolder.id, filePaths);
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

  const deleteFolder = (folderId: string, folderName: string) => {
    const count = documentsByFolder.get(folderId)?.length || 0;
    setDeleteConfirm({ type: 'folder', folderId, folderName, count });
  };

  const deleteDocument = (document: KnowledgeDocument) => {
    setDeleteConfirm({ type: 'document', document });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    setDeletingConfirm(true);
    try {
      if (deleteConfirm.type === 'folder') {
        const { folderId } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
        const folders = index.folders.filter((item) => item.id !== folderId);
        const documents = index.documents.filter((document) => document.folder_id !== folderId);
        setIndex({ folders, documents });
        if (activeFolderId === folderId) {
          setActiveFolderId(folders[0]?.id || '');
        }
        setViewer((prev) => (prev?.document.folder_id === folderId ? null : prev));
        showToast(result?.message || '文件夹已删除', 'success');
      } else {
        const { document } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteDocument(document.id);
        setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document.id) }));
        setViewer((prev) => (prev?.document.id === document.id ? null : prev));
        showToast(result?.message || '文档已删除', 'success');
      }
      setDeleteConfirm(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : deleteConfirm.type === 'folder' ? '删除文件夹失败' : '删除文档失败', 'error');
    } finally {
      setDeletingConfirm(false);
    }
  };

  const retryDocument = async (document: KnowledgeDocument) => {
    setRetryingDocumentIds((prev) => new Set(prev).add(document.id));
    try {
      const result = await window.yibiao?.knowledgeBase.retryDocument(document.id);
      if (result?.document) {
        const updatedDocument = result.document;
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, [updatedDocument]) }));
        setViewer((prev) => (prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev));
        setAnalysisSnapshot((prev) => (prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev));
      }
      if (!result?.success) {
        const message = result?.message || '重试失败';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'info');
        return;
      }
      showToast(result.message || '已重新开始解析', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setRetryingDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(document.id);
        return next;
      });
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

  // 打开文档，可指定首次自动查看原文的知识条目。
  const openDocument = async (document: KnowledgeDocument, mode: KnowledgeViewer['mode'], targetItemId?: string) => {
    if (mode === 'analysis' && !developerMode) {
      return;
    }
    if (documentListRef.current) {
      documentListScrollRef.current = documentListRef.current.scrollTop;
    }
    const requestId = viewerRequestIdRef.current + 1;
    viewerRequestIdRef.current = requestId;
    const trace = createViewerTrace(document, mode, requestId);
    setViewerLoading(mode !== 'analysis');
    logRenderDebug(trace, 'state:loading-start', { loading: mode !== 'analysis' });
    startTransition(() => {
      setViewer({ document, mode, targetItemId });
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
        if (targetItemId && !nextItems.some((item) => item.id === targetItemId)) {
          showToast('对应知识条目已不存在，请重新检索', 'info');
          closeViewer();
          return;
        }
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

  const startMatching = async (targetDocument = viewer?.document, options?: { silent?: boolean }) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id);
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

  // 新建/重命名共用的行内名称编辑器：Enter 或失焦提交，Esc 取消。
  const renderFolderNameEditor = () => (
    <div className="knowledge-inline-edit">
      <ArchiveIcon className="knowledge-nav-icon" aria-hidden="true" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submitFolderNameForm();
        }}
      >
        <input
          autoFocus
          value={folderNameInput}
          onChange={(event) => setFolderNameInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              folderNameCancelRef.current = true;
              closeFolderNameForm();
            }
          }}
          onBlur={() => {
            if (folderNameCancelRef.current) return;
            void submitFolderNameForm();
          }}
          placeholder="输入文件夹名称"
          disabled={savingFolderName}
        />
      </form>
    </div>
  );

  if (viewer) {
    return (
      <>
        <KnowledgeDocumentViewer
          document={viewer.document}
          mode={viewer.mode}
          targetItemId={viewer.targetItemId}
          itemsPreview={itemsPreview}
          markdownPreview={markdownPreview}
          analysisSnapshot={analysisSnapshot}
          viewerLoading={viewerLoading}
          viewerTrace={viewerTrace}
          startingMatching={startingMatching}
          developerMode={developerMode}
          onBack={closeViewer}
          onModeChange={(mode) => void openDocument(viewer.document, mode)}
          onStartMatching={() => void startMatching()}
          onRefreshAnalysis={() => void loadAnalysis(viewer.document.id)}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-stack knowledge-page">
        <section className="knowledge-workspace-bar">
          <div className="knowledge-breadcrumb">
            <strong>知识库</strong>
            <span>{isAllDocuments ? '全部文档' : activeFolder?.name || '未选择文件夹'}</span>
            <small>{index.folders.length} 个文件夹 / {index.documents.length} 个文档</small>
          </div>
          <form
            className="knowledge-search-inline"
            onSubmit={(event) => {
              event.preventDefault();
              void runGlobalSearch();
            }}
          >
            <MagnifyingGlassIcon className="knowledge-search-icon" aria-hidden="true" />
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="检索全部知识"
              aria-label="全库检索"
            />
            <button type="submit" className="secondary-action" disabled={searchLoading || !searchKeyword.trim()}>
              {searchLoading ? '检索中...' : '检索'}
            </button>
            {submittedSearchKeyword && <button type="button" className="secondary-action" onClick={clearGlobalSearch}>返回文件夹</button>}
          </form>
          <div className="knowledge-toolbar-actions">
            <button
              type="button"
              className="primary-action"
              onClick={() => void uploadDocuments()}
              disabled={loading || !canUploadToActiveFolder}
              title={isAllDocuments ? '请先选择具体文件夹再上传' : undefined}
            >
              <UploadIcon aria-hidden="true" />{loading ? '处理中...' : '上传文档'}
            </button>
          </div>
        </section>

      {submittedSearchKeyword ? (
        <KnowledgeSearchResults
          keyword={submittedSearchKeyword}
          resultPage={searchPage}
          error={searchError}
          onPageChange={(page) => { void fetchGlobalSearch(submittedSearchKeyword, page); }}
          loading={searchLoading}
          onOpenResult={(result) => { void openSearchResult(result); }}
        />
      ) : (
      <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <button type="button" className="knowledge-head-action" onClick={openCreateFolderForm} disabled={listLoading}>
              <PlusIcon aria-hidden="true" />新建
            </button>
          </div>
          {listLoading ? (
            <div className="knowledge-loading-box">
              <InlineSpinner />
              <strong>正在读取知识库...</strong>
              <p>请稍候，正在加载文件夹和文档列表。</p>
            </div>
          ) : (
            <div className="knowledge-folder-list">
              <div className={`knowledge-nav-item${isAllDocuments ? ' is-active' : ''}`}>
                <button type="button" className="knowledge-nav-main" onClick={() => startTransition(() => setActiveFolderId(ALL_DOCUMENTS_FOLDER_ID))}>
                  <LayersIcon className="knowledge-nav-icon" aria-hidden="true" />
                  <strong>全部文档</strong>
                  <span className="knowledge-count-badge">{index.documents.length}</span>
                </button>
              </div>
              {folderNameForm?.mode === 'create' && (
                <div className="knowledge-nav-item">{renderFolderNameEditor()}</div>
              )}
              {index.folders.map((folder) => {
                const count = documentsByFolder.get(folder.id)?.length || 0;
                const dragging = dragPayload?.kind === 'folder' && dragPayload.folderId === folder.id;
                const dropTarget = folderDropTargetId === folder.id;
                const renaming = folderNameForm?.mode === 'rename' && folderNameForm.folderId === folder.id;
                return (
                  <div
                    key={folder.id}
                    className={`knowledge-nav-item${folder.id === activeFolderId ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
                    onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                    onDrop={(event) => { void handleFolderDrop(event, folder.id); }}
                  >
                    {renaming ? renderFolderNameEditor() : (
                      <>
                        <span
                          className="knowledge-drag-handle"
                          draggable={!dragSaving}
                          onDragStart={(event) => startFolderDrag(event, folder.id)}
                          onDragEnd={clearDragState}
                          title="拖拽排序"
                          aria-hidden="true"
                        ><DragHandleDots2Icon /></span>
                        <button type="button" className="knowledge-nav-main" onClick={() => startTransition(() => setActiveFolderId(folder.id))}>
                          <ArchiveIcon className="knowledge-nav-icon" aria-hidden="true" />
                          <strong>{folder.name}</strong>
                          <span className="knowledge-count-badge">{dropTarget && dragPayload?.kind === 'document' ? '移动至此' : count}</span>
                        </button>
                        <Popover.Root>
                          <Popover.Trigger asChild>
                            <button type="button" className="knowledge-nav-menu-trigger" title="文件夹操作" aria-label={`文件夹“${folder.name}”操作`}>
                              <DotsVerticalIcon />
                            </button>
                          </Popover.Trigger>
                          <Popover.Portal>
                            <Popover.Content className="knowledge-nav-menu" side="bottom" align="end" sideOffset={4}>
                              <Popover.Close asChild>
                                <button type="button" className="knowledge-menu-item" onClick={() => openRenameFolderForm(folder.id, folder.name)}>
                                  <Pencil1Icon aria-hidden="true" />重命名
                                </button>
                              </Popover.Close>
                              <Popover.Close asChild>
                                <button type="button" className="knowledge-menu-item is-danger" onClick={() => void deleteFolder(folder.id, folder.name)}>
                                  <TrashIcon aria-hidden="true" />删除
                                </button>
                              </Popover.Close>
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      </>
                    )}
                  </div>
                );
              })}
              {!index.folders.length && !folderNameForm && (
                <EmptyState title="还没有文件夹" hint="先创建一个文件夹，再上传历史资料。">
                  <button type="button" className="primary-action" onClick={openCreateFolderForm}>新建文件夹</button>
                </EmptyState>
              )}
            </div>
          )}
        </aside>

        <main
          className={`knowledge-document-panel${fileDragOver ? ' is-file-drag-over' : ''}`}
          onDragOver={handlePanelFileDragOver}
          onDragLeave={handlePanelFileDragLeave}
          onDrop={(event) => { void handlePanelFileDrop(event); }}
        >
          <div className="knowledge-panel-head">
            <strong>{isAllDocuments ? '全部文档' : activeFolder?.name || '未选择文件夹'}</strong>
            <span>{documents.length} 个文档</span>
          </div>

          {listLoading ? (
            <div className="knowledge-loading-box large">
              <InlineSpinner />
              <strong>正在读取知识库...</strong>
              <p>文档列表加载完成后会自动显示。</p>
            </div>
          ) : documents.length ? (
            <div className="knowledge-document-list" ref={documentListRef}>
              {visibleDocuments.map((document) => {
                const retrying = retryingDocumentIds.has(document.id);
                const canDragDocument = canMoveKnowledgeDocument(document) && !dragSaving;
                const dragging = dragPayload?.kind === 'document' && dragPayload.documentId === document.id;
                const dropTarget = documentDropTarget?.documentId === document.id ? ` is-drop-${documentDropTarget.position}` : '';
                const processing = isDocumentProcessing(document.status);
                const canOpenItems = document.status === 'success';
                return (
                  <article
                    className={`knowledge-document-card${dragging ? ' is-dragging' : ''}${dropTarget}`}
                    key={document.id}
                    onDragOver={(event) => handleDocumentDragOver(event, document)}
                    onDrop={(event) => { void handleDocumentDrop(event, document); }}
                  >
                    <span
                      className="knowledge-drag-handle"
                      draggable={canDragDocument}
                      onDragStart={(event) => startDocumentDrag(event, document)}
                      onDragEnd={clearDragState}
                      title={canDragDocument ? '拖拽排序或移动到文件夹' : '处理中，暂不可拖动'}
                      aria-hidden="true"
                    ><DragHandleDots2Icon /></span>
                    <div
                      className="knowledge-document-body"
                      role={canOpenItems ? 'button' : undefined}
                      tabIndex={canOpenItems ? 0 : undefined}
                      onClick={() => { if (canOpenItems) void openDocument(document, 'items'); }}
                      onKeyDown={(event) => {
                        if (canOpenItems && (event.key === 'Enter' || event.key === ' ')) {
                          event.preventDefault();
                          void openDocument(document, 'items');
                        }
                      }}
                      title={canOpenItems ? '查看知识条目' : undefined}
                    >
                      <span className={`knowledge-doc-ext ${documentExtKind(document.file_name)}`} aria-hidden="true">{documentExtLabel(document.file_name)}</span>
                      <div className="knowledge-document-info">
                        <div className="knowledge-document-title">
                          <strong title={document.file_name}>{document.file_name}</strong>
                          <span className={`knowledge-status is-${document.status}`}>{statusLabels[document.status]}</span>
                        </div>
                        <div className="knowledge-document-meta">
                          {document.status === 'error' && (
                            <span className="knowledge-doc-error">{document.error || document.message || '处理失败'}</span>
                          )}
                          {processing && <span>{document.message}</span>}
                          <span>{document.item_count || 0} 条知识</span>
                          <span>{formatDocumentDate(document.created_at)}</span>
                          {isAllDocuments && <span className="knowledge-doc-folder">{folderNameById.get(document.folder_id) || '未归档'}</span>}
                          {developerMode && (
                            <span>{document.block_count || 0} block / {document.candidate_item_count || 0} 候选 / {document.id}</span>
                          )}
                        </div>
                        {processing && <ProgressBar value={document.progress || 0} label={`处理进度 ${document.progress}%`} />}
                      </div>
                    </div>
                    <div className="knowledge-card-actions">
                      {developerMode && <button type="button" onClick={() => void openDocument(document, 'analysis')} disabled={!canOpenAnalysis(document)}>分析调试</button>}
                      <button type="button" onClick={() => void openDocument(document, 'markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
                      {document.status === 'error' && (
                        <button type="button" className="is-retry" onClick={() => void retryDocument(document)} disabled={retrying}>
                          {retrying ? '重试中...' : '重试'}
                        </button>
                      )}
                      <button type="button" className="is-danger" onClick={() => void deleteDocument(document)}>删除</button>
                    </div>
                  </article>
                );
              })}
              {visibleDocuments.length < documents.length && (
                <div className="knowledge-loading-box">
                  <InlineSpinner />
                  <strong>正在加载更多文档...</strong>
                  <p>已显示 {visibleDocuments.length} / {documents.length} 个文档。</p>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              title={isAllDocuments ? '知识库还没有文档' : '当前文件夹暂无文档'}
              hint={canUploadToActiveFolder ? '支持上传 .doc、.docx、.wps、.pdf、.md、.xls、.xlsx 文档，也可直接拖拽文件到此处。' : '先在左侧选择或新建一个文件夹。'}
            >
              {canUploadToActiveFolder && (
                <button type="button" className="primary-action" onClick={() => void uploadDocuments()} disabled={loading}>
                  {loading ? '处理中...' : '上传文档'}
                </button>
              )}
            </EmptyState>
          )}
        </main>
      </section>
      )}
      </div>

      <AppDialog
        open={Boolean(deleteConfirm)}
        onOpenChange={(open) => !open && !deletingConfirm && setDeleteConfirm(null)}
        kicker="知识库"
        title={deleteConfirm?.type === 'folder' ? `确定删除文件夹“${deleteConfirm.folderName}”吗？` : `确定删除文档“${deleteConfirm?.type === 'document' ? deleteConfirm.document.file_name : ''}”吗？`}
        description={deleteConfirm?.type === 'folder' ? `其中 ${deleteConfirm.count} 个文档也会一起删除，删除后不可恢复。` : '删除后不可恢复。'}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setDeleteConfirm(null)} disabled={deletingConfirm}>取消</button>
            <button type="button" className="danger-action" onClick={() => { void confirmDelete(); }} disabled={deletingConfirm}>
              {deletingConfirm ? '正在删除...' : '确认删除'}
            </button>
          </>
        )}
      />
    </>
  );
}

interface KnowledgeDocumentViewerProps {
  document: KnowledgeDocument;
  mode: KnowledgeViewer['mode'];
  targetItemId?: string;
  itemsPreview: KnowledgeItem[];
  markdownPreview: string;
  analysisSnapshot: KnowledgeAnalysisSnapshot | null;
  viewerLoading: boolean;
  viewerTrace: RenderDebugTrace | null;
  startingMatching: boolean;
  developerMode: boolean;
  onBack: () => void;
  onModeChange: (mode: KnowledgeViewer['mode']) => void;
  onStartMatching: () => void;
  onRefreshAnalysis: () => void;
}

function KnowledgeDocumentViewer({
  document,
  mode,
  targetItemId,
  itemsPreview,
  markdownPreview,
  analysisSnapshot,
  viewerLoading,
  viewerTrace,
  startingMatching,
  developerMode,
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
  const pendingTargetItemIdRef = useRef(targetItemId);

  useEffect(() => {
    finishRenderDebugTrace(sourceTraceRef.current, 'viewer-reset');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
    renderRequestIdRef.current += 1;
    pendingTargetItemIdRef.current = targetItemId;
  }, [document.id, mode, targetItemId]);

  // 复用原文打开流程，保留渲染进度和开发者调试记录。
  const openSourceItem = useCallback((item: KnowledgeItem) => {
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
  }, [developerMode, document]);

  // 搜索定位只消费一次，关闭原文后不再自动弹出。
  useEffect(() => {
    if (mode !== 'items' || viewerLoading || !pendingTargetItemIdRef.current) return;
    const item = itemsPreview.find((entry) => entry.id === pendingTargetItemIdRef.current);
    if (!item) return;
    pendingTargetItemIdRef.current = undefined;
    openSourceItem(item);
  }, [itemsPreview, mode, targetItemId, viewerLoading, openSourceItem]);

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
        <div className="knowledge-viewer-title">
          <button type="button" className="knowledge-back-action" onClick={onBack}>
            <ChevronLeftIcon aria-hidden="true" />返回
          </button>
          <div className="knowledge-breadcrumb">
            <strong>{document.file_name}</strong>
            {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
            <small>{mode === 'analysis' ? '分析调试' : mode === 'items' ? `${document.item_count || 0} 条知识` : 'Markdown 原文'}</small>
          </div>
        </div>
        <div className="knowledge-toolbar-actions">
          {developerMode && <button type="button" className="secondary-action" onClick={() => void copyDebugLogs()}>复制调试日志</button>}
          <div className="knowledge-segmented" role="tablist" aria-label="查看模式">
            {developerMode && (
              <button type="button" className={mode === 'analysis' ? 'is-active' : ''} onClick={() => onModeChange('analysis')}>分析调试</button>
            )}
            <button type="button" className={mode === 'items' ? 'is-active' : ''} onClick={() => onModeChange('items')} disabled={document.status !== 'success'}>知识条目</button>
            <button type="button" className={mode === 'markdown' ? 'is-active' : ''} onClick={() => onModeChange('markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
          </div>
        </div>
      </section>

      <section className="knowledge-viewer-panel">
        {mode === 'analysis' && developerMode ? (
          <KnowledgeAnalysisView
            document={document}
            snapshot={analysisSnapshot}
            startingMatching={startingMatching}
            onStartMatching={onStartMatching}
            onRefresh={onRefreshAnalysis}
          />
        ) : mode === 'items' ? (
          viewerLoading ? (
            <div className="knowledge-loading-box">
              <InlineSpinner />
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
              {itemsPreview.length ? itemsPreview.map((item, itemIndex) => (
                <KnowledgeItemCard
                  key={item.id}
                  item={item}
                  index={itemIndex}
                  developerMode={developerMode}
                  onOpenSource={() => openSourceItem(item)}
                />
              )) : <EmptyState title="暂无知识条目" hint="文档完成整理后会显示结果。" />}
            </DebuggableMarkdownContent>
          )
        ) : (
          <MarkdownFullscreenViewer
            className="markdown-viewer knowledge-viewer-markdown"
            title={`${document.file_name}全屏查看`}
            fullscreenChildren={viewerLoading ? (
              <div className="knowledge-loading-box large">
                <InlineSpinner />
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
            )}
          >
            {viewerLoading ? (
              <div className="knowledge-loading-box large">
                <InlineSpinner />
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
          </MarkdownFullscreenViewer>
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
  index: number;
  developerMode: boolean;
  onOpenSource: () => void;
}

function KnowledgeItemCard({ item, index, developerMode, onOpenSource }: KnowledgeItemCardProps) {
  return (
    <article className="knowledge-item-card">
      {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
      <div className="knowledge-item-head">
        <span className="knowledge-item-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <strong>{item.title}</strong>
      </div>
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
        <div className="knowledge-loading-box large knowledge-source-loading">
          <InlineSpinner />
          <strong>正在渲染原文...</strong>
          <p>内容较大时需要稍等片刻。</p>
        </div>
      ) : (
        <MarkdownFullscreenViewer
          className="markdown-viewer knowledge-source-content"
          title={`${item.title}原文全屏查看`}
          fullscreenChildren={(
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          )}
        >
          <DebuggableMarkdownContent
            className="knowledge-source-debug-content"
            debugTrace={debugTrace}
            developerMode={developerMode}
            profilerId="knowledge-item-source"
          >
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          </DebuggableMarkdownContent>
        </MarkdownFullscreenViewer>
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
  startingMatching: boolean;
  onStartMatching: () => void;
  onRefresh: () => void;
}

function KnowledgeAnalysisView({ document, snapshot, startingMatching, onStartMatching, onRefresh }: KnowledgeAnalysisViewProps) {
  const report = snapshot?.report;
  const canStart = ['ready_for_matching', 'success', 'error'].includes(document.status) && Boolean(snapshot?.candidate_items.length);

  return (
    <div className="knowledge-analysis-view">
      <div className="knowledge-analysis-command">
        <div>
          <strong>自动分段段落匹配</strong>
          <p>按模型上下文长度自动分段匹配段落，并在匹配后执行遗漏补漏。</p>
        </div>
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
          <span>block 段数 {report.batch_size}</span>
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
            )) : <EmptyState title="暂无候选条目" hint="上传处理完成后会显示 AI 提取出的知识条目。" />}
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
            ) : <EmptyState title="暂无舍弃记录" hint="完成段落匹配和补漏后会显示。" />}
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

function canMoveKnowledgeDocument(document: KnowledgeDocument) {
  return ['ready_for_matching', 'success', 'error'].includes(document.status);
}

function isDocumentProcessing(status: KnowledgeDocument['status']) {
  return !['success', 'error', 'ready_for_matching'].includes(status);
}

const documentExtKinds: Record<string, string> = {
  pdf: 'is-pdf',
  xls: 'is-xls',
  xlsx: 'is-xls',
  md: 'is-md',
  markdown: 'is-md',
};

function documentExt(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

function documentExtKind(fileName: string) {
  return documentExtKinds[documentExt(fileName)] || 'is-doc';
}

function documentExtLabel(fileName: string) {
  const ext = documentExt(fileName);
  return ext ? ext.toUpperCase() : 'DOC';
}

function formatDocumentDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function mergeDocuments(prev: KnowledgeDocument[], next: KnowledgeDocument[]) {
  const byId = new Map(prev.map((document) => [document.id, document]));
  next.forEach((document) => byId.set(document.id, document));
  return Array.from(byId.values());
}

export default KnowledgeBasePage;

interface KnowledgeSearchResultsProps {
  keyword: string;
  resultPage: KnowledgeBaseSearchPage | null;
  error: string;
  loading: boolean;
  onPageChange: (page: number) => void;
  onOpenResult: (result: KnowledgeBaseSearchResult) => void;
}

function KnowledgeSearchResults({ keyword, resultPage, error, loading, onPageChange, onOpenResult }: KnowledgeSearchResultsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resultPage]);
  const results = resultPage?.items || [];
  const totalPages = resultPage ? Math.max(1, Math.ceil(resultPage.total / resultPage.pageSize)) : 1;

  return (
    <section className="knowledge-search-panel" aria-busy={loading}>
      <div className="knowledge-panel-head">
        <strong>“{keyword}”的检索结果</strong>
        <span aria-live="polite">{loading ? '正在检索' : resultPage ? `共 ${resultPage.total} 条知识` : '检索失败'}</span>
      </div>
      {resultPage ? (
        <div className="knowledge-search-result-list" ref={listRef}>
          {error && <p role="alert">检索失败，仍显示上次成功的结果。请重新检索或翻页。{error}</p>}
          {results.length ? results.map((result) => (
            <article className="knowledge-search-result-card" key={`${result.document_id}:${result.item_id}`}>
              <div className="knowledge-search-result-path">
                <span>{result.folder_name}</span>
                <span aria-hidden="true">/</span>
                <strong>{result.file_name}</strong>
              </div>
              <h3>{result.title}</h3>
              <p>{result.snippet || result.resume || '该条目暂无可显示片段'}</p>
              <button type="button" className="knowledge-item-source-action" onClick={() => onOpenResult(result)}>打开知识条目</button>
            </article>
          )) : (
            <EmptyState title="没有找到相关知识" hint="请更换关键字，或确认相关文档已经完成知识整理。" />
          )}
        </div>
      ) : loading ? (
        <div className="knowledge-loading-box large">
          <InlineSpinner />
          <strong>正在检索全部知识库...</strong>
          <p>检索完成后会显示对应文档和知识片段。</p>
        </div>
      ) : (
        <EmptyState title="知识库检索失败" hint={<span role="alert">{error} 请点击“检索”重试。</span>} />
      )}
      {resultPage && resultPage.total > 0 && (
        <div className="knowledge-search-pagination">
          <span>第 {resultPage.page} / {totalPages} 页 · 当前显示 {(resultPage.page - 1) * resultPage.pageSize + 1}–{(resultPage.page - 1) * resultPage.pageSize + results.length} 条</span>
          <div>
            <button type="button" className="secondary-action" disabled={loading || resultPage.page <= 1} onClick={() => onPageChange(resultPage.page - 1)}>上一页</button>
            <button type="button" className="secondary-action" disabled={loading || resultPage.page >= totalPages} onClick={() => onPageChange(resultPage.page + 1)}>下一页</button>
          </div>
        </div>
      )}
    </section>
  );
}
