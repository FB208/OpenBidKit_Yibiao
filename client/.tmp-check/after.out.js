"use strict";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Profiler, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { trackPageView } from "../../../shared/analytics/analytics";
import { InlineSpinner, isLibreOfficeRequiredMessage, MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, TableEditorDialog, ProgressBar, useDocumentParseNotice, useToast } from "../../../shared/ui";
import ImagePickerDialog from "../components/ImagePickerDialog";
const emptyIndex = { folders: [], documents: [] };
const emptyDocuments = [];
const documentRenderBatchSize = 80;
const statusLabels = {
  pending: "\u7B49\u5F85\u5904\u7406",
  copying: "\u590D\u5236\u6587\u4EF6",
  converting: "\u8F6C\u6362 Markdown",
  extracting: "\u63D0\u53D6\u6761\u76EE",
  ready_for_matching: "\u5F85\u5339\u914D",
  matching: "\u5339\u914D\u6BB5\u843D",
  recovering: "\u8865\u6F0F\u4E2D",
  analyzing: "AI \u6574\u7406\u4E2D",
  saving: "\u4FDD\u5B58\u7ED3\u679C",
  success: "\u5B8C\u6210",
  error: "\u5931\u8D25"
};
let renderDebugSeq = 0;
const contentMetricKeys = [
  "chars",
  "lines",
  "htmlTags",
  "htmlTables",
  "htmlRows",
  "htmlCells",
  "markdownImages",
  "htmlImages",
  "importedAssets",
  "bareUrls",
  "markdownLinks"
];
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function roundMs(value) {
  return Math.round(value * 10) / 10;
}
function flattenFolderTree(folders) {
  const result = /* @__PURE__ */ new Map();
  function walk(list, parentId) {
    for (const folder of list) {
      result.set(folder.id, parentId);
      if (folder.children?.length) {
        walk(folder.children, folder.id);
      }
    }
  }
  walk(folders, null);
  return result;
}
function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}
function collectContentMetrics(content) {
  const text = String(content || "");
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
    markdownLinks: countMatches(text, /\[[^\]]{0,200}\]\([^)]{1,500}\)/g)
  };
}
function collectItemsContentMetrics(items) {
  const totals = Object.fromEntries(contentMetricKeys.map((key) => [key, 0]));
  let totalTitleChars = 0;
  let totalResumeChars = 0;
  let maxItemContentLength = 0;
  let maxItemId = "";
  let maxItemTitle = "";
  let itemsWithHtml = 0;
  let itemsWithTables = 0;
  let itemsWithImages = 0;
  let itemsWithImportedAssets = 0;
  let itemsWithBareUrls = 0;
  items.forEach((item) => {
    const content = String(item.content || "");
    const metrics2 = collectContentMetrics(content);
    contentMetricKeys.forEach((key) => {
      totals[key] += metrics2[key];
    });
    totalTitleChars += String(item.title || "").length;
    totalResumeChars += String(item.resume || "").length;
    if (metrics2.chars > maxItemContentLength) {
      maxItemContentLength = metrics2.chars;
      maxItemId = item.id;
      maxItemTitle = item.title;
    }
    if (metrics2.htmlTags) itemsWithHtml += 1;
    if (metrics2.htmlTables) itemsWithTables += 1;
    if (metrics2.markdownImages || metrics2.htmlImages) itemsWithImages += 1;
    if (metrics2.importedAssets) itemsWithImportedAssets += 1;
    if (metrics2.bareUrls) itemsWithBareUrls += 1;
  });
  const metrics = {
    ...totals,
    itemCount: items.length,
    totalTitleChars,
    totalResumeChars,
    maxItemContentLength,
    itemsWithHtml,
    itemsWithTables,
    itemsWithImages,
    itemsWithImportedAssets,
    itemsWithBareUrls
  };
  return {
    metrics,
    maxItemId,
    maxItemTitle
  };
}
function collectDomMetrics(element) {
  if (!element) return {};
  return {
    domNodes: element.querySelectorAll("*").length,
    tables: element.querySelectorAll("table").length,
    rows: element.querySelectorAll("tr").length,
    cells: element.querySelectorAll("td, th").length,
    images: element.querySelectorAll("img").length,
    links: element.querySelectorAll("a").length,
    textChars: element.textContent?.length || 0,
    htmlChars: element.innerHTML.length,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  };
}
function logRenderDebug(trace, event, payload = {}) {
  if (!trace || trace.finished) return;
  const entry = {
    traceId: trace.id,
    kind: trace.kind,
    event,
    elapsedMs: roundMs(nowMs() - trace.startedAt),
    documentId: trace.documentId,
    itemId: trace.itemId,
    ...payload
  };
  if (typeof window !== "undefined") {
    window.__knowledgeRenderDebugLogs = window.__knowledgeRenderDebugLogs || [];
    window.__knowledgeRenderDebugLogs.push(entry);
  }
  console.info("[knowledge-render-debug]", entry);
}
function startLongTaskObserver(trace) {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const task = {
          startMs: roundMs(entry.startTime - trace.startedAt),
          durationMs: roundMs(entry.duration),
          name: entry.name || "longtask"
        };
        trace.longTasks.push(task);
        logRenderDebug(trace, "longtask", task);
      });
    });
    observer.observe({ entryTypes: ["longtask"] });
    trace.longTaskObserver = observer;
  } catch (error) {
    logRenderDebug(trace, "longtask:observer-unavailable", { message: error instanceof Error ? error.message : String(error) });
  }
}
function createRenderDebugTrace(kind, document2, content, item) {
  const trace = {
    id: `${kind}-${Date.now()}-${++renderDebugSeq}`,
    kind,
    startedAt: nowMs(),
    documentId: document2.id,
    documentName: document2.file_name,
    itemId: item?.id,
    itemTitle: item?.title,
    contentLength: String(content || "").length,
    contentMetrics: collectContentMetrics(content),
    longTasks: []
  };
  startLongTaskObserver(trace);
  logRenderDebug(trace, "trace:start", {
    documentName: trace.documentName,
    itemTitle: trace.itemTitle,
    contentLength: trace.contentLength,
    metrics: trace.contentMetrics
  });
  console.table([{ traceId: trace.id, ...trace.contentMetrics }]);
  return trace;
}
function updateTraceContentMetrics(trace, content) {
  if (!trace || trace.finished) return;
  const metrics = collectContentMetrics(content);
  trace.contentLength = String(content || "").length;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, "content:metrics", {
    contentLength: trace.contentLength,
    metrics
  });
}
function updateTraceItemsMetrics(trace, items) {
  if (!trace || trace.finished) return;
  const { metrics, maxItemId, maxItemTitle } = collectItemsContentMetrics(items);
  trace.contentLength = metrics.chars;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, "items:metrics", {
    itemCount: items.length,
    contentLength: trace.contentLength,
    metrics,
    maxItemId,
    maxItemTitle
  });
}
function finishRenderDebugTrace(trace, reason, payload = {}) {
  if (!trace || trace.finished) return;
  logRenderDebug(trace, "trace:finish", {
    reason,
    totalMs: roundMs(nowMs() - trace.startedAt),
    longTaskCount: trace.longTasks.length,
    ...payload
  });
  if (trace.longTasks.length) {
    console.table(trace.longTasks.map((task) => ({ traceId: trace.id, ...task })));
  }
  trace.longTaskObserver?.disconnect();
  trace.finished = true;
}
function logProfilerRender(trace, profilerId, phase, actualDuration, baseDuration, startTime, commitTime) {
  logRenderDebug(trace, "react-profiler", {
    profilerId,
    phase,
    actualDurationMs: roundMs(actualDuration),
    baseDurationMs: roundMs(baseDuration),
    profilerStartMs: roundMs(startTime - (trace?.startedAt || 0)),
    profilerCommitMs: roundMs(commitTime - (trace?.startedAt || 0))
  });
}
function KnowledgeBasePage({ onSectionChange }) {
  const [index, setIndex] = useState(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerTrace, setViewerTrace] = useState(null);
  const [markdownPreview, setMarkdownPreview] = useState("");
  const [itemsPreview, setItemsPreview] = useState([]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState(null);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState(void 0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => /* @__PURE__ */ new Set());
  const [retryingDocumentIds, setRetryingDocumentIds] = useState(() => /* @__PURE__ */ new Set());
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const [dragPayload, setDragPayload] = useState(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState(null);
  const [documentDropTarget, setDocumentDropTarget] = useState(null);
  const [dragSaving, setDragSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [snippets, setSnippets] = useState([]);
  const [snippetEditor, setSnippetEditor] = useState(null);
  const [snippetEditorSaving, setSnippetEditorSaving] = useState(false);
  const autoMatchingIdsRef = useRef(/* @__PURE__ */ new Set());
  const documentParseNoticeIdsRef = useRef(/* @__PURE__ */ new Set());
  const viewerRequestIdRef = useRef(0);
  const viewerTraceRef = useRef(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];
  const documentsByFolder = useMemo(() => {
    const grouped = /* @__PURE__ */ new Map();
    index.documents.forEach((document2) => {
      const folderDocuments = grouped.get(document2.folder_id);
      if (folderDocuments) {
        folderDocuments.push(document2);
        return;
      }
      grouped.set(document2.folder_id, [document2]);
    });
    return grouped;
  }, [index.documents]);
  const documents = activeFolder ? documentsByFolder.get(activeFolder.id) || emptyDocuments : emptyDocuments;
  const visibleDocuments = documents.slice(0, Math.min(visibleDocumentCount, documents.length));
  useEffect(() => {
    trackPageView(viewer ? `knowledge-base/viewer/${viewer.mode}` : "knowledge-base/library");
  }, [viewer?.mode]);
  useEffect(() => {
    void loadInitialData();
    window.addEventListener("focus", loadDeveloperMode);
    document.addEventListener("visibilitychange", loadDeveloperMode);
    const unsubscribe = window.yibiao?.knowledgeBase.onEvent(({ document: document2 }) => {
      const parseMessage = document2.error || document2.message;
      if (document2.status === "error" && isLibreOfficeRequiredMessage(parseMessage) && !documentParseNoticeIdsRef.current.has(document2.id)) {
        documentParseNoticeIdsRef.current.add(document2.id);
        showDocumentParseNotice(parseMessage);
      }
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.some((item) => item.id === document2.id) ? prev.documents.map((item) => item.id === document2.id ? document2 : item) : [...prev.documents, document2]
      }));
      setViewer((prev) => prev?.document.id === document2.id ? { ...prev, document: document2 } : prev);
      setAnalysisSnapshot((prev) => prev?.document.id === document2.id ? { ...prev, document: document2 } : prev);
    });
    return () => {
      window.removeEventListener("focus", loadDeveloperMode);
      document.removeEventListener("visibilitychange", loadDeveloperMode);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    setVisibleDocumentCount(documentRenderBatchSize);
  }, [activeFolder?.id, documents.length]);
  useEffect(() => {
    if (visibleDocumentCount >= documents.length) return void 0;
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setVisibleDocumentCount((count) => Math.min(count + documentRenderBatchSize, documents.length));
      });
    }, 24);
    return () => window.clearTimeout(timeoutId);
  }, [documents.length, visibleDocumentCount]);
  useEffect(() => {
    if (viewer) return;
    if (!activeFolderId) {
      setSnippets([]);
      return void 0;
    }
    let cancelled = false;
    window.yibiao?.knowledgeBase.listSnippets(activeFolderId).then((result) => {
      if (!cancelled) setSnippets(Array.isArray(result) ? result : []);
    }).catch(() => {
      if (!cancelled) setSnippets([]);
    });
    return () => {
      cancelled = true;
    };
  }, [activeFolderId, viewer]);
  const reloadSnippets = async (folderId = activeFolderId) => {
    if (!folderId) return;
    try {
      const result = await window.yibiao?.knowledgeBase.listSnippets(folderId);
      setSnippets(Array.isArray(result) ? result : []);
    } catch {
    }
  };
  useEffect(() => {
    if (developerMode) return;
    const pendingDocuments = index.documents.filter((document2) => document2.status === "ready_for_matching" && !autoMatchingIdsRef.current.has(document2.id));
    pendingDocuments.forEach((document2) => {
      autoMatchingIdsRef.current.add(document2.id);
      void startMatching(document2, { silent: true });
    });
  }, [developerMode, index.documents]);
  useEffect(() => {
    if (!developerMode && viewer?.mode === "analysis") {
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
    if (viewer?.mode === "analysis") {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);
  const loadInitialData = async () => {
    try {
      setListLoading(true);
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
      const migrationStatus = await window.yibiao?.knowledgeBase.getMigrationStatus();
      let data;
      if (migrationStatus?.needsMigration) {
        setPendingMigrationStatus(migrationStatus);
        setMigrationDialogOpen(true);
        data = await window.yibiao?.knowledgeBase.list("document");
      } else {
        data = await window.yibiao?.knowledgeBase.list("document");
        if (migrationStatus?.cleanupPending) {
          showToast(migrationStatus.message || "\u65E7\u77E5\u8BC6\u5E93 JSON \u6E05\u7406\u672A\u5B8C\u6210\uFF0C\u5C06\u5728\u4E0B\u6B21\u8FDB\u5165\u65F6\u7EE7\u7EED\u5904\u7406", "info");
        }
      }
      if (data) {
        setIndex(data);
        setActiveFolderId((currentId) => data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || "");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u8BFB\u53D6\u77E5\u8BC6\u5E93\u5931\u8D25", "error");
    } finally {
      setLoading(false);
      setListLoading(false);
    }
  };
  const applyKnowledgeIndex = (data) => {
    setIndex(data);
    setActiveFolderId((currentId) => data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || "");
  };
  const clearDragState = () => {
    setDragPayload(null);
    setFolderDropTargetId(null);
    setDocumentDropTarget(null);
  };
  const getDropPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  const startFolderDrag = (event, folderId) => {
    if (dragSaving) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `folder:${folderId}`);
    setDragPayload({ kind: "folder", folderId });
  };
  const startDocumentDrag = (event, document2) => {
    if (dragSaving || !canMoveKnowledgeDocument(document2)) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `document:${document2.id}`);
    setDragPayload({ kind: "document", documentId: document2.id, folderId: document2.folder_id });
  };
  const handleFolderDragOver = (event, folderId) => {
    if (!dragPayload || dragSaving) return;
    if (dragPayload.kind === "folder" && dragPayload.folderId === folderId) return;
    if (dragPayload.kind === "document" && dragPayload.folderId === folderId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setFolderDropTargetId(folderId);
    setDocumentDropTarget(null);
  };
  const handleFolderDrop = async (event, folderId) => {
    if (!dragPayload || dragSaving) return;
    event.preventDefault();
    const payload = dragPayload;
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      let result;
      if (payload.kind === "folder") {
        const parentMap = flattenFolderTree(index.folders);
        const parentId = parentMap.get(payload.folderId) ?? void 0;
        result = await window.yibiao?.knowledgeBase.reorderFolder(payload.folderId, folderId, position, parentId);
      } else {
        result = await window.yibiao?.knowledgeBase.moveDocument(payload.documentId, folderId, null, "after");
      }
      if (!result?.success) {
        throw new Error(result?.message || "\u62D6\u62FD\u64CD\u4F5C\u5931\u8D25");
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error("\u62D6\u62FD\u64CD\u4F5C\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u8BFB\u53D6\u77E5\u8BC6\u5E93\u5217\u8868\u5931\u8D25");
      applyKnowledgeIndex(data);
      showToast(result.message, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u62D6\u62FD\u64CD\u4F5C\u5931\u8D25", "error");
    } finally {
      setDragSaving(false);
      clearDragState();
    }
  };
  const handleDocumentDragOver = (event, document2) => {
    if (!dragPayload || dragPayload.kind !== "document" || dragSaving || dragPayload.documentId === document2.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setFolderDropTargetId(null);
    setDocumentDropTarget({ documentId: document2.id, position: getDropPosition(event) });
  };
  const handleDocumentDrop = async (event, document2) => {
    if (!dragPayload || dragPayload.kind !== "document" || dragSaving || dragPayload.documentId === document2.id) return;
    event.preventDefault();
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      const result = await window.yibiao?.knowledgeBase.moveDocument(dragPayload.documentId, document2.folder_id, document2.id, position);
      if (!result?.success) {
        throw new Error(result?.message || "\u6587\u6863\u6392\u5E8F\u5931\u8D25");
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error("\u6587\u6863\u6392\u5E8F\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u8BFB\u53D6\u77E5\u8BC6\u5E93\u5217\u8868\u5931\u8D25");
      applyKnowledgeIndex(data);
      setActiveFolderId(document2.folder_id);
      showToast(result.message, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u6587\u6863\u6392\u5E8F\u5931\u8D25", "error");
    } finally {
      setDragSaving(false);
      clearDragState();
    }
  };
  const cancelMigration = () => {
    if (migrationRunning) return;
    setMigrationDialogOpen(false);
    setPendingMigrationStatus(null);
    showToast("\u5DF2\u6682\u7F13\u77E5\u8BC6\u5E93\u8FC1\u79FB\uFF0C\u4E0B\u6B21\u8FDB\u5165\u77E5\u8BC6\u5E93\u4F1A\u7EE7\u7EED\u63D0\u793A", "info");
  };
  const confirmMigration = async () => {
    if (migrationRunning) return;
    setMigrationRunning(true);
    setLoading(true);
    try {
      const result = await window.yibiao?.knowledgeBase.migrateLegacy();
      if (!result?.success) {
        throw new Error(result?.message || "\u77E5\u8BC6\u5E93\u8FC1\u79FB\u5931\u8D25");
      }
      const data = result.index || await window.yibiao?.knowledgeBase.list("document");
      if (!data) {
        throw new Error("\u77E5\u8BC6\u5E93\u8FC1\u79FB\u5B8C\u6210\uFF0C\u4F46\u8BFB\u53D6\u8FC1\u79FB\u7ED3\u679C\u5931\u8D25");
      }
      applyKnowledgeIndex(data);
      setPendingMigrationStatus(null);
      setMigrationDialogOpen(false);
      showToast(result.message || "\u77E5\u8BC6\u5E93\u8FC1\u79FB\u5B8C\u6210", result.cleanupPending ? "info" : "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u77E5\u8BC6\u5E93\u8FC1\u79FB\u5931\u8D25", "error");
    } finally {
      setMigrationRunning(false);
      setLoading(false);
    }
  };
  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn("\u8BFB\u53D6\u5F00\u53D1\u8005\u6A21\u5F0F\u5931\u8D25", error);
      setDeveloperMode(false);
    }
  };
  const loadAnalysis = async (documentId, options) => {
    try {
      const data = await window.yibiao?.knowledgeBase.readAnalysis(documentId);
      if (data) setAnalysisSnapshot(data);
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : "\u8BFB\u53D6\u5206\u6790\u7ED3\u679C\u5931\u8D25", "error");
      }
    }
  };
  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast("\u8BF7\u8F93\u5165\u6587\u4EF6\u5939\u540D\u79F0", "info");
      return;
    }
    try {
      setCreatingFolder(true);
      const folder = await window.yibiao?.knowledgeBase.createFolder(name.trim(), "document", newFolderParentId);
      if (!folder) return;
      const data = await window.yibiao?.knowledgeBase.list("document");
      if (data) applyKnowledgeIndex(data);
      if (newFolderParentId) {
        setExpandedFolderIds((prev) => /* @__PURE__ */ new Set([...prev, newFolderParentId]));
      }
      setNewFolderName("");
      setNewFolderParentId(void 0);
      setShowCreateFolder(false);
      showToast("\u6587\u4EF6\u5939\u5DF2\u521B\u5EFA", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u521B\u5EFA\u6587\u4EF6\u5939\u5931\u8D25", "error");
    } finally {
      setCreatingFolder(false);
    }
  };
  const uploadDocuments = async () => {
    if (!activeFolder) {
      showToast("\u8BF7\u5148\u521B\u5EFA\u6587\u4EF6\u5939", "info");
      return;
    }
    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.uploadDocuments(activeFolder.id);
      if (!result?.success) {
        const message = result?.message || "\u672A\u9009\u62E9\u6587\u6863";
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, "info");
        return;
      }
      if (result.documents?.length) {
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, result.documents || []) }));
      }
      showToast(result.message, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "\u4E0A\u4F20\u6587\u6863\u5931\u8D25";
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  };
  const reloadItemsPreview = async () => {
    if (!viewer) return;
    try {
      const items = await window.yibiao?.knowledgeBase.readItems(viewer.document.id);
      setItemsPreview(Array.isArray(items) ? items : []);
    } catch {
    }
  };
  const handleCreateItem = async (documentId, payload) => {
    if (!payload.title.trim() || !payload.content.trim()) {
      showToast("\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A", "error");
      return;
    }
    try {
      await window.yibiao?.knowledgeBase.createItem(documentId, payload);
      showToast("\u5DF2\u624B\u5DE5\u65B0\u589E\u77E5\u8BC6\u6761\u76EE", "success");
      await reloadItemsPreview();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u65B0\u589E\u6761\u76EE\u5931\u8D25", "error");
    }
  };
  const handleUpdateItem = async (documentId, itemId, payload) => {
    if (!payload.title.trim() || !payload.content.trim()) {
      showToast("\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A", "error");
      return;
    }
    try {
      await window.yibiao?.knowledgeBase.updateItem(documentId, itemId, payload);
      showToast("\u5DF2\u4FDD\u5B58\u77E5\u8BC6\u6761\u76EE", "success");
      await reloadItemsPreview();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u4FDD\u5B58\u6761\u76EE\u5931\u8D25", "error");
    }
  };
  const handleDeleteItem = async (documentId, itemId) => {
    try {
      const result = await window.yibiao?.knowledgeBase.deleteItem(documentId, itemId);
      showToast(result?.message || "\u5DF2\u5220\u9664\u77E5\u8BC6\u6761\u76EE", "success");
      await reloadItemsPreview();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u5220\u9664\u6761\u76EE\u5931\u8D25", "error");
    }
  };
  const handleCreateSnippet = async (payload) => {
    if (!payload.title.trim() || !payload.content.trim()) {
      showToast("\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A", "error");
      return;
    }
    setSnippetEditorSaving(true);
    try {
      await window.yibiao?.knowledgeBase.createSnippet(payload.folder_id, { title: payload.title, content: payload.content });
      showToast("\u5DF2\u65B0\u5EFA\u77E5\u8BC6\u7247\u6BB5", "success");
      setSnippetEditor(null);
      await reloadSnippets(payload.folder_id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u65B0\u5EFA\u7247\u6BB5\u5931\u8D25", "error");
    } finally {
      setSnippetEditorSaving(false);
    }
  };
  const handleUpdateSnippet = async (snippetId, folderId, payload) => {
    if (!payload.title.trim() || !payload.content.trim()) {
      showToast("\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A", "error");
      return;
    }
    setSnippetEditorSaving(true);
    try {
      await window.yibiao?.knowledgeBase.updateSnippet(snippetId, { title: payload.title, content: payload.content, folder_id: payload.folder_id });
      showToast("\u5DF2\u4FDD\u5B58\u77E5\u8BC6\u7247\u6BB5", "success");
      setSnippetEditor(null);
      await reloadSnippets(folderId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u4FDD\u5B58\u7247\u6BB5\u5931\u8D25", "error");
    } finally {
      setSnippetEditorSaving(false);
    }
  };
  const handleDeleteSnippet = async (snippet) => {
    try {
      const result = await window.yibiao?.knowledgeBase.deleteSnippet(snippet.id);
      showToast(result?.message || "\u5DF2\u5220\u9664\u77E5\u8BC6\u7247\u6BB5", "success");
      await reloadSnippets(snippet.folder_id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u5220\u9664\u7247\u6BB5\u5931\u8D25", "error");
    }
  };
  const renameFolder = async (folderId, currentName) => {
    const name = window.prompt("\u8BF7\u8F93\u5165\u65B0\u7684\u6587\u4EF6\u5939\u540D\u79F0", currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      const folder = await window.yibiao?.knowledgeBase.renameFolder(folderId, name);
      if (!folder) return;
      setIndex((prev) => ({
        ...prev,
        folders: prev.folders.map((item) => item.id === folder.id ? folder : item)
      }));
      showToast("\u6587\u4EF6\u5939\u5DF2\u91CD\u547D\u540D", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "\u91CD\u547D\u540D\u6587\u4EF6\u5939\u5931\u8D25", "error");
    }
  };
  const deleteFolder = (folderId, folderName) => {
    const count = documentsByFolder.get(folderId)?.length || 0;
    setDeleteConfirm({ type: "folder", folderId, folderName, count });
  };
  const deleteDocument = (document2) => {
    setDeleteConfirm({ type: "document", document: document2 });
  };
  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    setDeletingConfirm(true);
    try {
      if (deleteConfirm.type === "folder") {
        const { folderId } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
        const folders = index.folders.filter((item) => item.id !== folderId);
        const documents2 = index.documents.filter((document2) => document2.folder_id !== folderId);
        setIndex({ folders, documents: documents2 });
        if (activeFolderId === folderId) {
          setActiveFolderId(folders[0]?.id || "");
        }
        setViewer((prev) => prev?.document.folder_id === folderId ? null : prev);
        showToast(result?.message || "\u6587\u4EF6\u5939\u5DF2\u5220\u9664", "success");
      } else {
        const { document: document2 } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteDocument(document2.id);
        setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document2.id) }));
        setViewer((prev) => prev?.document.id === document2.id ? null : prev);
        showToast(result?.message || "\u6587\u6863\u5DF2\u5220\u9664", "success");
      }
      setDeleteConfirm(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : deleteConfirm.type === "folder" ? "\u5220\u9664\u6587\u4EF6\u5939\u5931\u8D25" : "\u5220\u9664\u6587\u6863\u5931\u8D25", "error");
    } finally {
      setDeletingConfirm(false);
    }
  };
  const retryDocument = async (document2) => {
    setRetryingDocumentIds((prev) => new Set(prev).add(document2.id));
    try {
      const result = await window.yibiao?.knowledgeBase.retryDocument(document2.id);
      if (result?.document) {
        const updatedDocument = result.document;
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, [updatedDocument]) }));
        setViewer((prev) => prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev);
        setAnalysisSnapshot((prev) => prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev);
      }
      if (!result?.success) {
        const message = result?.message || "\u91CD\u8BD5\u5931\u8D25";
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, "info");
        return;
      }
      showToast(result.message || "\u5DF2\u91CD\u65B0\u5F00\u59CB\u89E3\u6790", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "\u91CD\u8BD5\u5931\u8D25";
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, "error");
    } finally {
      setRetryingDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(document2.id);
        return next;
      });
    }
  };
  const finishActiveViewerTrace = (reason, payload = {}) => {
    finishRenderDebugTrace(viewerTraceRef.current, reason, payload);
    viewerTraceRef.current = null;
    setViewerTrace(null);
  };
  const createViewerTrace = (document2, mode, requestId) => {
    finishActiveViewerTrace("viewer-trace-replaced", { nextMode: mode, requestId });
    if (!developerMode || mode === "analysis") {
      return null;
    }
    const kind = mode === "markdown" ? "document-markdown" : "document-items";
    const trace = createRenderDebugTrace(kind, document2, "");
    viewerTraceRef.current = trace;
    setViewerTrace(trace);
    logRenderDebug(trace, "click:open-document", {
      mode,
      requestId,
      status: document2.status,
      itemCount: document2.item_count || 0,
      blockCount: document2.block_count || 0,
      filteredBlockCount: document2.filtered_block_count || 0,
      candidateItemCount: document2.candidate_item_count || 0
    });
    return trace;
  };
  const openDocument = async (document2, mode) => {
    if (mode === "analysis" && !developerMode) {
      return;
    }
    const requestId = viewerRequestIdRef.current + 1;
    viewerRequestIdRef.current = requestId;
    const trace = createViewerTrace(document2, mode, requestId);
    setViewerLoading(mode !== "analysis");
    logRenderDebug(trace, "state:loading-start", { loading: mode !== "analysis" });
    startTransition(() => {
      setViewer({ document: document2, mode });
      setMarkdownPreview("");
      setItemsPreview([]);
      if (mode === "analysis") {
        setAnalysisSnapshot(null);
      }
    });
    logRenderDebug(trace, "state:viewer-transition-scheduled", { mode });
    if (mode === "analysis") {
      await loadAnalysis(document2.id);
      return;
    }
    try {
      if (mode === "markdown") {
        const readStartedAt = nowMs();
        logRenderDebug(trace, "ipc:read:start", { api: "knowledgeBase.readMarkdown", requestId });
        const markdown = await window.yibiao?.knowledgeBase.readMarkdown(document2.id);
        const content = markdown || "";
        logRenderDebug(trace, "ipc:read:end", {
          api: "knowledgeBase.readMarkdown",
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          contentLength: content.length
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, "stale-read-result", { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceContentMetrics(trace, content);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, "state:set-markdown-preview", { contentLength: content.length });
          setMarkdownPreview(content);
        }
      } else {
        const readStartedAt = nowMs();
        logRenderDebug(trace, "ipc:read:start", { api: "knowledgeBase.readItems", requestId });
        const items = await window.yibiao?.knowledgeBase.readItems(document2.id);
        const nextItems = items || [];
        logRenderDebug(trace, "ipc:read:end", {
          api: "knowledgeBase.readItems",
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          itemCount: nextItems.length
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, "stale-read-result", { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceItemsMetrics(trace, nextItems);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, "state:set-items-preview", { itemCount: nextItems.length });
          setItemsPreview(nextItems);
        }
      }
    } catch (error) {
      if (viewerRequestIdRef.current === requestId) {
        logRenderDebug(trace, "ipc:read:error", { message: error instanceof Error ? error.message : String(error) });
        finishRenderDebugTrace(trace, "read-error");
        showToast(error instanceof Error ? error.message : "\u8BFB\u53D6\u6587\u6863\u7ED3\u679C\u5931\u8D25", "error");
      }
    } finally {
      if (viewerRequestIdRef.current === requestId) {
        setViewerLoading(false);
        logRenderDebug(trace, "state:loading-false");
      }
    }
  };
  const closeViewer = () => {
    viewerRequestIdRef.current += 1;
    finishActiveViewerTrace("viewer-closed");
    startTransition(() => {
      setViewer(null);
      setViewerLoading(false);
      setViewerTrace(null);
      setItemsPreview([]);
      setMarkdownPreview("");
      setAnalysisSnapshot(null);
    });
  };
  const startMatching = async (targetDocument = viewer?.document, options) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id);
      if (!options?.silent) {
        showToast(result?.message || "\u5DF2\u63D0\u4EA4\u5339\u914D\u4EFB\u52A1", result?.success ? "success" : "info");
      }
      if (developerMode) {
        await loadAnalysis(targetDocument.id, { silent: true });
      }
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : "\u542F\u52A8\u6BB5\u843D\u5339\u914D\u5931\u8D25", "error");
      }
    } finally {
      setStartingMatching(false);
    }
  };
  if (viewer) {
    return /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx(
      KnowledgeDocumentViewer,
      {
        document: viewer.document,
        mode: viewer.mode,
        itemsPreview,
        markdownPreview,
        analysisSnapshot,
        viewerLoading,
        viewerTrace,
        startingMatching,
        developerMode,
        onBack: closeViewer,
        onModeChange: (mode) => void openDocument(viewer.document, mode),
        onStartMatching: () => void startMatching(),
        onRefreshAnalysis: () => void loadAnalysis(viewer.document.id),
        onItemCreate: handleCreateItem,
        onItemUpdate: handleUpdateItem,
        onItemDelete: handleDeleteItem
      }
    ) });
  }
  const renderFolderTree = (folders, depth) => {
    return folders.map((folder) => {
      const isExpanded = expandedFolderIds.has(folder.id);
      const isLeaf = !folder.hasChildren;
      const count = documentsByFolder.get(folder.id)?.length || 0;
      const dragging = dragPayload?.kind === "folder" && dragPayload.folderId === folder.id;
      const dropTarget = folderDropTargetId === folder.id;
      const childCount = (folder.children || []).length;
      const toggleExpand = () => {
        setExpandedFolderIds((prev) => {
          const next = new Set(prev);
          if (next.has(folder.id)) next.delete(folder.id);
          else next.add(folder.id);
          return next;
        });
      };
      const startSubfolder = () => {
        setNewFolderParentId(folder.id);
        setNewFolderName("");
        setShowCreateFolder(true);
      };
      return /* @__PURE__ */ jsxs("div", { style: { marginLeft: depth * 16 }, children: [
        /* @__PURE__ */ jsxs(
          "article",
          {
            className: `knowledge-folder-card ${folder.id === activeFolder?.id ? "is-active" : ""}${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`,
            onDragOver: (event) => handleFolderDragOver(event, folder.id),
            onDrop: (event) => {
              void handleFolderDrop(event, folder.id);
            },
            children: [
              /* @__PURE__ */ jsxs("div", { className: "knowledge-folder-row", children: [
                !isLeaf && /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-folder-toggle", onClick: toggleExpand, "aria-label": isExpanded ? "\u6298\u53E0" : "\u5C55\u5F00", children: isExpanded ? "\u25BC" : "\u25B6" }),
                isLeaf && /* @__PURE__ */ jsx("span", { className: "knowledge-folder-toggle" }),
                /* @__PURE__ */ jsx(
                  "span",
                  {
                    className: "knowledge-drag-handle",
                    draggable: !migrationRunning && !dragSaving,
                    onDragStart: (event) => startFolderDrag(event, folder.id),
                    onDragEnd: clearDragState,
                    title: "\u62D6\u62FD\u6392\u5E8F",
                    "aria-hidden": "true",
                    children: "\u22EE\u22EE"
                  }
                ),
                /* @__PURE__ */ jsxs("button", { type: "button", className: "knowledge-folder-main", onClick: () => {
                  if (isLeaf) startTransition(() => setActiveFolderId(folder.id));
                }, disabled: migrationRunning || !isLeaf, children: [
                  /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: isLeaf ? "F" : "\u{1F4C1}" }),
                  /* @__PURE__ */ jsx("strong", { children: folder.name }),
                  /* @__PURE__ */ jsx("small", { children: dropTarget && dragPayload?.kind === "document" ? "\u677E\u5F00\u79FB\u52A8\u5230\u6B64\u6587\u4EF6\u5939" : isLeaf ? `${count} \u4E2A\u6587\u6863` : `${childCount} \u4E2A\u5B50\u6587\u4EF6\u5939` })
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "knowledge-folder-actions", children: [
                /* @__PURE__ */ jsx("button", { type: "button", onClick: startSubfolder, disabled: migrationRunning, children: "\u65B0\u5EFA\u5B50\u6587\u4EF6\u5939" }),
                /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void renameFolder(folder.id, folder.name), disabled: migrationRunning, children: "\u91CD\u547D\u540D" }),
                /* @__PURE__ */ jsx("button", { type: "button", className: "is-danger", onClick: () => void deleteFolder(folder.id, folder.name), disabled: migrationRunning, children: "\u5220\u9664" })
              ] })
            ]
          }
        ),
        isExpanded && folder.children && folder.children.length > 0 && renderFolderTree(folder.children, depth + 1)
      ] }, folder.id);
    });
  };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("div", { className: "page-stack knowledge-page", children: [
      /* @__PURE__ */ jsxs("section", { className: "knowledge-workspace-bar", children: [
        /* @__PURE__ */ jsxs("div", { className: "knowledge-breadcrumb", children: [
          /* @__PURE__ */ jsx("span", { children: "\u77E5\u8BC6\u5E93" }),
          /* @__PURE__ */ jsx("strong", { children: activeFolder?.name || "\u672A\u9009\u62E9\u6587\u4EF6\u5939" }),
          /* @__PURE__ */ jsxs("small", { children: [
            index.folders.length,
            " \u4E2A\u6587\u4EF6\u5939 / ",
            index.documents.length,
            " \u4E2A\u6587\u6863"
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "knowledge-toolbar-actions", children: [
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => onSectionChange("knowledge-base"), children: "\u8FD4\u56DE\u77E5\u8BC6\u5E93" }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => setShowCreateFolder((value) => !value), disabled: listLoading, children: "\u65B0\u5EFA\u6587\u4EF6\u5939" }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: uploadDocuments, disabled: loading || !activeFolder, children: loading ? "\u5904\u7406\u4E2D..." : "\u4E0A\u4F20\u6587\u6863" })
        ] })
      ] }),
      showCreateFolder && /* @__PURE__ */ jsxs(
        "form",
        {
          className: "knowledge-create-folder-bar",
          onSubmit: (event) => {
            event.preventDefault();
            void createFolder();
          },
          children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                autoFocus: true,
                value: newFolderName,
                onChange: (event) => setNewFolderName(event.target.value),
                placeholder: "\u8F93\u5165\u6587\u4EF6\u5939\u540D\u79F0"
              }
            ),
            /* @__PURE__ */ jsx("button", { type: "submit", className: "primary-action", disabled: creatingFolder, children: creatingFolder ? "\u521B\u5EFA\u4E2D..." : "\u521B\u5EFA" }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "secondary-action",
                onClick: () => {
                  setNewFolderName("");
                  setShowCreateFolder(false);
                },
                children: "\u53D6\u6D88"
              }
            )
          ]
        }
      ),
      /* @__PURE__ */ jsxs("section", { className: "knowledge-layout", children: [
        /* @__PURE__ */ jsxs("aside", { className: "knowledge-folder-panel", children: [
          /* @__PURE__ */ jsxs("div", { className: "knowledge-panel-head", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u6587\u4EF6\u5939" }),
            /* @__PURE__ */ jsxs("span", { children: [
              index.folders.length,
              " \u4E2A"
            ] })
          ] }),
          listLoading ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6\u77E5\u8BC6\u5E93..." }),
            /* @__PURE__ */ jsx("p", { children: "\u8BF7\u7A0D\u5019\uFF0C\u6B63\u5728\u52A0\u8F7D\u6587\u4EF6\u5939\u548C\u6587\u6863\u5217\u8868\u3002" })
          ] }) : index.folders.length ? /* @__PURE__ */ jsx("div", { className: "knowledge-folder-list", children: index.folders.map((folder) => {
            const count = documentsByFolder.get(folder.id)?.length || 0;
            const dragging = dragPayload?.kind === "folder" && dragPayload.folderId === folder.id;
            const dropTarget = folderDropTargetId === folder.id;
            return /* @__PURE__ */ jsxs(
              "article",
              {
                className: `knowledge-folder-card ${folder.id === activeFolder?.id ? "is-active" : ""}${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`,
                onDragOver: (event) => handleFolderDragOver(event, folder.id),
                onDrop: (event) => {
                  void handleFolderDrop(event, folder.id);
                },
                children: [
                  /* @__PURE__ */ jsxs("div", { className: "knowledge-folder-row", children: [
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: "knowledge-drag-handle",
                        draggable: !dragSaving,
                        onDragStart: (event) => startFolderDrag(event, folder.id),
                        onDragEnd: clearDragState,
                        title: "\u62D6\u62FD\u6392\u5E8F",
                        "aria-hidden": "true",
                        children: "\u22EE\u22EE"
                      }
                    ),
                    /* @__PURE__ */ jsxs("button", { type: "button", className: "knowledge-folder-main", onClick: () => startTransition(() => setActiveFolderId(folder.id)), children: [
                      /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "F" }),
                      /* @__PURE__ */ jsx("strong", { children: folder.name }),
                      /* @__PURE__ */ jsx("small", { children: dropTarget && dragPayload?.kind === "document" ? "\u677E\u5F00\u79FB\u52A8\u5230\u6B64\u6587\u4EF6\u5939" : `${count} \u4E2A\u6587\u6863` })
                    ] })
                  ] }),
                  /* @__PURE__ */ jsxs("div", { className: "knowledge-folder-actions", children: [
                    /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void renameFolder(folder.id, folder.name), children: "\u91CD\u547D\u540D" }),
                    /* @__PURE__ */ jsx("button", { type: "button", className: "is-danger", onClick: () => void deleteFolder(folder.id, folder.name), children: "\u5220\u9664" })
                  ] })
                ]
              },
              folder.id
            );
          }) }) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u8FD8\u6CA1\u6709\u6587\u4EF6\u5939" }),
            /* @__PURE__ */ jsx("p", { children: "\u5148\u521B\u5EFA\u4E00\u4E2A\u6587\u4EF6\u5939\uFF0C\u518D\u4E0A\u4F20\u5386\u53F2\u8D44\u6599\u3002" }),
            /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: () => setShowCreateFolder(true), children: "\u65B0\u5EFA\u6587\u4EF6\u5939" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("main", { className: "knowledge-document-panel", children: [
          /* @__PURE__ */ jsxs("div", { className: "knowledge-panel-head", children: [
            /* @__PURE__ */ jsx("strong", { children: activeFolder?.name || "\u672A\u9009\u62E9\u6587\u4EF6\u5939" }),
            /* @__PURE__ */ jsxs("span", { children: [
              documents.length,
              " \u4E2A\u6587\u6863"
            ] })
          ] }),
          listLoading ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box large", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6\u77E5\u8BC6\u5E93..." }),
            /* @__PURE__ */ jsx("p", { children: "\u6587\u6863\u5217\u8868\u52A0\u8F7D\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u663E\u793A\u3002" })
          ] }) : documents.length ? /* @__PURE__ */ jsxs("div", { className: "knowledge-document-list", children: [
            visibleDocuments.map((document2) => {
              const retrying = retryingDocumentIds.has(document2.id);
              const canDragDocument = canMoveKnowledgeDocument(document2) && !dragSaving;
              const dragging = dragPayload?.kind === "document" && dragPayload.documentId === document2.id;
              const dropTarget = documentDropTarget?.documentId === document2.id ? ` is-drop-${documentDropTarget.position}` : "";
              return /* @__PURE__ */ jsxs(
                "article",
                {
                  className: `knowledge-document-card${dragging ? " is-dragging" : ""}${dropTarget}`,
                  onDragOver: (event) => handleDocumentDragOver(event, document2),
                  onDrop: (event) => {
                    void handleDocumentDrop(event, document2);
                  },
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "knowledge-document-title", children: [
                      /* @__PURE__ */ jsxs("div", { className: "knowledge-document-title-main", children: [
                        /* @__PURE__ */ jsx(
                          "span",
                          {
                            className: "knowledge-drag-handle",
                            draggable: canDragDocument,
                            onDragStart: (event) => startDocumentDrag(event, document2),
                            onDragEnd: clearDragState,
                            title: canDragDocument ? "\u62D6\u62FD\u6392\u5E8F\u6216\u79FB\u52A8\u5230\u6587\u4EF6\u5939" : "\u5904\u7406\u4E2D\uFF0C\u6682\u4E0D\u53EF\u62D6\u52A8",
                            "aria-hidden": "true",
                            children: "\u22EE\u22EE"
                          }
                        ),
                        /* @__PURE__ */ jsxs("div", { className: "knowledge-document-name", children: [
                          /* @__PURE__ */ jsx("strong", { children: document2.file_name }),
                          developerMode && /* @__PURE__ */ jsxs("code", { className: "knowledge-entity-id", children: [
                            "\u6587\u6863ID\uFF1A",
                            document2.id
                          ] })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsx("span", { className: `knowledge-status is-${document2.status}`, children: statusLabels[document2.status] })
                    ] }),
                    /* @__PURE__ */ jsx(ProgressBar, { value: document2.progress || 0, label: `\u5904\u7406\u8FDB\u5EA6 ${document2.progress}%` }),
                    /* @__PURE__ */ jsxs("div", { className: "knowledge-document-meta", children: [
                      /* @__PURE__ */ jsx("span", { children: document2.message }),
                      /* @__PURE__ */ jsxs("span", { children: [
                        document2.item_count || 0,
                        " \u6761\u77E5\u8BC6"
                      ] }),
                      /* @__PURE__ */ jsxs("span", { children: [
                        document2.candidate_item_count || 0,
                        " \u4E2A\u5019\u9009"
                      ] }),
                      /* @__PURE__ */ jsxs("span", { children: [
                        document2.block_count || 0,
                        " \u4E2A block"
                      ] })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "knowledge-document-actions", children: [
                      developerMode && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void openDocument(document2, "analysis"), disabled: !canOpenAnalysis(document2), children: "\u5206\u6790\u8C03\u8BD5" }),
                      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void openDocument(document2, "items"), disabled: document2.status !== "success", children: "\u67E5\u770B\u6761\u76EE" }),
                      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void openDocument(document2, "markdown"), disabled: !canOpenMarkdown(document2), children: "\u67E5\u770B Markdown" }),
                      document2.status === "error" && /* @__PURE__ */ jsx("button", { type: "button", className: "is-retry", onClick: () => void retryDocument(document2), disabled: retrying, children: retrying ? "\u91CD\u8BD5\u4E2D..." : "\u91CD\u8BD5" }),
                      /* @__PURE__ */ jsx("button", { type: "button", className: "is-danger", onClick: () => void deleteDocument(document2), children: "\u5220\u9664" })
                    ] })
                  ]
                },
                document2.id
              );
            }),
            visibleDocuments.length < documents.length && /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
              /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u66F4\u591A\u6587\u6863..." }),
              /* @__PURE__ */ jsxs("p", { children: [
                "\u5DF2\u663E\u793A ",
                visibleDocuments.length,
                " / ",
                documents.length,
                " \u4E2A\u6587\u6863\u3002"
              ] })
            ] })
          ] }) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box large", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u5F53\u524D\u6587\u4EF6\u5939\u6682\u65E0\u6587\u6863" }),
            /* @__PURE__ */ jsx("p", { children: "\u652F\u6301\u4E0A\u4F20 .doc\u3001.docx\u3001.wps\u3001.pdf\u3001.md\u3001.xls\u3001.xlsx \u6587\u6863\u3002" }),
            /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: uploadDocuments, disabled: loading || !activeFolder, children: loading ? "\u5904\u7406\u4E2D..." : "\u4E0A\u4F20\u6587\u6863" })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "knowledge-panel-head knowledge-snippet-head", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u7247\u6BB5" }),
            /* @__PURE__ */ jsxs("span", { children: [
              snippets.length,
              " \u4E2A"
            ] }),
            /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: () => setSnippetEditor({ mode: "create" }), disabled: !activeFolder || migrationRunning, children: "\u65B0\u5EFA\u7247\u6BB5" })
          ] }),
          listLoading ? /* @__PURE__ */ jsx("div", { className: "knowledge-empty-box", children: /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6\u7247\u6BB5..." }) }) : snippets.length ? /* @__PURE__ */ jsx("div", { className: "knowledge-snippet-list", children: snippets.map((snippet) => /* @__PURE__ */ jsxs("article", { className: "knowledge-snippet-card", children: [
            developerMode && /* @__PURE__ */ jsxs("code", { className: "knowledge-entity-id", children: [
              "\u7247\u6BB5ID\uFF1A",
              snippet.id
            ] }),
            /* @__PURE__ */ jsx("strong", { children: snippet.title }),
            /* @__PURE__ */ jsx("p", { children: snippet.content.replace(/[#>*`\-\s]+/g, " ").trim().slice(0, 80) || "\uFF08\u7A7A\u5185\u5BB9\uFF09" }),
            /* @__PURE__ */ jsxs("div", { className: "knowledge-item-actions", children: [
              /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-item-edit-action", onClick: () => setSnippetEditor({ mode: "edit", snippet }), disabled: migrationRunning, children: "\u7F16\u8F91" }),
              /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-item-delete-action is-danger", onClick: () => void handleDeleteSnippet(snippet), disabled: migrationRunning, children: "\u5220\u9664" })
            ] })
          ] }, snippet.id)) }) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
            /* @__PURE__ */ jsx("strong", { children: "\u8BE5\u6587\u4EF6\u5939\u6682\u65E0\u7247\u6BB5" }),
            /* @__PURE__ */ jsx("p", { children: "\u70B9\u51FB\u300C\u65B0\u5EFA\u7247\u6BB5\u300D\u6DFB\u52A0\u53EF\u590D\u7528\u7684\u5185\u5BB9\uFF0C\u751F\u6210\u6807\u4E66\u65F6\u53EF\u88AB\u5F15\u7528\u3002" })
          ] })
        ] })
      ] })
    ] }),
    migrationDialog
  ] });
}
function KnowledgeMigrationDialog({ open, status, running, onCancel, onConfirm }) {
  const { total, completed, skipped } = getMigrationCounts(status);
  return /* @__PURE__ */ jsx(Dialog.Root, { open, onOpenChange: (nextOpen) => !nextOpen && onCancel(), children: /* @__PURE__ */ jsxs(Dialog.Portal, { children: [
    /* @__PURE__ */ jsx(Dialog.Overlay, { className: "content-regenerate-modal" }),
    /* @__PURE__ */ jsxs(Dialog.Content, { className: "knowledge-migration-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "knowledge-migration-head", children: [
        /* @__PURE__ */ jsx("span", { className: "section-kicker", children: "\u6570\u636E\u8FC1\u79FB" }),
        /* @__PURE__ */ jsx(Dialog.Title, { children: "\u77E5\u8BC6\u5E93\u6570\u636E\u8FC1\u79FB" }),
        /* @__PURE__ */ jsx(Dialog.Description, { children: "\u77E5\u8BC6\u5E93\u5DF2\u5347\u7EA7\u4E3A\u672C\u5730\u6570\u636E\u5E93\u7BA1\u7406\uFF0C\u8BFB\u5199\u66F4\u9AD8\u6548\uFF0C\u5927\u91CF\u77E5\u8BC6\u5E93\u4E5F\u4E0D\u5361" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "knowledge-migration-body", children: [
        /* @__PURE__ */ jsxs("section", { className: `knowledge-migration-warning${skipped ? " is-warning" : ""}`, children: [
          /* @__PURE__ */ jsx("strong", { children: "\u8FC1\u79FB\u89C4\u5219" }),
          /* @__PURE__ */ jsx("p", { children: "\u672C\u6B21\u53EA\u8FC1\u79FB\u72B6\u6001\u4E3A\u201C\u5DF2\u5B8C\u6210\u201D\u7684\u6587\u6863\uFF1B\u672A\u5B8C\u6210\u6216\u5904\u7406\u4E2D\u7684\u6587\u6863\u4F1A\u88AB\u4E22\u5F03\uFF0C\u4E0D\u4F1A\u8FC1\u79FB\u5230\u65B0\u7248\u672C\u77E5\u8BC6\u5E93\u3002" })
        ] }),
        /* @__PURE__ */ jsxs("section", { className: "knowledge-migration-lead", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u8FDB\u884C\u4E2D\u6587\u6863\u5904\u7406\u65B9\u5F0F" }),
          /* @__PURE__ */ jsx("p", { children: "\u5982\u679C\u65E7\u7248\u77E5\u8BC6\u5E93\u91CC\u8FD8\u6709\u672A\u5904\u7406\u5B8C\u6210\u7684\u6587\u6863\uFF0C\u8BF7\u5148\u91CD\u65B0\u5B89\u88C5v2.4\u7248\u672C\uFF0C\u5C06\u6240\u6709\u77E5\u8BC6\u5E93\u6587\u6863\u89E3\u6790\u4E3A\u201C\u5DF2\u5B8C\u6210\u201D\u72B6\u6001\u540E\uFF0C\u518D\u66F4\u65B0\u81F3v2.5\u4EE5\u4E0A\u7248\u672C\u6267\u884C\u8FC1\u79FB\u3002" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "knowledge-migration-stats", "aria-label": "\u65E7\u77E5\u8BC6\u5E93\u8FC1\u79FB\u7EDF\u8BA1", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("span", { children: "\u65E7\u6587\u6863\u603B\u6570" }),
            /* @__PURE__ */ jsx("strong", { children: total })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("span", { children: "\u53EF\u8FC1\u79FB\uFF1A\u5DF2\u5B8C\u6210" }),
            /* @__PURE__ */ jsx("strong", { children: completed })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: skipped ? "is-warning" : "", children: [
            /* @__PURE__ */ jsx("span", { children: "\u5C06\u8DF3\u8FC7\uFF1A\u672A\u5B8C\u6210/\u5904\u7406\u4E2D" }),
            /* @__PURE__ */ jsx("strong", { children: skipped })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "content-regenerate-actions knowledge-migration-actions", children: [
        /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onCancel, disabled: running, children: "\u6682\u4E0D\u8FC1\u79FB" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: onConfirm, disabled: running, children: running ? "\u8FC1\u79FB\u4E2D..." : "\u5F00\u59CB\u8FC1\u79FB" })
      ] })
    ] })
  ] }) });
}
function KnowledgeDocumentViewer({
  document: document2,
  mode,
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
  onItemCreate,
  onItemUpdate,
  onItemDelete
}) {
  const { showToast } = useToast();
  const [itemEditor, setItemEditor] = useState(null);
  const [itemEditorSaving, setItemEditorSaving] = useState(false);
  const [sourceItem, setSourceItem] = useState(null);
  const [sourceRendering, setSourceRendering] = useState(false);
  const [sourceTrace, setSourceTrace] = useState(null);
  const renderRequestIdRef = useRef(0);
  const sourceTraceRef = useRef(null);
  useEffect(() => {
    finishRenderDebugTrace(sourceTraceRef.current, "viewer-reset");
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
    renderRequestIdRef.current += 1;
  }, [document2.id, mode]);
  const openSourceItem = (item) => {
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    finishRenderDebugTrace(sourceTraceRef.current, "source-trace-replaced");
    const trace = developerMode ? createRenderDebugTrace("item-source", document2, item.content || "", item) : null;
    sourceTraceRef.current = trace;
    setSourceItem(item);
    setSourceRendering(true);
    setSourceTrace(trace);
    logRenderDebug(trace, "click:open-source");
    window.requestAnimationFrame(() => {
      if (renderRequestIdRef.current === requestId) {
        logRenderDebug(trace, "raf:release-markdown-render");
        setSourceRendering(false);
      }
    });
  };
  const closeSourceItem = () => {
    renderRequestIdRef.current += 1;
    finishRenderDebugTrace(sourceTraceRef.current, "source-view-closed");
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
  };
  const copyDebugLogs = async () => {
    const logs = window.__knowledgeRenderDebugLogs || [];
    if (!logs.length) {
      showToast("\u6682\u65E0\u6E32\u67D3\u8C03\u8BD5\u65E5\u5FD7", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      showToast(`\u6E32\u67D3\u8C03\u8BD5\u65E5\u5FD7\u5DF2\u590D\u5236\uFF08${logs.length} \u6761\uFF09`, "success");
    } catch (error) {
      console.warn("\u590D\u5236\u6E32\u67D3\u8C03\u8BD5\u65E5\u5FD7\u5931\u8D25", error);
      showToast("\u590D\u5236\u8C03\u8BD5\u65E5\u5FD7\u5931\u8D25", "error");
    }
  };
  return /* @__PURE__ */ jsxs("div", { className: "page-stack knowledge-viewer-page", children: [
    /* @__PURE__ */ jsxs("section", { className: "knowledge-workspace-bar knowledge-viewer-bar", children: [
      /* @__PURE__ */ jsxs("div", { className: "knowledge-breadcrumb", children: [
        /* @__PURE__ */ jsx("span", { children: "\u77E5\u8BC6\u5E93" }),
        /* @__PURE__ */ jsx("strong", { children: document2.file_name }),
        developerMode && /* @__PURE__ */ jsxs("code", { className: "knowledge-entity-id", children: [
          "\u6587\u6863ID\uFF1A",
          document2.id
        ] }),
        /* @__PURE__ */ jsx("small", { children: mode === "analysis" ? "\u5206\u6790\u8C03\u8BD5" : mode === "items" ? `${document2.item_count || 0} \u6761\u77E5\u8BC6` : "Markdown \u539F\u6587" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "knowledge-toolbar-actions", children: [
        /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onBack, children: "\u8FD4\u56DE\u77E5\u8BC6\u5E93" }),
        developerMode && /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => void copyDebugLogs(), children: "\u590D\u5236\u8C03\u8BD5\u65E5\u5FD7" }),
        developerMode && /* @__PURE__ */ jsx("button", { type: "button", className: `secondary-action ${mode === "analysis" ? "is-active" : ""}`, onClick: () => onModeChange("analysis"), children: "\u5206\u6790\u8C03\u8BD5" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: `secondary-action ${mode === "items" ? "is-active" : ""}`, onClick: () => onModeChange("items"), disabled: document2.status !== "success", children: "\u77E5\u8BC6\u6761\u76EE" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: `secondary-action ${mode === "markdown" ? "is-active" : ""}`, onClick: () => onModeChange("markdown"), disabled: !canOpenMarkdown(document2), children: "Markdown" }),
        mode === "items" && /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: () => setItemEditor({ mode: "create" }), disabled: document2.status !== "success", children: "\u624B\u5DE5\u65B0\u589E\u6761\u76EE" })
      ] })
    ] }),
    /* @__PURE__ */ jsx("section", { className: "knowledge-viewer-panel", children: mode === "analysis" && developerMode ? /* @__PURE__ */ jsx(
      KnowledgeAnalysisView,
      {
        document: document2,
        snapshot: analysisSnapshot,
        startingMatching,
        onStartMatching,
        onRefresh: onRefreshAnalysis
      }
    ) : mode === "items" ? viewerLoading ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
      /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6\u77E5\u8BC6\u6761\u76EE..." }),
      /* @__PURE__ */ jsx("p", { children: "\u6761\u76EE\u8F83\u591A\u65F6\u9700\u8981\u7A0D\u7B49\u7247\u523B\u3002" })
    ] }) : /* @__PURE__ */ jsx(
      DebuggableMarkdownContent,
      {
        className: "knowledge-item-list knowledge-viewer-item-list",
        debugTrace: mode === "items" ? viewerTrace : null,
        developerMode,
        profilerId: "knowledge-items-list",
        children: itemsPreview.length ? itemsPreview.map((item) => /* @__PURE__ */ jsx(
          KnowledgeItemCard,
          {
            item,
            developerMode,
            onOpenSource: () => openSourceItem(item),
            onEdit: () => setItemEditor({ mode: "edit", item }),
            onDelete: () => void onItemDelete(document2.id, item.id)
          },
          item.id
        )) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u6682\u65E0\u77E5\u8BC6\u6761\u76EE" }),
          /* @__PURE__ */ jsx("p", { children: "\u6587\u6863\u5B8C\u6210\u6574\u7406\u540E\u4F1A\u663E\u793A\u7ED3\u679C\uFF0C\u4E5F\u53EF\u70B9\u51FB\u300C\u624B\u5DE5\u65B0\u589E\u6761\u76EE\u300D\u8865\u5145\u3002" })
        ] })
      }
    ) : /* @__PURE__ */ jsx(
      MarkdownFullscreenViewer,
      {
        className: "markdown-viewer knowledge-viewer-markdown",
        title: `${document2.file_name}\u5168\u5C4F\u67E5\u770B`,
        fullscreenChildren: viewerLoading ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box large", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6 Markdown..." }),
          /* @__PURE__ */ jsx("p", { children: "\u539F\u6587\u5185\u5BB9\u8F83\u5927\u65F6\u9700\u8981\u7A0D\u7B49\u7247\u523B\u3002" })
        ] }) : /* @__PURE__ */ jsx(MarkdownRenderer, { children: markdownPreview || "\u6682\u65E0 Markdown \u5185\u5BB9" }),
        children: viewerLoading ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box large", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6 Markdown..." }),
          /* @__PURE__ */ jsx("p", { children: "\u539F\u6587\u5185\u5BB9\u8F83\u5927\u65F6\u9700\u8981\u7A0D\u7B49\u7247\u523B\u3002" })
        ] }) : /* @__PURE__ */ jsx(
          DebuggableMarkdownContent,
          {
            className: "knowledge-markdown-debug-content",
            debugTrace: mode === "markdown" ? viewerTrace : null,
            developerMode,
            profilerId: "knowledge-document-markdown",
            children: /* @__PURE__ */ jsx(MarkdownRenderer, { children: markdownPreview || "\u6682\u65E0 Markdown \u5185\u5BB9" })
          }
        )
      }
    ) }),
    /* @__PURE__ */ jsx(Dialog.Root, { open: Boolean(sourceItem), onOpenChange: (open) => !open && closeSourceItem(), children: /* @__PURE__ */ jsxs(Dialog.Portal, { children: [
      /* @__PURE__ */ jsx(Dialog.Overlay, { className: "knowledge-source-modal" }),
      sourceItem && /* @__PURE__ */ jsx(
        KnowledgeItemSourceDialog,
        {
          item: sourceItem,
          developerMode,
          rendering: sourceRendering,
          debugTrace: sourceTrace,
          onClose: closeSourceItem
        }
      )
    ] }) }),
    /* @__PURE__ */ jsx(Dialog.Root, { open: Boolean(itemEditor), onOpenChange: (open) => !open && setItemEditor(null), children: /* @__PURE__ */ jsxs(Dialog.Portal, { children: [
      /* @__PURE__ */ jsx(Dialog.Overlay, { className: "knowledge-source-modal" }),
      itemEditor && /* @__PURE__ */ jsx(
        KnowledgeItemEditorDialog,
        {
          documentId: document2.id,
          item: itemEditor.mode === "edit" ? itemEditor.item : null,
          saving: itemEditorSaving,
          onCancel: () => setItemEditor(null),
          onCreate: (payload) => void (async () => {
            setItemEditorSaving(true);
            try {
              await onItemCreate(document2.id, payload);
              setItemEditor(null);
            } finally {
              setItemEditorSaving(false);
            }
          })(),
          onUpdate: (itemId, payload) => void (async () => {
            setItemEditorSaving(true);
            try {
              await onItemUpdate(document2.id, itemId, payload);
              setItemEditor(null);
            } finally {
              setItemEditorSaving(false);
            }
          })()
        }
      )
    ] }) })
  ] });
}
function KnowledgeItemCard({ item, developerMode, onOpenSource, onEdit, onDelete }) {
  const isManual = item.source === "manual";
  return /* @__PURE__ */ jsxs("article", { className: `knowledge-item-card${isManual ? " is-manual" : ""}`, children: [
    developerMode && /* @__PURE__ */ jsxs("code", { className: "knowledge-entity-id", children: [
      "\u6761\u76EEID\uFF1A",
      item.id
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-item-head", children: [
      /* @__PURE__ */ jsx("strong", { children: item.title }),
      isManual && /* @__PURE__ */ jsx("span", { className: "knowledge-item-tag", children: "\u624B\u5DE5" })
    ] }),
    /* @__PURE__ */ jsx("p", { children: item.resume }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-item-actions", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-item-source-action", onClick: onOpenSource, children: "\u67E5\u770B\u539F\u6587" }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-item-edit-action", onClick: onEdit, children: "\u7F16\u8F91" }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "knowledge-item-delete-action is-danger", onClick: onDelete, children: "\u5220\u9664" })
    ] })
  ] });
}
function KnowledgeItemSourceDialog({ item, developerMode, rendering, debugTrace, onClose }) {
  useLayoutEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return;
    logRenderDebug(debugTrace, "loading:commit");
  }, [debugTrace, developerMode, rendering]);
  useEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return void 0;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, "loading:next-frame-visible");
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode, rendering]);
  return /* @__PURE__ */ jsxs(Dialog.Content, { className: "knowledge-source-dialog-card knowledge-source-viewer", children: [
    /* @__PURE__ */ jsxs("div", { className: "knowledge-source-head", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "\u77E5\u8BC6\u6761\u76EE\u539F\u6587" }),
        /* @__PURE__ */ jsx(Dialog.Title, { children: item.title }),
        /* @__PURE__ */ jsx(Dialog.Description, { children: "\u67E5\u770B\u8BE5\u77E5\u8BC6\u6761\u76EE\u5BF9\u5E94\u7684\u539F\u59CB Markdown \u7247\u6BB5\u3002" }),
        developerMode && /* @__PURE__ */ jsxs("code", { className: "knowledge-entity-id", children: [
          "\u6761\u76EEID\uFF1A",
          item.id
        ] })
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onClose, children: "\u5173\u95ED" })
    ] }),
    rendering ? /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box large knowledge-source-loading", children: [
      /* @__PURE__ */ jsx(InlineSpinner, {}),
      /* @__PURE__ */ jsx("strong", { children: "\u6B63\u5728\u6E32\u67D3\u539F\u6587..." }),
      /* @__PURE__ */ jsx("p", { children: "\u5185\u5BB9\u8F83\u5927\u65F6\u9700\u8981\u7A0D\u7B49\u7247\u523B\u3002" })
    ] }) : /* @__PURE__ */ jsx(
      MarkdownFullscreenViewer,
      {
        className: "markdown-viewer knowledge-source-content",
        title: `${item.title}\u539F\u6587\u5168\u5C4F\u67E5\u770B`,
        fullscreenChildren: /* @__PURE__ */ jsx(MarkdownRenderer, { enableGfm: false, linkMode: "text", linkTextClassName: "knowledge-item-link-text", imageMode: "lazy", children: item.content || "\u6682\u65E0\u539F\u6587\u5185\u5BB9" }),
        children: /* @__PURE__ */ jsx(
          DebuggableMarkdownContent,
          {
            className: "knowledge-source-debug-content",
            debugTrace,
            developerMode,
            profilerId: "knowledge-item-source",
            children: /* @__PURE__ */ jsx(MarkdownRenderer, { enableGfm: false, linkMode: "text", linkTextClassName: "knowledge-item-link-text", imageMode: "lazy", children: item.content || "\u6682\u65E0\u539F\u6587\u5185\u5BB9" })
          }
        )
      }
    )
  ] });
}
function KnowledgeItemEditorDialog({ item, saving, onCancel, onCreate, onUpdate }) {
  const isEdit = Boolean(item);
  const [title, setTitle] = useState(item?.title || "");
  const [resume, setResume] = useState(item?.resume || "");
  const [content, setContent] = useState(item?.content || "");
  const [tableEditorOpen, setTableEditorOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editorRef = useRef(null);
  const handleInsertImage = (markdown) => {
    editorRef.current?.insertAtCursor(markdown);
    setPickerOpen(false);
  };
  const submit = () => {
    const payload = { title: title.trim(), resume: resume.trim(), content };
    if (!payload.title || !payload.content) return;
    if (isEdit && item) {
      onUpdate(item.id, payload);
    } else {
      onCreate(payload);
    }
  };
  return /* @__PURE__ */ jsxs(Dialog.Content, { className: "knowledge-source-dialog-card knowledge-editor-dialog", children: [
    /* @__PURE__ */ jsxs("div", { className: "knowledge-source-head", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "\u77E5\u8BC6\u6761\u76EE" }),
        /* @__PURE__ */ jsx(Dialog.Title, { children: isEdit ? "\u7F16\u8F91\u77E5\u8BC6\u6761\u76EE" : "\u624B\u5DE5\u65B0\u589E\u77E5\u8BC6\u6761\u76EE" }),
        /* @__PURE__ */ jsx(Dialog.Description, { children: "\u6807\u9898\u3001\u6458\u8981\u4E0E\u6B63\u6587\u5747\u652F\u6301\u624B\u5DE5\u7F16\u8F91\uFF0C\u6B63\u6587\u4F7F\u7528 Markdown\u3002" })
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onCancel, disabled: saving, children: "\u53D6\u6D88" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-body", children: [
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u6807\u9898" }),
        /* @__PURE__ */ jsx("input", { value: title, onChange: (event) => setTitle(event.target.value), placeholder: "\u8F93\u5165\u77E5\u8BC6\u6761\u76EE\u6807\u9898", disabled: saving })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u6458\u8981" }),
        /* @__PURE__ */ jsx("textarea", { value: resume, onChange: (event) => setResume(event.target.value), placeholder: "\u8F93\u5165\u4E00\u53E5\u8BDD\u6458\u8981", rows: 2, disabled: saving })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u6B63\u6587\uFF08Markdown\uFF09" }),
        /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-tools", children: [
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => setTableEditorOpen(true), disabled: saving, children: "\u53EF\u89C6\u5316\u8868\u683C\u7F16\u8F91" }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => setPickerOpen(true), disabled: saving, children: "\u63D2\u5165\u56FE\u7247" })
        ] }),
        /* @__PURE__ */ jsx(MarkdownEditor, { ref: editorRef, value: content, onChange: setContent, placeholder: "\u8F93\u5165\u77E5\u8BC6\u6761\u76EE\u6B63\u6587\uFF0C\u652F\u6301 Markdown", disabled: saving })
      ] }),
      /* @__PURE__ */ jsx(
        TableEditorDialog,
        {
          open: tableEditorOpen,
          value: content,
          onCancel: () => setTableEditorOpen(false),
          onConfirm: (next) => {
            setContent(next);
            setTableEditorOpen(false);
          }
        }
      ),
      /* @__PURE__ */ jsx(ImagePickerDialog, { open: pickerOpen, onCancel: () => setPickerOpen(false), onSelect: handleInsertImage })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-actions", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onCancel, disabled: saving, children: "\u53D6\u6D88" }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: submit, disabled: saving || !title.trim() || !content.trim(), children: saving ? "\u4FDD\u5B58\u4E2D..." : "\u4FDD\u5B58" })
    ] })
  ] });
}
function KnowledgeSnippetEditorDialog({ snippet, folders, defaultFolderId, saving, onCancel, onCreate, onUpdate }) {
  const isEdit = Boolean(snippet);
  const [title, setTitle] = useState(snippet?.title || "");
  const [content, setContent] = useState(snippet?.content || "");
  const [folderId, setFolderId] = useState(snippet?.folder_id || defaultFolderId);
  const [tableEditorOpen, setTableEditorOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editorRef = useRef(null);
  const handleInsertImage = (markdown) => {
    editorRef.current?.insertAtCursor(markdown);
    setPickerOpen(false);
  };
  const submit = () => {
    const payload = { title: title.trim(), content, folder_id: folderId };
    if (!payload.title || !payload.content) return;
    if (isEdit && snippet) {
      onUpdate(snippet.id, payload);
    } else {
      onCreate(payload);
    }
  };
  return /* @__PURE__ */ jsxs(Dialog.Content, { className: "knowledge-source-dialog-card knowledge-editor-dialog", children: [
    /* @__PURE__ */ jsxs("div", { className: "knowledge-source-head", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "\u77E5\u8BC6\u7247\u6BB5" }),
        /* @__PURE__ */ jsx(Dialog.Title, { children: isEdit ? "\u7F16\u8F91\u77E5\u8BC6\u7247\u6BB5" : "\u65B0\u5EFA\u77E5\u8BC6\u7247\u6BB5" }),
        /* @__PURE__ */ jsx(Dialog.Description, { children: "\u7247\u6BB5\u662F\u5F52\u5165\u6587\u4EF6\u5939\u7684\u53EF\u590D\u7528\u5185\u5BB9\uFF0C\u53EF\u5728\u6280\u672F\u65B9\u6848\u5F15\u7528\u65F6\u52FE\u9009\u3002" })
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onCancel, disabled: saving, children: "\u53D6\u6D88" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-body", children: [
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u6807\u9898" }),
        /* @__PURE__ */ jsx("input", { value: title, onChange: (event) => setTitle(event.target.value), placeholder: "\u8F93\u5165\u7247\u6BB5\u6807\u9898", disabled: saving })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u6240\u5C5E\u6587\u4EF6\u5939" }),
        /* @__PURE__ */ jsx("select", { value: folderId, onChange: (event) => setFolderId(event.target.value), disabled: saving || !folders.length, children: folders.map((folder) => /* @__PURE__ */ jsx("option", { value: folder.id, children: folder.name }, folder.id)) })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "knowledge-field", children: [
        /* @__PURE__ */ jsx("span", { children: "\u5185\u5BB9\uFF08Markdown\uFF09" }),
        /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-tools", children: [
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => setTableEditorOpen(true), disabled: saving, children: "\u53EF\u89C6\u5316\u8868\u683C\u7F16\u8F91" }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: () => setPickerOpen(true), disabled: saving, children: "\u63D2\u5165\u56FE\u7247" })
        ] }),
        /* @__PURE__ */ jsx(MarkdownEditor, { ref: editorRef, value: content, onChange: setContent, placeholder: "\u8F93\u5165\u7247\u6BB5\u5185\u5BB9\uFF0C\u652F\u6301 Markdown", disabled: saving })
      ] }),
      /* @__PURE__ */ jsx(
        TableEditorDialog,
        {
          open: tableEditorOpen,
          value: content,
          onCancel: () => setTableEditorOpen(false),
          onConfirm: (next) => {
            setContent(next);
            setTableEditorOpen(false);
          }
        }
      ),
      /* @__PURE__ */ jsx(ImagePickerDialog, { open: pickerOpen, onCancel: () => setPickerOpen(false), onSelect: handleInsertImage })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-editor-actions", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onCancel, disabled: saving, children: "\u53D6\u6D88" }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: submit, disabled: saving || !title.trim() || !content.trim() || !folderId, children: saving ? "\u4FDD\u5B58\u4E2D..." : "\u4FDD\u5B58" })
    ] })
  ] });
}
function DebuggableMarkdownContent({ children, className, debugTrace, developerMode, profilerId }) {
  const contentRef = useRef(null);
  useLayoutEffect(() => {
    if (!developerMode || !debugTrace) return;
    logRenderDebug(debugTrace, "dom:commit", collectDomMetrics(contentRef.current));
  });
  useEffect(() => {
    if (!developerMode || !debugTrace) return void 0;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, "dom:next-frame-visible", collectDomMetrics(contentRef.current));
      finishRenderDebugTrace(debugTrace, "next-frame-visible");
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode]);
  const content = /* @__PURE__ */ jsx("div", { ref: contentRef, className, children });
  if (!developerMode || !debugTrace) return content;
  return /* @__PURE__ */ jsx(
    Profiler,
    {
      id: profilerId,
      onRender: (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        logProfilerRender(debugTrace, id, phase, actualDuration, baseDuration, startTime, commitTime);
      },
      children: content
    }
  );
}
function KnowledgeAnalysisView({ document: document2, snapshot, startingMatching, onStartMatching, onRefresh }) {
  const report = snapshot?.report;
  const canStart = ["ready_for_matching", "success", "error"].includes(document2.status) && Boolean(snapshot?.candidate_items.length);
  return /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-view", children: [
    /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-command", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("strong", { children: "\u81EA\u52A8\u5206\u6BB5\u6BB5\u843D\u5339\u914D" }),
        /* @__PURE__ */ jsx("p", { children: "\u6309\u6A21\u578B\u4E0A\u4E0B\u6587\u957F\u5EA6\u81EA\u52A8\u5206\u6BB5\u5339\u914D\u6BB5\u843D\uFF0C\u5E76\u5728\u5339\u914D\u540E\u6267\u884C\u9057\u6F0F\u8865\u6F0F\u3002" })
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "primary-action", onClick: onStartMatching, disabled: !canStart || startingMatching, children: startingMatching ? "\u63D0\u4EA4\u4E2D..." : document2.status === "success" ? "\u91CD\u65B0\u5339\u914D" : "\u5F00\u59CB\u5339\u914D" }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "secondary-action", onClick: onRefresh, children: "\u5237\u65B0" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-stats", children: [
      /* @__PURE__ */ jsx(StatCard, { label: "\u6709\u6548 block", value: snapshot?.block_count ?? document2.block_count ?? 0 }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u7B5B\u9664 block", value: snapshot?.filtered_blocks_count ?? document2.filtered_block_count ?? 0 }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u5019\u9009\u6761\u76EE", value: snapshot?.candidate_items.length ?? document2.candidate_item_count ?? 0 }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u6700\u7EC8\u6761\u76EE", value: report?.final_items_count ?? document2.item_count ?? 0 }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u8986\u76D6\u7387", value: report ? `${Math.round(report.coverage_rate * 100)}%` : "-" }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u8865\u6F0F\u65B0\u589E", value: report?.new_items_from_recovery_count ?? 0 }),
      /* @__PURE__ */ jsx(StatCard, { label: "Markdown \u5B57\u7B26", value: formatInteger(snapshot?.markdown_chars) }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u4FDD\u7559 block \u5B57\u7B26", value: formatInteger(snapshot?.kept_block_chars) }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u6761\u76EE\u8986\u76D6\u5B57\u7B26", value: formatInteger(snapshot?.covered_unique_content_chars) }),
      /* @__PURE__ */ jsx(StatCard, { label: "\u539F\u6587\u771F\u5B9E\u8986\u76D6\u7387", value: formatPercent(snapshot?.coverage_rate_vs_markdown) })
    ] }),
    report && /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-report", children: [
      /* @__PURE__ */ jsx("strong", { children: "\u5904\u7406\u62A5\u544A" }),
      /* @__PURE__ */ jsxs("span", { children: [
        "\u5DF2\u5339\u914D ",
        report.matched_blocks_count,
        " \u4E2A block"
      ] }),
      /* @__PURE__ */ jsxs("span", { children: [
        "AI \u820D\u5F03 ",
        report.discarded_blocks_count,
        " \u4E2A block"
      ] }),
      /* @__PURE__ */ jsxs("span", { children: [
        "\u91CD\u8BD5\u540E\u7CFB\u7EDF\u820D\u5F03 ",
        report.system_discarded_after_retry_count,
        " \u4E2A block"
      ] }),
      /* @__PURE__ */ jsxs("span", { children: [
        "\u8865\u6F0F\u8F6E\u6B21 ",
        report.recovery_attempt_count
      ] }),
      /* @__PURE__ */ jsxs("span", { children: [
        "block \u6BB5\u6570 ",
        report.batch_size
      ] })
    ] }),
    snapshot?.debug_log_path && /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-debug-log", children: [
      /* @__PURE__ */ jsx("strong", { children: "\u5F00\u53D1\u8005\u65E5\u5FD7" }),
      /* @__PURE__ */ jsx("code", { children: snapshot.debug_log_path })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "knowledge-analysis-grid", children: [
      /* @__PURE__ */ jsxs("section", { className: "knowledge-analysis-section", children: [
        /* @__PURE__ */ jsxs("div", { className: "knowledge-panel-head", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u5019\u9009\u77E5\u8BC6\u6761\u76EE" }),
          /* @__PURE__ */ jsxs("span", { children: [
            snapshot?.candidate_items.length || 0,
            " \u6761"
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "knowledge-candidate-list", children: snapshot?.candidate_items.length ? snapshot.candidate_items.map((item) => /* @__PURE__ */ jsxs("article", { className: "knowledge-candidate-card", children: [
          /* @__PURE__ */ jsx("small", { children: item.id }),
          /* @__PURE__ */ jsx("strong", { children: item.title }),
          /* @__PURE__ */ jsx("p", { children: item.summary })
        ] }, item.id)) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u6682\u65E0\u5019\u9009\u6761\u76EE" }),
          /* @__PURE__ */ jsx("p", { children: "\u4E0A\u4F20\u5904\u7406\u5B8C\u6210\u540E\u4F1A\u663E\u793A AI \u63D0\u53D6\u51FA\u7684\u77E5\u8BC6\u6761\u76EE\u3002" })
        ] }) })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "knowledge-analysis-section", children: [
        /* @__PURE__ */ jsxs("div", { className: "knowledge-panel-head", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u820D\u5F03\u8BB0\u5F55" }),
          /* @__PURE__ */ jsxs("span", { children: [
            (snapshot?.discarded.length || 0) + (snapshot?.system_discarded_after_retry.length || 0),
            " \u7EC4"
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "knowledge-candidate-list", children: snapshot && (snapshot.discarded.length || snapshot.system_discarded_after_retry.length) ? [...snapshot.discarded, ...snapshot.system_discarded_after_retry].map((item, index) => /* @__PURE__ */ jsxs("article", { className: "knowledge-candidate-card", children: [
          /* @__PURE__ */ jsxs("small", { children: [
            item.block_ids.length,
            " \u4E2A block"
          ] }),
          /* @__PURE__ */ jsx("strong", { children: item.reason }),
          /* @__PURE__ */ jsx("p", { children: item.block_ids.join("\u3001") })
        ] }, `${item.reason}-${index}`)) : /* @__PURE__ */ jsxs("div", { className: "knowledge-empty-box", children: [
          /* @__PURE__ */ jsx("strong", { children: "\u6682\u65E0\u820D\u5F03\u8BB0\u5F55" }),
          /* @__PURE__ */ jsx("p", { children: "\u5B8C\u6210\u6BB5\u843D\u5339\u914D\u548C\u8865\u6F0F\u540E\u4F1A\u663E\u793A\u3002" })
        ] }) })
      ] })
    ] })
  ] });
}
function formatInteger(value) {
  return typeof value === "number" ? value.toLocaleString("zh-CN") : "-";
}
function formatPercent(value) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "-";
}
function StatCard({ label, value }) {
  return /* @__PURE__ */ jsxs("div", { className: "knowledge-stat-card", children: [
    /* @__PURE__ */ jsx("span", { children: label }),
    /* @__PURE__ */ jsx("strong", { children: value })
  ] });
}
function canOpenAnalysis(document2) {
  return !["pending", "copying", "converting", "extracting"].includes(document2.status);
}
function canOpenMarkdown(document2) {
  return !["pending", "copying"].includes(document2.status);
}
function canMoveKnowledgeDocument(document2) {
  return ["ready_for_matching", "success", "error"].includes(document2.status);
}
function mergeDocuments(prev, next) {
  const byId = new Map(prev.map((document2) => [document2.id, document2]));
  next.forEach((document2) => byId.set(document2.id, document2));
  return Array.from(byId.values());
}
export default KnowledgeBasePage;
