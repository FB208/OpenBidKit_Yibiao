import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { ProgressBar, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, OutlineSelectionItem, SaveOutlineRequest, SaveOutlineSelectionRequest } from '../types';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { OutlineContentMode, OutlineData, OutlineExpansionMode, OutlineItem, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import OutlineSelectionDialog from '../components/OutlineSelectionDialog';

interface OutlineEditPageProps {
  stepNumber: string;
  hasOriginalPlan: boolean;
  projectOverview: string;
  outlineMode: OutlineMode;
  outlineModeRequiresRegeneration: boolean;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentTaskStatus?: BackgroundTaskState['status'];
  aiAdjustmentRunning?: boolean;
  onOutlineSaved: (request: SaveOutlineRequest) => Promise<void>;
  onOutlineSelectionSaved: (request: SaveOutlineSelectionRequest) => Promise<void>;
  onOpenBidTemplate?: () => Promise<void>;
  bidTemplateExists?: boolean;
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

const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineModeLabels: Record<OutlineMode, string> = {
  'response-file': '完整投标文件',
  'standalone-technical': '技术文件独立成册',
  'standalone-business': '商务标独立成册',
};
const contentModeOptions = Object.keys(OUTLINE_CONTENT_MODE_LABELS) as OutlineContentMode[];

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

// 父节点不保存处理模式，叶子保留已经明确选择的处理模式。
function normalizeOutlineContentModes(items: OutlineItem[]): OutlineItem[] {
  return items.map((item) => {
    if (item.children?.length) {
      const branch = { ...item };
      delete branch.content_mode;
      delete branch.content_mode_note;
      return { ...branch, children: normalizeOutlineContentModes(item.children) };
    }
    const leaf = { ...item };
    delete leaf.children;
    const contentMode = item.content_mode;
    return {
      ...leaf,
      content_mode: contentMode,
      ...(contentMode === 'other' && item.content_mode_note?.trim()
        ? { content_mode_note: item.content_mode_note.trim() }
        : { content_mode_note: undefined }),
    };
  });
}

function assertLeafContentModes(items: OutlineItem[]) {
  items.forEach((item) => {
    if (item.children?.length) {
      assertLeafContentModes(item.children);
    } else if (!item.content_mode) {
      throw new Error(`目录“${item.title}”缺少内容处理模式，请重新生成目录`);
    }
  });
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

    const children = item.children ? deleteOutlineItem(item.children, itemId) : undefined;
    return [{
      ...item,
      children: children?.length ? children : undefined,
      ...(!children?.length && item.children?.length ? { content_mode: 'ai-generate' as const } : {}),
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

function OutlineEditPage({
  stepNumber,
  hasOriginalPlan,
  projectOverview,
  outlineMode,
  outlineModeRequiresRegeneration,
  outlineExpansionMode,
  outlineWordControlOptions,
  referenceKnowledgeDocumentIds,
  outlineData,
  task,
  contentTaskStatus,
  aiAdjustmentRunning = false,
  onOutlineSaved,
  onOutlineSelectionSaved,
  onOpenBidTemplate,
  bidTemplateExists = false,
  onSortGuardChange,
}: OutlineEditPageProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editContentMode, setEditContentMode] = useState<OutlineContentMode>('ai-generate');
  const [editContentModeNote, setEditContentModeNote] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [sorting, setSorting] = useState(false);
  const [draftOutlineData, setDraftOutlineData] = useState<OutlineData | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [sortDirty, setSortDirty] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [selectionDialogOpen, setSelectionDialogOpen] = useState(false);
  const [savingOutlineSelection, setSavingOutlineSelection] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const sortIdMapRef = useRef<Record<string, string>>({});
  const shownTaskErrorIdRef = useRef<string | null>(null);
  const { showToast } = useToast();
  const activeOutlineData = sorting ? draftOutlineData : outlineData;
  const selectedItem = activeOutlineData && selectedItemId ? findOutlineItem(activeOutlineData.outline, selectedItemId) : null;
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const outlineSelection = task?.stats?.outline_selection;
  const hasOutlineSelection = Boolean(outlineSelection?.items?.length);
  const awaitingOutlineSelection = Boolean(taskRunning && hasOutlineSelection && !outlineSelection?.confirmed);
  const generating = startingOutline || taskRunning;
  const contentMutationLocked = contentTaskStatus === 'running' || contentTaskStatus === 'pausing' || contentTaskStatus === 'paused';
  const outlineMutationLocked = generating || contentMutationLocked || savingSort || aiAdjustmentRunning;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = awaitingOutlineSelection
    ? '待确认'
    : generating
      ? '运行中'
    : taskFailed
      ? '失败'
      : outlineData
        ? '已完成'
        : hasOutlineSelection
          ? outlineSelection?.confirmed ? '已确认' : '待确认'
          : '未开始';
  const aiStatusTitle = awaitingOutlineSelection ? '等待确认一级目录' : generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';
  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (cancelled) return;
      if (cfg?.export_format) {
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
    if (task?.status !== 'error' || !task.task_id || shownTaskErrorIdRef.current === task.task_id) return;
    shownTaskErrorIdRef.current = task.task_id;
    showToast(task.error || '目录生成失败，请调整设置后重新生成目录', 'error');
  }, [showToast, task?.error, task?.status, task?.task_id]);

  useEffect(() => {
    if (!awaitingOutlineSelection) {
      setSelectionDialogOpen(false);
      return;
    }
    setSelectionDialogOpen(true);
  }, [awaitingOutlineSelection, task?.task_id]);

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

  const generateOutline = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }
    if (!projectOverview) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    try {
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      const nextOutlineExpansionMode = hasOriginalPlan ? outlineExpansionMode : 'ai-complement';
      await window.yibiao?.tasks.startOutlineGeneration({
        reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
        outline_mode: outlineMode,
        outline_expansion_mode: nextOutlineExpansionMode,
        word_control_options: outlineWordControlOptions,
      });
      trackConfigUsage({
        outline_mode: outlineMode,
        outline_expansion_mode: hasOriginalPlan ? nextOutlineExpansionMode : undefined,
        word_control_enabled: outlineWordControlOptions.minimumWords > 0 || outlineWordControlOptions.maximumWords > 0 || outlineWordControlOptions.sectionWords > 0,
        minimum_words: outlineWordControlOptions.minimumWords,
        maximum_words: outlineWordControlOptions.maximumWords,
        section_words: outlineWordControlOptions.sectionWords,
        strict_section_words: outlineWordControlOptions.strictSectionWords,
      });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const confirmOutlineSelection = async (items: OutlineSelectionItem[], selectedIds: string[]) => {
    if (!task?.task_id) return;
    try {
      setSavingOutlineSelection(true);
      await onOutlineSelectionSaved({ taskId: task.task_id, items, selectedIds });
      setSelectionDialogOpen(false);
      showToast(`已确认 ${selectedIds.length} 个一级目录`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存一级目录选择失败', 'error');
    } finally {
      setSavingOutlineSelection(false);
    }
  };

  // 用户修改一级目录选择时停止当前弹窗的自动确认计时。
  const suppressOutlineSelectionAutoConfirmation = () => {
    if (!task?.task_id) return;
    void window.yibiao.tasks.suppressOutlineSelectionAutoConfirmation({ taskId: task.task_id }).catch(() => undefined);
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

    const normalizedOutline = normalizeOutlineContentModes(outline);
    assertLeafContentModes(normalizedOutline);
    const renumbered = renumberOutlineItemsWithIdMap(normalizedOutline);
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
    setEditContentMode(item.content_mode || 'ai-generate');
    setEditContentModeNote(item.content_mode_note || '');
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
        ...(!item.children?.length ? {
          content_mode: editContentMode,
          content_mode_note: editContentMode === 'other' ? editContentModeNote.trim() || undefined : undefined,
        } : {}),
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
      content_mode: 'ai-generate',
    };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], 'add-root');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      setEditContentMode(newItem.content_mode || 'ai-generate');
      setEditContentModeNote(newItem.content_mode_note || '');
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
      content_mode: 'ai-generate',
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
      setEditContentMode(newItem.content_mode || 'ai-generate');
      setEditContentModeNote(newItem.content_mode_note || '');
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
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            {!hasChildren && item.content_mode && (
              <span className={`outline-content-mode-badge is-${item.content_mode}`}>{OUTLINE_CONTENT_MODE_LABELS[item.content_mode]}</span>
            )}
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP {stepNumber}</span>
          <strong>目录生成</strong>
          <p>{`生成范围：${outlineModeLabels[outlineMode]}；${hasOriginalPlan ? `当前原方案目录使用方式：${outlineExpansionModeLabels[outlineExpansionMode]}；` : ''}参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。`}</p>
          {outlineModeRequiresRegeneration && <p>生成范围已改变，当前目录仍为原生成结果，请重新生成目录使新范围生效。</p>}
        </div>
        <div className="outline-command-actions">
          {awaitingOutlineSelection && (
            <button type="button" className="secondary-action" onClick={() => setSelectionDialogOpen(true)}>
              确认一级目录
            </button>
          )}
          {bidTemplateExists && (
            <button type="button" className="secondary-action" onClick={() => void onOpenBidTemplate?.()}>
              打开投标模版
            </button>
          )}
          <button type="button" className="primary-action" onClick={() => void generateOutline()} disabled={generating || sorting || contentMutationLocked || !projectOverview}>
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
                <ProgressBar value={progress} label={`目录生成进度 ${progress}%`} />
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
              <strong>{awaitingOutlineSelection ? '一级目录已生成' : '尚未生成目录'}</strong>
              <p>{awaitingOutlineSelection
                ? '请查看并确认需要继续使用的一级目录。'
                : taskFailed ? '上次目录生成未完成，请重新生成目录。' : '先完成招标文件解析，再生成技术方案目录。'}</p>
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
                  {!selectedItem.children?.length && (
                    <label>
                      <span>内容处理模式</span>
                      <select value={editContentMode} onChange={(event) => setEditContentMode(event.target.value as OutlineContentMode)} disabled={outlineMutationLocked || sorting}>
                        {contentModeOptions.map((mode) => <option value={mode} key={mode}>{OUTLINE_CONTENT_MODE_LABELS[mode]}</option>)}
                      </select>
                    </label>
                  )}
                  {!selectedItem.children?.length && editContentMode === 'other' && (
                    <label>
                      <span>其他模式说明</span>
                      <textarea value={editContentModeNote} onChange={(event) => setEditContentModeNote(event.target.value)} disabled={outlineMutationLocked || sorting} />
                    </label>
                  )}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={outlineMutationLocked || sorting}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {!selectedItem.children?.length && selectedItem.content_mode && (
                    <span className={`outline-content-mode-badge is-${selectedItem.content_mode}`}>{OUTLINE_CONTENT_MODE_LABELS[selectedItem.content_mode]}</span>
                  )}
                  {!selectedItem.children?.length && selectedItem.content_mode === 'other' && selectedItem.content_mode_note && (
                    <small>{selectedItem.content_mode_note}</small>
                  )}
                  {selectedItem.source_requirement_title && (
                    <small>{hasOriginalPlan && outlineExpansionMode === 'original-only' ? '来源原方案目录' : '来源响应文件目录'}：{selectedItem.source_requirement_title}</small>
                  )}
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

      {outlineSelection && (
        <OutlineSelectionDialog
          open={selectionDialogOpen}
          selection={outlineSelection}
          saving={savingOutlineSelection}
          onDismiss={() => setSelectionDialogOpen(false)}
          onInteraction={suppressOutlineSelectionAutoConfirmation}
          onConfirm={(items, selectedIds) => { void confirmOutlineSelection(items, selectedIds); }}
        />
      )}

    </div>
  );
}

export default OutlineEditPage;
