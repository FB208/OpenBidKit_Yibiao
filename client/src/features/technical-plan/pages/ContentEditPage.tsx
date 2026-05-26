import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Switch from '@radix-ui/react-switch';
import { Children, isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { MarkdownEditor, MarkdownRenderer, useToast } from '../../../shared/ui';
import type { ImageModelStatus, OutlineData, OutlineItem } from '../../../shared/types';
import type { BackgroundTaskState, ContentGenerationOptions, ContentGenerationSectionStatus, ContentGenerationSections, ContentImageStats, ContentTableRequirement } from '../types';

interface ContentEditPageProps {
  outlineData: OutlineData | null;
  projectOverview: string;
  referenceKnowledgeDocumentIds: string[];
  task?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  sections: ContentGenerationSections;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void> | void;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
  onContentReset: () => Promise<OutlineData> | OutlineData;
}

type TreeStatus = ContentGenerationSectionStatus | 'partial' | 'planning';

interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
  words: number;
}

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  partial: '部分生成',
  planning: '编排中',
};

const imageModelStatusLabels: Record<ImageModelStatus, string> = {
  untested: '未测试',
  available: '可用',
  unavailable: '不可用',
};

const tableRequirementOptions: Array<{ value: ContentTableRequirement; label: string; description: string }> = [
  { value: 'none', label: '不要', description: '不编排表格' },
  { value: 'light', label: '少量', description: '不超过小节总数的 20%' },
  { value: 'moderate', label: '适中', description: '不超过小节总数的 40%' },
  { value: 'heavy', label: '大量', description: '保持现有编排逻辑' },
];

const defaultContentGenerationOptions: ContentGenerationOptions = {
  useAiImages: false,
  maxAiImages: 6,
  useMermaidImages: true,
  tableRequirement: 'heavy',
};

function isContentTableRequirement(value: unknown): value is ContentTableRequirement {
  return tableRequirementOptions.some((option) => option.value === value);
}

function buildDefaultGenerationOptions(imageModelAvailable: boolean, leafCount: number): ContentGenerationOptions {
  return {
    ...defaultContentGenerationOptions,
    useAiImages: imageModelAvailable,
    maxAiImages: Math.min(defaultContentGenerationOptions.maxAiImages, Math.max(1, leafCount)),
  };
}

function normalizeGenerationOptions(options: ContentGenerationOptions | undefined, imageModelAvailable: boolean, leafCount: number): ContentGenerationOptions {
  const fallback = buildDefaultGenerationOptions(imageModelAvailable, leafCount);
  const maxAiImagesLimit = Math.max(1, leafCount);
  const requestedMaxAiImages = Number(options?.maxAiImages ?? fallback.maxAiImages);
  const tableRequirement = options?.tableRequirement;

  return {
    useAiImages: Boolean(options?.useAiImages ?? fallback.useAiImages) && imageModelAvailable,
    maxAiImages: Math.max(0, Math.min(Number.isFinite(requestedMaxAiImages) ? Math.round(requestedMaxAiImages) : fallback.maxAiImages, maxAiImagesLimit)),
    useMermaidImages: Boolean(options?.useMermaidImages ?? fallback.useMermaidImages),
    tableRequirement: isContentTableRequirement(tableRequirement) ? tableRequirement : fallback.tableRequirement,
  };
}

const emptyImageStats: ContentImageStats = { planned: 0, attempted: 0, success: 0, failed: 0, skipped: 0 };

function normalizeImageStats(stats?: Partial<ContentImageStats>): ContentImageStats {
  return { ...emptyImageStats, ...(stats || {}) };
}

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function findItem(items: OutlineItem[], id: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }

    if (item.children?.length) {
      const found = findItem(item.children, id);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function countWords(content: string) {
  return content.replace(/\s+/g, '').length;
}

function getLeafContent(item: OutlineItem, sections: ContentGenerationSections) {
  return sections[item.id]?.content || item.content || '';
}

function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): ContentGenerationSectionStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  return getLeafContent(item, sections).trim() ? 'success' : 'idle';
}

function getTreeStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  if (!item.children?.length) {
    return getLeafStatus(item, sections);
  }

  const childStatuses = item.children.map((child) => getTreeStatus(child, sections));
  if (childStatuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (childStatuses.every((status) => status === 'success')) {
    return 'success';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) {
    return 'partial';
  }

  return 'idle';
}

function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) return 'partial';
  if (childStatuses.some((status) => status === 'planning')) return 'planning';
  return 'idle';
}

function buildOutlineMeta(items: OutlineItem[], sections: ContentGenerationSections, planning: boolean) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const baseStatus = getLeafStatus(item, sections);
      const status: TreeStatus = planning && baseStatus === 'idle' ? 'planning' : baseStatus;
      const nodeMeta: OutlineNodeMeta = { status, leafCount: 1, words: countWords(getLeafContent(item, sections)) };
      meta.set(item.id, nodeMeta);
      return nodeMeta;
    }

    const children = item.children.map(visit);
    const nodeMeta = {
      status: getParentStatus(children.map((child) => child.status)),
      leafCount: children.reduce((sum, child) => sum + child.leafCount, 0),
      words: children.reduce((sum, child) => sum + child.words, 0),
    };
    meta.set(item.id, nodeMeta);
    return nodeMeta;
  }

  items.forEach(visit);
  return meta;
}

