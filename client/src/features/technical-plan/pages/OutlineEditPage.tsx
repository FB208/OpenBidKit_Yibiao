import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { useToast } from '../../../shared/ui';
import type { BackgroundTaskState, SaveOutlineRequest, TechnicalPlanWorkflowKind } from '../types';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../knowledge-base/types';
import type { OutlineData, OutlineExpansionMode, OutlineItem } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';

interface OutlineEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  projectOverview: string;
  techRequirements: string;
  outlineExpansionMode: OutlineExpansionMode;
  referenceKnowledgeDocumentIds: string[];
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentTaskStatus?: BackgroundTaskState['status'];
  onOutlineConfigChange: (config: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode: OutlineExpansionMode }) => void;
  onOutlineSaved: (request: SaveOutlineRequest) => Promise<void>;
  onSortGuardChange?: (guard: OutlineSortGuard | null) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface RenumberResult {
  outline: OutlineItem[];
  idMap: Record<string, string>;
}

interface OutlineLocation {
  parentId: string | null;
  level: number;
  index: number;
}

interface DropTargetState {
  itemId: string;
  position: 'before' | 'after';
  valid: boolean;
}

const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录，不再调用评分项对齐和知识库补目录。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];

function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) {
      collectOutlineIds(item.children, ids);
    }
  });
  return ids;
}

function collectRootIds(items: OutlineItem[]) {
  return new Set(items.map((item) => item.id));
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renumberOutlineItemsWithIdMap(items: OutlineItem[], parentPrefix = ''): RenumberResult {
  const idMap: Record<string, string> = {};
  const outline = items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const childResult = item.children?.length ? renumberOutlineItemsWithIdMap(item.children, id) : null;
    idMap[item.id] = id;
    if (childResult) {
      Object.assign(idMap, childResult.idMap);
    }
    return {
      ...item,
      id,
      children: childResult?.outline,
    };
  });

  return { outline, idMap };
}

function createIdentityIdMap(items: OutlineItem[], idMap: Record<string, string> = {}) {
  items.forEach((item) => {
    idMap[item.id] = item.id;
    if (item.children?.length) {
      createIdentityIdMap(item.children, idMap);
    }
  });
  return idMap;
}

function composeIdMap(baseMap: Record<string, string>, stepMap: Record<string, string>) {
  return Object.fromEntries(Object.entries(baseMap).map(([oldId, currentId]) => [oldId, stepMap[currentId] || currentId]));
}

function findOutlineLocation(items: OutlineItem[], itemId: string, parentId: string | null = null, level = 0): OutlineLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === itemId) {
      return { parentId, level, index };
    }
    if (item.children?.length) {
      const child = findOutlineLocation(item.children, itemId, item.id, level + 1);
      if (child) return child;
    }
  }
  return null;
}

function reorderSiblingItems(items: OutlineItem[], draggedId: string, targetId: string, position: 'before' | 'after') {
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.findIndex((item) => item.id === targetId);
  const insertIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
  next.splice(insertIndex, 0, dragged);
  return next;
}

function reorderOutlineSiblings(items: OutlineItem[], parentId: string | null, draggedId: string, targetId: string, position: 'before' | 'after'): OutlineItem[] {
  if (parentId === null) {
    return reorderSiblingItems(items, draggedId, targetId, position);
  }

  return items.map((item) => {
    if (item.id === parentId) {
      return {
        ...item,
        children: reorderSiblingItems(item.children || [], draggedId, targetId, position),
      };
    }
    return item.children?.length
      ? { ...item, children: reorderOutlineSiblings(item.children, parentId, draggedId, targetId, position) }
      : item;
  });
}

function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return updater(item);
    }

    return {
      ...item,
      children: item.children ? updateOutlineItem(item.children, itemId, updater) : undefined,
    };
  });
}

function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => {
    if (item.id === itemId) {
      return [];
    }

    return [{
      ...item,
      children: item.children ? deleteOutlineItem(item.children, itemId) : undefined,
    }];
  });
}

function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) {
      return child;
    }
  }
  return null;
}

function getInitialExpandedKnowledgeFolders(index: KnowledgeBaseIndex) {
  const firstAvailableFolder = index.folders.find((folder) => (
    index.documents.some((document) => document.folder_id === folder.id && document.status === 'success')
  ));
  return new Set(firstAvailableFolder ? [firstAvailableFolder.id] : []);
}

function includesKeyword(value: string, keyword: string) {
  return value.toLowerCase().includes(keyword);
}

function OutlineEditPage({
  workflowKind,
  projectOverview,
  techRequirements,
  outlineExpansionMode,
  referenceKnowledgeDocumentIds,
  outlineData,
  task,
  contentTaskStatus,
  onOutlineConfigChange,
  onOutlineSaved,
  onSortGuardChange,
}: OutlineEditPageProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftOutlineExpansionMode, setDraftOutlineExpansionMode] = useState<OutlineExpansionMode>(outlineExpansionMode);
  const [draftKnowledgeDocumentIds, setDraftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [expandedKnowledgeFolderIds, setExpandedKnowledgeFolderIds] = useState<Set<string>>(new Set());
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [sorting, setSorting] = useState(false);
  const [draftOutlineData, setDraftOutlineData] = useState<OutlineData | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [sortDirty, setSortDirty] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const sortIdMapRef = useRef<Record<string, string>>({});
  const { showToast } = useToast();
  const activeOutlineData = sorting ? draftOutlineData : outlineData;
  const selectedItem = activeOutlineData && selectedItemId ? findOutlineItem(activeOutlineData.outline, selectedItemId) : null;
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const generating = startingOutline || taskRunning;
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const knowledgeDisabledByMode = isExpansionWorkflow && draftOutlineExpansionMode === 'original-only';
  const knowledgePickingDisabled = generating || knowledgeDisabledByMode;
  const contentMutationLocked = contentTaskStatus === 'running' || contentTaskStatus === 'pausing' || contentTaskStatus === 'paused';
  const outlineMutationLocked = generating || contentMutationLocked || savingSort;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = generating ? '运行中' : taskFailed ? '失败' : outlineData ? '已完成' : '未开始';
  const aiStatusTitle = generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (!cancelled && cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeOutlineData?.outline?.length) {
      const validIds = collectOutlineIds(activeOutlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size || sorting ? next : collectRootIds(activeOutlineData.outline);
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : activeOutlineData.outline[0]?.id || null));
      return;
    }

    setExpandedItems(new Set());
    setSelectedItemId(null);
  }, [activeOutlineData]);

  useEffect(() => {
    if (task?.status) {
      setStartingOutline(false);
      if (task.status !== 'running') {
        setLocalStartAt(null);
      }
    }
  }, [task?.status]);

  useEffect(() => {
    if (!generating) {
      return;
    }

    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  useEffect(() => {
    if (!generationDialogOpen) {
      return;
    }

    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    setKnowledgeSearch('');
    void loadKnowledgeIndex();
  }, [generationDialogOpen, isExpansionWorkflow, outlineExpansionMode, referenceKnowledgeDocumentIds]);

  const loadKnowledgeIndex = async () => {
    try {
      setLoadingKnowledge(true);
      const data = await window.yibiao?.knowledgeBase.list();
      setKnowledgeIndex(data || emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(getInitialExpandedKnowledgeFolders(data || emptyKnowledgeIndex));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
      setKnowledgeIndex(emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(new Set());
    } finally {
      setLoadingKnowledge(false);
    }
  };

  const openGenerationDialog = () => {
    if (sorting) {
      showToast('请先保存当前目录排序', 'info');
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    setKnowledgeSearch('');
    setGenerationDialogOpen(true);
  };

  const saveOutlineConfig = () => {
    onOutlineConfigChange({
      referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
      outlineExpansionMode: isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement',
    });
    setGenerationDialogOpen(false);
    showToast('目录生成配置已保存', 'success');
  };

  const generateOutline = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    try {
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      const nextOutlineExpansionMode = isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement';
      onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineExpansionMode: nextOutlineExpansionMode,
      });
      setGenerationDialogOpen(false);
      await window.yibiao?.tasks.startOutlineGeneration({
        reference_knowledge_document_ids: draftKnowledgeDocumentIds,
        outline_expansion_mode: nextOutlineExpansionMode,
      });
      trackConfigUsage({ outline_mode: isExpansionWorkflow ? nextOutlineExpansionMode : 'aligned' });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const toggleDraftKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || knowledgePickingDisabled) {
      return;
    }

    setDraftKnowledgeDocumentIds((prev) => (
      prev.includes(document.id)
        ? prev.filter((id) => id !== document.id)
        : [...prev, document.id]
    ));
  };

  const toggleKnowledgeFolder = (folderId: string) => {
    setExpandedKnowledgeFolderIds((prev) => (prev.has(folderId) ? new Set() : new Set([folderId])));
  };

  const selectFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (knowledgePickingDisabled) {
      return;
    }
    const ids = documents.filter((document) => document.status === 'success').map((document) => document.id);
    setDraftKnowledgeDocumentIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  };

  const clearFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (knowledgePickingDisabled) {
      return;
    }
    const ids = new Set(documents.map((document) => document.id));
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => !ids.has(id)));
  };

  const removeDraftKnowledgeDocument = (documentId: string) => {
    if (knowledgePickingDisabled) {
      return;
    }
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => id !== documentId));
  };

  const clearDraftKnowledgeDocuments = () => {
    if (knowledgePickingDisabled) {
      return;
    }
    setDraftKnowledgeDocumentIds([]);
  };

  const getMutationLockMessage = () => {
    if (generating) return '目录生成任务正在运行，当前目录暂不可编辑';
    if (contentMutationLocked) return '正文生成任务正在运行或暂停中，请结束后再调整目录';
    return '';
  };

  const saveOutlineChange = async (outline: OutlineItem[], reason: SaveOutlineRequest['reason'], affectedNodeIds: string[] = []) => {
    if (!outlineData) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    const renumbered = renumberOutlineItemsWithIdMap(outline);
    await onOutlineSaved({
      outlineData: { ...outlineData, outline: renumbered.outline },
      reason,
      idMap: renumbered.idMap,
      affectedNodeIds,
    });
  };

  const startEditing = (item: OutlineItem) => {
    if (sorting || outlineMutationLocked) {
      return;
    }
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const saveEditing = async () => {
    if (!outlineData || !editingItemId || sorting || outlineMutationLocked) {
      return;
    }

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
        ...item,
        title: editTitle.trim() || item.title,
        description: editDescription.trim(),
      })), 'edit', [editingItemId]);
      setEditingItemId(null);
      showToast('目录项已更新，相关正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录项失败', 'error');
    }
  };

  const addRootItem = async () => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const newItem: OutlineItem = {
      id: `${outlineData.outline.length + 1}`,
      title: '新目录项',
      description: '请编辑描述',
    };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], 'add-root');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('一级目录已添加', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加一级目录失败', 'error');
    }
  };

  const addChildItem = async (parentId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = {
      id: `${parentId}.${nextIndex}`,
      title: '新目录项',
      description: '请编辑描述',
    };

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, parentId, (item) => ({
        ...item,
        children: [...(item.children || []), newItem],
      })), 'add-child', [parentId]);
      setExpandedItems((prev) => new Set(prev).add(parentId));
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('子目录已添加，父目录正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加子目录失败', 'error');
    }
  };

  const removeItem = async (itemId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }
    try {
      const removedItem = findOutlineItem(outlineData.outline, itemId);
      const removedIds = removedItem ? [...collectOutlineIds([removedItem])] : [itemId];
      const nextOutline = deleteOutlineItem(outlineData.outline, itemId);
      if (!nextOutline.length) {
        showToast('至少保留一个目录项', 'info');
        return;
      }
      await saveOutlineChange(nextOutline, 'delete', removedIds);
      setSelectedItemId(null);
      showToast('目录项已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除目录项失败', 'error');
    }
  };

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const expandAllItems = () => {
    if (activeOutlineData?.outline?.length) {
      setExpandedItems(collectOutlineIds(activeOutlineData.outline));
    }
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };

  const startSorting = () => {
    if (!outlineData?.outline?.length) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    setDraftOutlineData(outlineData);
    sortIdMapRef.current = createIdentityIdMap(outlineData.outline);
    setSorting(true);
    setSortDirty(false);
    setEditingItemId(null);
    setDraggingItemId(null);
    setDropTarget(null);
    showToast('仅支持同级目录排序；拖动只在前端调整，点击保存排序后才会写入数据库。', 'info');
  };

  const discardSorting = () => {
    setSorting(false);
    setDraftOutlineData(null);
    setSortDirty(false);
    setSavingSort(false);
    setDraggingItemId(null);
    setDropTarget(null);
    sortIdMapRef.current = {};
  };

  const saveSorting = async () => {
    if (!draftOutlineData?.outline?.length) {
      discardSorting();
      return;
    }
    if (!sortDirty) {
      discardSorting();
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }

    setSavingSort(true);
    try {
      await onOutlineSaved({
        outlineData: draftOutlineData,
        reason: 'sort',
        idMap: sortIdMapRef.current,
      });
      discardSorting();
      showToast('目录排序已保存', 'success');
    } finally {
      setSavingSort(false);
    }
  };

  useEffect(() => {
    if (!onSortGuardChange) return;
    onSortGuardChange({
      hasUnsavedSort: () => sorting && sortDirty,
      saveSort: saveSorting,
      discardSort: discardSorting,
    });
    return () => onSortGuardChange(null);
  }, [onSortGuardChange, sorting, sortDirty, draftOutlineData]);

  const getDropPosition = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const canDropOnTarget = (draggedId: string, targetId: string) => {
    if (!activeOutlineData?.outline?.length || draggedId === targetId) return false;
    const dragged = findOutlineLocation(activeOutlineData.outline, draggedId);
    const target = findOutlineLocation(activeOutlineData.outline, targetId);
    return Boolean(dragged && target && dragged.parentId === target.parentId && dragged.level === target.level);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting) {
      return;
    }
    setDraggingItemId(item.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting || !draggingItemId) {
      return;
    }
    event.preventDefault();
    const valid = canDropOnTarget(draggingItemId, item.id);
    event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    setDropTarget({ itemId: item.id, position: getDropPosition(event), valid });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    event.preventDefault();
    if (!sorting || !draftOutlineData?.outline?.length || !draggingItemId) {
      return;
    }

    const valid = canDropOnTarget(draggingItemId, item.id);
    if (!valid) {
      setDraggingItemId(null);
      setDropTarget(null);
      showToast('只能同级目录排序', 'info');
      return;
    }

    const sourceLocation = findOutlineLocation(draftOutlineData.outline, draggingItemId);
    if (!sourceLocation) {
      setDraggingItemId(null);
      setDropTarget(null);
      return;
    }

    const position = dropTarget?.itemId === item.id ? dropTarget.position : getDropPosition(event);
    const reordered = reorderOutlineSiblings(draftOutlineData.outline, sourceLocation.parentId, draggingItemId, item.id, position);
    const renumbered = renumberOutlineItemsWithIdMap(reordered);
    sortIdMapRef.current = composeIdMap(sortIdMapRef.current, renumbered.idMap);
    setDraftOutlineData({ ...draftOutlineData, outline: renumbered.outline });
    setExpandedItems((prev) => new Set([...prev].map((id) => renumbered.idMap[id] || id)));
    setSelectedItemId((prev) => (prev ? renumbered.idMap[prev] || prev : prev));
    setSortDirty(true);
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const isExpanded = expandedItems.has(item.id);
    const isActive = selectedItemId === item.id;
    const isDragging = draggingItemId === item.id;
    const isDropTarget = dropTarget?.itemId === item.id;
    const dropClass = isDropTarget
      ? dropTarget.valid
        ? ` is-drop-${dropTarget.position}`
        : ' is-drop-invalid'
      : '';

    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div
          className={`outline-tree-item${isActive ? ' is-active' : ''}${sorting ? ' is-sorting' : ''}${isDragging ? ' is-dragging' : ''}${dropClass}`}
          draggable={sorting}
          onDragStart={(event) => handleDragStart(event, item)}
          onDragOver={(event) => handleDragOver(event, item)}
          onDrop={(event) => handleDrop(event, item)}
          onDragEnd={handleDragEnd}
        >
          {sorting && <span className="outline-tree-drag-handle" aria-hidden="true">⋮⋮</span>}
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(item.id)}
            disabled={!hasChildren}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${item.title}` : `${item.title} 无子目录`}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="outline-tree-content"
            onClick={() => setSelectedItemId(item.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(item.id)}
          >
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)].numbering_format)}</strong>
            <small>{item.description || '无描述'}</small>
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  const renderOutlineExpansionModePicker = () => {
    if (!isExpansionWorkflow) {
      return null;
    }

    return (
      <section className="outline-generation-config-section outline-expansion-mode-section">
        <div className="outline-generation-config-head">
          <strong>原方案目录使用方式</strong>
          <span>{outlineExpansionModeLabels[draftOutlineExpansionMode]}</span>
        </div>
        <div className="outline-expansion-mode-switch">
          {outlineExpansionModeOptions.map((option) => {
            const selected = draftOutlineExpansionMode === option.value;
            return (
              <button
                type="button"
                className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => setDraftOutlineExpansionMode(option.value)}
                disabled={generating}
                aria-pressed={selected}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  const renderKnowledgePicker = () => {
    if (loadingKnowledge) {
      return <div className="outline-knowledge-empty">正在读取知识库...</div>;
    }

    const keyword = knowledgeSearch.trim().toLowerCase();
    const availableDocuments = knowledgeIndex.documents.filter((document) => document.status === 'success');
    const selectedDocuments = draftKnowledgeDocumentIds
      .map((documentId) => knowledgeIndex.documents.find((document) => document.id === documentId))
      .filter((document): document is KnowledgeDocument => Boolean(document));
    const visibleFolders = knowledgeIndex.folders.flatMap((folder) => {
      const folderDocuments = availableDocuments.filter((document) => document.folder_id === folder.id);
      const folderMatched = keyword ? includesKeyword(folder.name, keyword) : false;
      const documents = keyword
        ? folderDocuments.filter((document) => folderMatched || includesKeyword(document.file_name, keyword))
        : folderDocuments;

      return documents.length ? [{ folder, documents }] : [];
    });
    const visibleDocumentCount = visibleFolders.reduce((total, group) => total + group.documents.length, 0);

    if (!availableDocuments.length) {
      return <div className="outline-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>;
    }

    return (
      <div className="outline-knowledge-compact">
        <div className="outline-knowledge-search-row">
          <input
            className="outline-knowledge-search"
            value={knowledgeSearch}
            onChange={(event) => setKnowledgeSearch(event.target.value)}
            disabled={knowledgePickingDisabled}
            placeholder="搜索文件夹或文档"
          />
          <span>{keyword ? `匹配 ${visibleDocumentCount} 个文档` : `共 ${availableDocuments.length} 个可用文档`}</span>
        </div>
        <div className="outline-knowledge-grid">
          <div className="outline-knowledge-browser">
            <div className="outline-knowledge-pane-head">
              <strong>知识库</strong>
              <span>{visibleFolders.length} 个文件夹</span>
            </div>
            <div className="outline-knowledge-folder-list compact">
              {visibleFolders.length ? visibleFolders.map(({ folder, documents }) => {
                const expanded = keyword ? true : expandedKnowledgeFolderIds.has(folder.id);
                const selectedCount = documents.filter((document) => draftKnowledgeDocumentIds.includes(document.id)).length;

                return (
                  <section className="outline-knowledge-folder compact" key={folder.id}>
                    <div className="outline-knowledge-folder-head compact">
                      <button type="button" onClick={() => toggleKnowledgeFolder(folder.id)} disabled={Boolean(keyword)} aria-expanded={expanded}>
                        <span>{expanded ? '▾' : '▸'}</span>
                        <strong>{folder.name}</strong>
                      </button>
                      <small>{documents.length} 个 / 已选 {selectedCount}</small>
                      <div className="outline-knowledge-folder-actions">
                        <button type="button" onClick={() => selectFolderDocuments(documents)} disabled={knowledgePickingDisabled}>全选</button>
                        <button type="button" onClick={() => clearFolderDocuments(documents)} disabled={knowledgePickingDisabled || !selectedCount}>取消</button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="outline-knowledge-document-list compact">
                        {documents.map((document) => {
                          const selected = draftKnowledgeDocumentIds.includes(document.id);

                          return (
                            <label className={`outline-knowledge-document compact${selected ? ' is-selected' : ''}`} key={document.id}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={knowledgePickingDisabled}
                                onChange={() => toggleDraftKnowledgeDocument(document)}
                              />
                              <strong title={document.file_name}>{document.file_name}</strong>
                              <small>{document.item_count || 0} 条</small>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              }) : <div className="outline-knowledge-empty compact">没有匹配的知识库文档</div>}
            </div>
          </div>
          <aside className="outline-knowledge-selected-pane">
            <div className="outline-knowledge-pane-head">
              <strong>本次已选</strong>
              <button type="button" onClick={clearDraftKnowledgeDocuments} disabled={knowledgePickingDisabled || !draftKnowledgeDocumentIds.length}>清空</button>
            </div>
            {selectedDocuments.length ? (
              <div className="outline-knowledge-selected-list">
                {selectedDocuments.map((document) => (
                  <div className="outline-knowledge-selected-item" key={document.id}>
                    <strong title={document.file_name}>{document.file_name}</strong>
                    <button type="button" onClick={() => removeDraftKnowledgeDocument(document.id)} disabled={knowledgePickingDisabled}>移除</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="outline-knowledge-empty compact">未选择知识库文档</div>
            )}
          </aside>
        </div>
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>目录生成</strong>
          <p>{isExpansionWorkflow ? `当前原方案目录使用方式：${outlineExpansionModeLabels[outlineExpansionMode]}；参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。` : `生成前选择参考知识库；当前参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。`}</p>
        </div>
        <div className="outline-command-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={openGenerationDialog}
            disabled={generating || sorting || contentMutationLocked || !projectOverview || !techRequirements}
            aria-label="打开目录生成配置"
            title="目录生成配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={openGenerationDialog} disabled={generating || sorting || contentMutationLocked || !projectOverview || !techRequirements}>
            {generating ? 'AI 正在生成目录' : outlineData ? '重新生成目录' : '生成目录'}
          </button>
        </div>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{statusText}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`目录生成进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {taskFailed && <small>{task?.error || latestLog || '目录生成失败'}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div>
              <strong>目录结构</strong>
              <span>{activeOutlineData?.outline?.length || 0} 个一级目录{sorting ? ' · 排序中' : ''}</span>
            </div>
            <div className="outline-tree-tools">
              {sorting ? (
                <>
                  <button type="button" className="outline-save-sort-action" onClick={() => { void saveSorting().catch((error) => showToast(error instanceof Error ? error.message : '保存排序失败', 'error')); }} disabled={savingSort}>
                    {savingSort ? '正在保存...' : '保存排序'}
                  </button>
                  <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                  <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              ) : (
                <>
                {outlineData && (
                <button type="button" className="outline-add-root-action" onClick={() => { void addRootItem(); }} disabled={outlineMutationLocked}>
                  添加一级目录
                </button>
                )}
                {outlineData && (
                  <button type="button" onClick={startSorting} disabled={outlineMutationLocked || !outlineData?.outline?.length}>目录排序</button>
                )}
                <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              )}
            </div>
          </div>
          {activeOutlineData?.outline?.length ? (
            <div className={`outline-tree-list${sorting ? ' is-sorting' : ''}`}>
              {activeOutlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>先完成招标文件解析，再生成技术方案目录。</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {(generating || contentMutationLocked || sorting) && (
                <div className="outline-detail-lock">
                  {sorting
                    ? '目录排序中，当前目录暂不可编辑。'
                    : contentMutationLocked
                      ? '正文生成任务正在运行或暂停中，当前目录暂不可编辑。'
                      : '目录生成任务正在运行，当前目录暂不可编辑，避免覆盖后台生成结果。'}
                </div>
              )}
              {editingItemId === selectedItem.id ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <label>
                    <span>描述</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={outlineMutationLocked || sorting}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {selectedItem.source_requirement_title && <small>来源评分项：{selectedItem.source_requirement_title}</small>}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={outlineMutationLocked || sorting}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => { void addChildItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => { void removeItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和描述。</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog.Root open={generationDialogOpen} onOpenChange={setGenerationDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="outline-generation-config-card">
            <Dialog.Title className="sr-only">{outlineData ? '重新生成目录' : '生成目录'}</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次目录生成方式和参考知识库。</Dialog.Description>

            <div className={`outline-generation-config-body${isExpansionWorkflow ? ' has-expansion-mode' : ''}`}>
              {renderOutlineExpansionModePicker()}
              <section className={`outline-generation-config-section outline-knowledge-picker${knowledgeDisabledByMode ? ' is-disabled-by-mode' : ''}`}>
                <div className="outline-generation-config-head">
                  <strong>参考知识库</strong>
                  <span>{knowledgeDisabledByMode ? '该模式不使用知识库' : `已选择 ${draftKnowledgeDocumentIds.length} 个文档`}</span>
                </div>
                {renderKnowledgePicker()}
              </section>
            </div>

            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={saveOutlineConfig} disabled={generating || contentMutationLocked}>
                保存配置
              </button>
              <button type="button" className="primary-action" onClick={generateOutline} disabled={generating || contentMutationLocked || !projectOverview || !techRequirements}>
                开始生成
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default OutlineEditPage;