function MermaidBlock({ code }: { code: string }) {
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
      if (container) {
        container.innerHTML = '';
      }
      return undefined;
    }

    setStatus('loading');
    setErrorMessage('');
    if (container) {
      container.innerHTML = '';
    }

    import('mermaid')
      .then((module) => {
        const mermaid = module.default;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
        return mermaid.render(`mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`, trimmedCode);
      })
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = svg;
        setStatus('success');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Mermaid 图渲染失败');
      });

    return () => {
      cancelled = true;
      if (container) {
        container.innerHTML = '';
      }
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

const MarkdownContent = memo(function MarkdownContent({ content, onPreviewImage }: { content: string; onPreviewImage: (src: string, alt: string) => void }) {
  const markdownComponents = useMemo<Components>(() => ({
    pre({ children, ...props }) {
      const child = Children.count(children) === 1 ? Children.only(children) : null;
      if (isValidElement(child)) {
        const childProps = child.props as { className?: string; children?: ReactNode };
        const className = childProps.className || '';
        if (/\blanguage-mermaid\b/i.test(className)) {
          return <MermaidBlock code={String(childProps.children || '').replace(/\n$/, '')} />;
        }
      }

      return <pre {...props}>{children}</pre>;
    },
    img({ node: _node, src, alt, ...props }) {
      const imageSrc = String(src || '');
      const imageAlt = String(alt || '正文图片');
      return (
        <img
          {...props}
          src={imageSrc}
          alt={imageAlt}
          className="markdown-clickable-image"
          role={imageSrc ? 'button' : undefined}
          tabIndex={imageSrc ? 0 : undefined}
          onClick={() => imageSrc && onPreviewImage(imageSrc, imageAlt)}
          onKeyDown={(event) => {
            if (imageSrc && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onPreviewImage(imageSrc, imageAlt);
            }
          }}
        />
      );
    },
  }), [onPreviewImage]);

  return (
    <MarkdownRenderer components={markdownComponents}>
      {content}
    </MarkdownRenderer>
  );
});

function ContentEditPage({
  outlineData,
  projectOverview,
  referenceKnowledgeDocumentIds,
  task,
  contentGenerationOptions,
  sections,
  onContentGenerationOptionsChange,
  onContentSaved,
  onContentReset,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const leaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [confirmRegenerateItem, setConfirmRegenerateItem] = useState<OutlineItem | null>(null);
  const [requirementItem, setRequirementItem] = useState<OutlineItem | null>(null);
  const [regenerateRequirement, setRegenerateRequirement] = useState('');
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState<ImageModelStatus>('untested');
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftGenerationOptions, setDraftGenerationOptions] = useState<ContentGenerationOptions>(defaultContentGenerationOptions);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const firstLeafId = leaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const running = task?.status === 'running';
  const contentStats = task?.stats?.content;
  const planning = running && contentStats?.phase === 'planning';
  const illustrating = running && contentStats?.phase === 'illustrating';
  const outlineMeta = useMemo(() => outlineData?.outline ? buildOutlineMeta(outlineData.outline, sections, planning) : new Map<string, OutlineNodeMeta>(), [outlineData, planning, sections]);
  const contentSummary = useMemo(() => leaves.reduce((summary, item) => {
    const status = getLeafStatus(item, sections);
    return {
      completedCount: summary.completedCount + (status === 'success' ? 1 : 0),
      failedCount: summary.failedCount + (status === 'error' ? 1 : 0),
      totalWords: summary.totalWords + (outlineMeta.get(item.id)?.words || 0),
    };
  }, { completedCount: 0, failedCount: 0, totalWords: 0 }), [leaves, outlineMeta, sections]);
  const { completedCount, failedCount, totalWords } = contentSummary;
  const progress = leaves.length ? Math.round((completedCount / leaves.length) * 100) : 0;
  const planningTotal = contentStats?.planning_total || leaves.length;
  const planningCompleted = contentStats?.planning_completed || 0;
  const planningProgress = planningTotal ? Math.round((planningCompleted / planningTotal) * 100) : 0;
  const illustrationTotal = contentStats?.illustration_total || 0;
  const illustrationCompleted = contentStats?.illustration_completed || 0;
  const illustrationProgress = illustrationTotal ? Math.round((illustrationCompleted / illustrationTotal) * 100) : 0;
  const displayProgress = planning ? planningProgress : illustrating ? illustrationProgress : progress;
  const displayProgressLabel = planning ? '编排统计' : illustrating ? '配图统计' : '生成统计';
  const displayProgressCount = planning
    ? `${planningCompleted}/${planningTotal}`
    : illustrating
      ? `${illustrationCompleted}/${illustrationTotal}`
      : `${completedCount}/${leaves.length}`;
  const progressPhaseLabel = planning ? '正文编排' : illustrating ? '正文配图' : '正文生成';
  const progressTrackClass = `content-generation-progress-track${planning ? ' is-planning' : ''}${illustrating ? ' is-illustrating' : ''}`;
  const selectedStatus = selectedItem ? outlineMeta.get(selectedItem.id)?.status || 'idle' : 'idle';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);
  const imageStats = task?.stats?.images;
  const aiImageStats = normalizeImageStats(imageStats?.ai);
  const mermaidImageStats = normalizeImageStats(imageStats?.mermaid);
  const imageModelAvailable = imageModelStatus === 'available';

  const handlePreviewImage = useCallback((src: string, alt: string) => setPreviewImage({ src, alt }), []);

  useEffect(() => {
    if (!outlineData?.outline?.length) {
      setSelectedItemId('');
      return;
    }

    if (!selectedItemId || !findItem(outlineData.outline, selectedItemId)) {
      setSelectedItemId(firstLeafId || outlineData.outline[0].id);
    }
  }, [firstLeafId, outlineData, selectedItemId]);

  useEffect(() => {
    window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config.developer_mode));
        setImageModelStatus(config.image_model?.status || 'untested');
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    if (!selectedItem || selectedItem.id === editingItemId) {
      return;
    }
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const openGenerationDialog = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextStatus = config?.image_model?.status || 'untested';
      const available = nextStatus === 'available';
      setImageModelStatus(nextStatus);
      setDraftGenerationOptions(normalizeGenerationOptions(contentGenerationOptions, available, leaves.length));
      setGenerationDialogOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取生成配置失败', 'error');
    }
  };

  const saveDraftGenerationOptions = async (showSuccess: boolean, imageAvailable = imageModelAvailable) => {
    const nextOptions = normalizeGenerationOptions(draftGenerationOptions, imageAvailable, leaves.length);
    await onContentGenerationOptionsChange(nextOptions);
    setDraftGenerationOptions(nextOptions);

    if (showSuccess) {
      setGenerationDialogOpen(false);
      showToast('正文生成配置已保存', 'success');
    }

    return nextOptions;
  };

  const saveGenerationOptions = async () => {
    try {
      await saveDraftGenerationOptions(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文生成配置保存失败', 'error');
    }
  };

  const startGeneration = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      setImageModelStatus(nextImageModelStatus);
      const savedGenerationOptions = await saveDraftGenerationOptions(false, nextImageModelAvailable);
      const shouldRealTimeRender = config?.real_time_render === true;
      const regenerate = leaves.length > 0 && completedCount === leaves.length;
      const nextOutlineData = regenerate ? await onContentReset() : outlineData;
      if (regenerate) {
        setEditingItemId(null);
        setIsPreviewing(false);
        setDraftContent('');
      }
      await window.yibiao?.tasks.startContentGeneration({
        outlineData: nextOutlineData,
        projectOverview: nextOutlineData.project_overview || projectOverview,
        reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
        regenerate,
        generationOptions: {
          useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
          maxAiImages: savedGenerationOptions.maxAiImages,
          useMermaidImages: savedGenerationOptions.useMermaidImages,
          tableRequirement: savedGenerationOptions.tableRequirement,
        },
        real_time_render: shouldRealTimeRender,
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
      }, config);
      setGenerationDialogOpen(false);
      showToast(regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    }
  };

  const startSectionRegeneration = async () => {
    if (!outlineData?.outline?.length || !requirementItem) {
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = normalizeGenerationOptions(contentGenerationOptions, nextImageModelAvailable, leaves.length);
      setImageModelStatus(nextImageModelStatus);
      const shouldRealTimeRender = config?.real_time_render === true;
      await window.yibiao?.tasks.startContentGeneration({
        outlineData,
        projectOverview: outlineData.project_overview || projectOverview,
        reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
        regenerate: true,
        targetItemId: requirementItem.id,
        requirement: regenerateRequirement,
        generationOptions: {
          useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
          maxAiImages: savedGenerationOptions.maxAiImages,
          useMermaidImages: savedGenerationOptions.useMermaidImages,
          tableRequirement: savedGenerationOptions.tableRequirement,
        },
        real_time_render: shouldRealTimeRender,
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
      }, config);
      setSelectedItemId(requirementItem.id);
      setRequirementItem(null);
      setRegenerateRequirement('');
      showToast('小节重新生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动小节重新生成失败', 'error');
    }
  };

  const startEditingContent = () => {
    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }

    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const togglePreview = () => {
    setIsPreviewing((prev) => !prev);
  };

  const cancelEditingContent = () => {
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  };

  const saveEditingContent = async () => {
    if (!selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) {
      return;
    }

    try {
      await onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
      showToast('正文已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const meta = outlineMeta.get(item.id);
    const status = meta?.status || 'idle';
    const isLeaf = !item.children?.length;
    const leafCount = meta?.leafCount || 0;
    const words = meta?.words || 0;

    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => setSelectedItemId(item.id)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{item.id} {item.title}</strong>
            <small>{isLeaf ? `${statusLabels[status]} · ${words} 字` : `${statusLabels[status]} · ${leafCount} 个小节 · ${words} 字`}</small>
          </span>
          {isLeaf && (status === 'success' || status === 'error') ? (
            <Popover.Root
              open={confirmRegenerateItem?.id === item.id}
              onOpenChange={(open) => setConfirmRegenerateItem(open ? item : null)}
            >
              <Popover.Trigger asChild>
                <em
                  className="is-clickable"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >{statusLabels[status]}</em>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="content-regenerate-popover" side="top" align="end" sideOffset={8}>
                  <strong>重新生成此小节？</strong>
                  <span>{status === 'error' ? '将重新尝试生成失败的小节。' : '将覆盖当前正文内容。'}</span>
                  <div>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={running}
                      onClick={() => {
                        setRequirementItem(item);
                        setRegenerateRequirement('');
                        setConfirmRegenerateItem(null);
                      }}
                    >是</button>
                    <Popover.Close className="secondary-action" type="button">否</Popover.Close>
                  </div>
                  <Popover.Arrow className="content-regenerate-popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : (
            <em>{statusLabels[status]}</em>
          )}
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先在目录生成步骤完成技术方案目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 04</span>
          <strong>正文生成</strong>
          <p>按目录叶子小节并发生成技术方案正文，页面切换不会中断后台任务。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个小节</span>
          <span><strong>{completedCount}</strong> 已生成</span>
          <span><strong>{totalWords}</strong> 字</span>
        </div>
        <button type="button" className="primary-action" onClick={openGenerationDialog} disabled={running || !leaves.length}>
          {running ? '正文生成中...' : completedCount === leaves.length && leaves.length ? '重新生成正文' : completedCount > 0 ? '继续生成正文' : '生成正文'}
        </button>
      </section>

      {developerMode && imageStats && (
        <aside className="content-dev-stats-panel" aria-label="开发者生成统计">
          <strong>配图统计</strong>
          <span>AI 生图 计划 {aiImageStats.planned} / 尝试 {aiImageStats.attempted} / 成功 {aiImageStats.success} / 失败 {aiImageStats.failed} / 跳过 {aiImageStats.skipped}</span>
          <span>Mermaid 计划 {mermaidImageStats.planned} / 尝试 {mermaidImageStats.attempted} / 成功 {mermaidImageStats.success} / 失败 {mermaidImageStats.failed}</span>
        </aside>
      )}

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>标书目录</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className={`content-outline-stats${statsCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setStatsCollapsed((prev) => !prev)} aria-expanded={!statsCollapsed}>
              <span>{displayProgressLabel}</span>
              <strong>{displayProgressCount}</strong>
              <em>{statsCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!statsCollapsed && (
              <div className="content-outline-stats-body">
                <div className={progressTrackClass} aria-label={`${progressPhaseLabel}进度 ${displayProgress}%`}>
                  <span style={{ width: `${displayProgress}%` }} />
                </div>
                <p>{planning ? `正在编排正文结构，已完成 ${planningCompleted}/${planningTotal} 个小节。` : illustrating ? `正在生成配图，已完成 ${illustrationCompleted}/${illustrationTotal} 张。` : running ? task?.logs?.[task.logs.length - 1] || '正文生成任务正在运行。' : completedCount ? `已生成 ${completedCount} 个小节，共 ${totalWords} 字。` : '点击生成正文后，目录会实时显示每个小节状态。'}</p>
                {failedCount > 0 && <small>失败 {failedCount} 个小节</small>}
              </div>
            )}
          </div>
          <div className="content-outline-list">
            {renderTree(outlineData.outline)}
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedStatus}`}>{statusLabels[selectedStatus]}</span>
              {editing ? (
                <>
                  <button type="button" className={isPreviewing ? 'secondary-action' : 'primary-action'} onClick={togglePreview}>
                    {isPreviewing ? '编辑' : '预览'}
                  </button>
                  <button type="button" className="primary-action" onClick={saveEditingContent}>保存</button>
                  <button type="button" className="secondary-action" onClick={cancelEditingContent}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditingContent} disabled={!selectedItem || !selectedIsLeaf || running}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <MarkdownEditor
              value={draftContent}
              onChange={setDraftContent}
              placeholder="输入 Markdown 正文..."
            />
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <div className="markdown-viewer content-generation-output">
              {draftContent.trim() ? (
                <MarkdownContent content={draftContent} onPreviewImage={handlePreviewImage} />
              ) : (
                <p className="content-editor-empty">暂无预览内容</p>
              )}
            </div>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <div className="markdown-viewer content-generation-output">
              <MarkdownContent content={selectedContent} onPreviewImage={handlePreviewImage} />
            </div>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error' ? sections[selectedItem.id]?.error || '正文生成失败' : '正文待生成'}</strong>
              <p>{running ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : '点击生成正文后，后台会按目录小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>

      <Dialog.Root
        open={generationDialogOpen}
        onOpenChange={setGenerationDialogOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-generation-config-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">生成配置</span>
              <Dialog.Title>正文生成配置</Dialog.Title>
              <Dialog.Description>
                {completedCount === leaves.length && leaves.length
                  ? '重新生成会先清空全文正文、章节状态和任务进度，再从头生成。'
                  : '开始生成前确认是否配图，以及本次最多生成多少张 AI 图片。'}
              </Dialog.Description>
            </div>
            <div className="content-generation-config-list">
              <label className="content-generation-config-row">
                <span>
                  <strong>表格需求</strong>
                  <small>{tableRequirementOptions.find((option) => option.value === draftGenerationOptions.tableRequirement)?.description}</small>
                </span>
                <select
                  value={draftGenerationOptions.tableRequirement}
                  onChange={(event) => setDraftGenerationOptions((prev) => ({ ...prev, tableRequirement: event.target.value as ContentTableRequirement }))}
                >
                  {tableRequirementOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="content-generation-config-row">
                <span>
                  <strong>使用 AI 生图</strong>
                  <small>当前生图模型状态：{imageModelStatusLabels[imageModelStatus]}{!imageModelAvailable ? '，请到设置页面配置生图模型' : ''}</small>
                </span>
                <div className="content-generation-config-control">
                  <em className={`content-image-status is-${imageModelStatus}`}>{imageModelStatusLabels[imageModelStatus]}</em>
                  <Switch.Root
                    className="content-generation-switch"
                    checked={draftGenerationOptions.useAiImages && imageModelAvailable}
                    disabled={!imageModelAvailable}
                    onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, useAiImages: checked }))}
                    aria-label="是否使用 AI 生图"
                  >
                    <Switch.Thumb className="content-generation-switch-thumb" />
                  </Switch.Root>
                </div>
              </label>
              <label className="content-generation-config-row">
                <span>
                  <strong>全文图片最大数量</strong>
                  <small>AI 生图会在整体决策后择优分布，不再按先后顺序抢占名额。</small>
                </span>
                <input
                  type="number"
                  min="0"
                  max={Math.max(1, leaves.length)}
                  value={draftGenerationOptions.maxAiImages}
                  disabled={!draftGenerationOptions.useAiImages || !imageModelAvailable}
                  onChange={(event) => setDraftGenerationOptions((prev) => ({
                    ...prev,
                    maxAiImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, leaves.length))),
                  }))}
                />
              </label>
              <label className="content-generation-config-row">
                <span>
                  <strong>生成 Mermaid 图片</strong>
                  <small>适合简单流程、层级、时间线或关系图；预览在前端渲染，与 AI 生图二选一。</small>
                </span>
                <Switch.Root
                  className="content-generation-switch"
                  checked={draftGenerationOptions.useMermaidImages}
                  onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, useMermaidImages: checked }))}
                  aria-label="是否生成 Mermaid 图片"
                >
                  <Switch.Thumb className="content-generation-switch-thumb" />
                </Switch.Root>
              </label>
              {draftGenerationOptions.useMermaidImages && (
                <p className="content-generation-config-note">当前 Mermaid 转图片使用的是 https://mermaid.ink/ 的免费接口，可能不稳定，导出 Word 后请仔细核对。</p>
              )}
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={saveGenerationOptions} disabled={running}>
                保存配置
              </button>
              <button type="button" className="primary-action" onClick={startGeneration} disabled={running}>开始生成</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(requirementItem)}
        onOpenChange={(open) => {
          if (!open) {
            setRequirementItem(null);
            setRegenerateRequirement('');
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">重新生成</span>
              <Dialog.Title>{requirementItem?.id} {requirementItem?.title}</Dialog.Title>
              <Dialog.Description>输入本次重新生成的具体要求，AI 会只覆盖当前小节正文。</Dialog.Description>
            </div>
            <textarea
              value={regenerateRequirement}
              onChange={(event) => setRegenerateRequirement(event.target.value)}
              placeholder="例如：强化实施步骤，减少背景描述，突出设备配置与运维响应。"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={startSectionRegeneration} disabled={running}>开始重新生成</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-modal" />
          <Dialog.Content className="image-preview-card">
            <Dialog.Close className="image-preview-close" type="button" aria-label="关闭图片预览">×</Dialog.Close>
            <Dialog.Title>{previewImage?.alt || '图片预览'}</Dialog.Title>
            {previewImage && <img src={previewImage.src} alt={previewImage.alt} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default ContentEditPage;
