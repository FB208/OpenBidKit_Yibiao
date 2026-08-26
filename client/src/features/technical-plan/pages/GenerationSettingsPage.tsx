import { useEffect, useState, type KeyboardEvent } from 'react';
import { AppDialog, AppSwitch, isLibreOfficeRequiredMessage, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../knowledge-base/types';
import type { TechnicalPlanOriginalPlanFile, TechnicalPlanState } from '../types';

type GenerationSettingsTab = 'content' | 'existing-plan' | 'knowledge' | 'length' | 'illustration' | 'writing' | 'appearance';

interface GenerationSettingsPageProps {
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  outlineMode: OutlineMode;
  outlineModeRequiresRegeneration: boolean;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  hasOutlineData: boolean;
  outlineConfigLocked: boolean;
  onOriginalPlanChanged: (state: TechnicalPlanState) => void;
  onOutlineModeChange: (outlineMode: OutlineMode) => Promise<void>;
  onOutlineExpansionModeChange: (outlineExpansionMode: OutlineExpansionMode) => Promise<void>;
  onOutlineWordControlOptionsChange: (options: OutlineWordControlOptions) => Promise<void>;
  onReferenceKnowledgeDocumentIdsChange: (documentIds: string[]) => Promise<void>;
}

const tabs: Array<{ id: GenerationSettingsTab; label: string }> = [
  { id: 'content', label: '写嘛' },
  { id: 'existing-plan', label: '我有方案' },
  { id: 'knowledge', label: '知识库' },
  { id: 'length', label: '写多少' },
  { id: 'illustration', label: '插图吗' },
  { id: 'writing', label: '怎么写' },
  { id: 'appearance', label: '长嘛样' },
];
const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

const documentOptions: Array<{ value: OutlineMode; title: string; description: string }> = [
  {
    value: 'response-file',
    title: '完整投标文件',
    description: '按照招标文件响应要求完整生成',
  },
  {
    value: 'standalone-technical',
    title: '技术文件独立成册',
    description: '一级目录从技术评分大项开始',
  },
  {
    value: 'standalone-business',
    title: '商务标独立成册',
    description: '按照招标文件响应要求仅生成商务部分',
  },
];
const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录；知识库不参与目录补充，但会用于后续全局事实和正文生成。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];
const WORD_COUNT_INPUT_UNIT = 10000;

function parseWordCountDraft(value: string) {
  if (!value) return 0;
  if (!/^\d*(?:\.\d{0,4})?$/.test(value)) return null;
  const number = Number(value);
  const words = Math.round(number * WORD_COUNT_INPUT_UNIT);
  return Number.isSafeInteger(words) && words >= 0 ? words : null;
}

function formatWordCountDraft(words: number) {
  return String(Math.max(0, Math.round(Number(words) || 0)) / WORD_COUNT_INPUT_UNIT);
}

function normalizeWordControlDraft(values: {
  minimumWords: string;
  maximumWords: string;
  sectionWords: string;
  strictSectionWords: boolean;
}) {
  const minimumWords = parseWordCountDraft(values.minimumWords);
  const maximumWords = parseWordCountDraft(values.maximumWords);
  const sectionWords = parseWordCountDraft(values.sectionWords);
  if (minimumWords === null || maximumWords === null || sectionWords === null) {
    throw new Error('字数设置只允许填写非负整数');
  }
  const options: OutlineWordControlOptions = {
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords: sectionWords > 0 && values.strictSectionWords,
  };
  if (minimumWords > 0 && maximumWords > 0 && maximumWords < minimumWords) {
    throw new Error('最多字数不能低于最少字数');
  }
  const effectiveSectionWords = sectionWords > 0 ? sectionWords : 3000;
  const minimumLeafCount = minimumWords > 0 ? Math.ceil(minimumWords / effectiveSectionWords) : null;
  const maximumLeafCount = maximumWords > 0 ? Math.floor(maximumWords / effectiveSectionWords) : null;
  if (maximumLeafCount !== null && maximumLeafCount < 1) {
    throw new Error('当前最多字数无法形成有效叶子节点范围，请调整最多字数或每小节字数');
  }
  if (minimumLeafCount !== null && maximumLeafCount !== null && minimumLeafCount > maximumLeafCount) {
    throw new Error('当前设置无法形成有效叶子节点范围，请调整最少字数、最多字数或每小节字数');
  }
  return options;
}

function getEstimatedPages(minimumWords: number, maximumWords: number) {
  const baseWords = minimumWords > 0 && maximumWords > 0
    ? (minimumWords + maximumWords) / 2
    : minimumWords || maximumWords;
  return baseWords > 0 ? Math.ceil(baseWords / 650) : null;
}

function areWordControlOptionsEqual(left?: OutlineWordControlOptions, right?: OutlineWordControlOptions) {
  return Boolean(left && right
    && left.minimumWords === right.minimumWords
    && left.maximumWords === right.maximumWords
    && left.sectionWords === right.sectionWords
    && left.strictSectionWords === right.strictSectionWords);
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

// 汇总生成前配置，并管理已有方案与参考知识库。
function GenerationSettingsPage({
  originalPlanFile,
  outlineMode,
  outlineModeRequiresRegeneration,
  outlineExpansionMode,
  outlineWordControlOptions,
  outlineWordControlSnapshot,
  referenceKnowledgeDocumentIds,
  hasOutlineData,
  outlineConfigLocked,
  onOriginalPlanChanged,
  onOutlineModeChange,
  onOutlineExpansionModeChange,
  onOutlineWordControlOptionsChange,
  onReferenceKnowledgeDocumentIdsChange,
}: GenerationSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<GenerationSettingsTab>('content');
  const [originalPlanBusy, setOriginalPlanBusy] = useState(false);
  const [outlineModeBusy, setOutlineModeBusy] = useState(false);
  const [draftOutlineExpansionMode, setDraftOutlineExpansionMode] = useState<OutlineExpansionMode>(outlineExpansionMode);
  const [outlineExpansionModeBusy, setOutlineExpansionModeBusy] = useState(false);
  const [draftMinimumWords, setDraftMinimumWords] = useState(formatWordCountDraft(outlineWordControlOptions.minimumWords));
  const [draftMaximumWords, setDraftMaximumWords] = useState(formatWordCountDraft(outlineWordControlOptions.maximumWords));
  const [draftSectionWords, setDraftSectionWords] = useState(formatWordCountDraft(outlineWordControlOptions.sectionWords));
  const [draftStrictSectionWords, setDraftStrictSectionWords] = useState(outlineWordControlOptions.strictSectionWords);
  const [wordControlBusy, setWordControlBusy] = useState(false);
  const [draftKnowledgeDocumentIds, setDraftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [expandedKnowledgeFolderIds, setExpandedKnowledgeFolderIds] = useState<Set<string>>(new Set());
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || '';
  const parsedDraftMinimumWords = parseWordCountDraft(draftMinimumWords) ?? 0;
  const parsedDraftMaximumWords = parseWordCountDraft(draftMaximumWords) ?? 0;
  const parsedDraftSectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
  const estimatedPages = getEstimatedPages(parsedDraftMinimumWords, parsedDraftMaximumWords);
  const normalizedDraftOptions: OutlineWordControlOptions = {
    minimumWords: parsedDraftMinimumWords,
    maximumWords: parsedDraftMaximumWords,
    sectionWords: parsedDraftSectionWords,
    strictSectionWords: parsedDraftSectionWords > 0 && draftStrictSectionWords,
  };
  const wordControlRequiresRegeneration = Boolean(
    hasOutlineData && !areWordControlOptionsEqual(normalizedDraftOptions, outlineWordControlSnapshot),
  );
  const knowledgeSelectionDisabled = loadingKnowledge || knowledgeSaving || outlineConfigLocked;

  useEffect(() => {
    setDraftOutlineExpansionMode(outlineExpansionMode);
  }, [outlineExpansionMode, originalPlanFile?.contentHash]);

  useEffect(() => {
    setDraftMinimumWords(formatWordCountDraft(outlineWordControlOptions.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(outlineWordControlOptions.maximumWords));
    setDraftSectionWords(formatWordCountDraft(outlineWordControlOptions.sectionWords));
    setDraftStrictSectionWords(outlineWordControlOptions.strictSectionWords);
  }, [outlineWordControlOptions]);

  useEffect(() => {
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
  }, [referenceKnowledgeDocumentIds]);

  useEffect(() => {
    if (activeTab !== 'knowledge') return;
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    setKnowledgeSearch('');
    void loadKnowledgeIndex();
  }, [activeTab, referenceKnowledgeDocumentIds]);

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  // 支持标准页签键盘导航，并把焦点同步到新页签。
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`generation-settings-tab-${nextTab.id}`)?.focus();
  };

  // 导入或替换已有方案，并刷新技术方案状态。
  const importOriginalPlan = async (filePaths?: string[]) => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao?.technicalPlan.importOriginalPlanDocument(filePaths);
      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      if (!result.markdown) {
        showToast('已有方案解析结果为空', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      showToast(result.message || '已有方案已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '已有方案解析失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  // 删除已有方案并切回普通生成流程。
  const removeOriginalPlan = async () => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao!.technicalPlan.removeOriginalPlanDocument();
      if (!result.success) {
        showToast(result.message || '移除已有方案失败', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      setRemoveDialogOpen(false);
      showToast(result.message || '已移除已有方案', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移除已有方案失败', 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  // 保存投标文件生成范围；已有结果继续保留到用户重新生成目录。
  const saveOutlineMode = async (nextOutlineMode: OutlineMode) => {
    if (nextOutlineMode === outlineMode || outlineModeBusy) return;
    try {
      setOutlineModeBusy(true);
      await onOutlineModeChange(nextOutlineMode);
      showToast('生成范围已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存生成范围失败', 'error');
    } finally {
      setOutlineModeBusy(false);
    }
  };

  // 保存原方案目录使用方式，不改变当前已生成目录。
  const saveOutlineExpansionMode = async () => {
    if (draftOutlineExpansionMode === outlineExpansionMode || outlineExpansionModeBusy) return;
    try {
      setOutlineExpansionModeBusy(true);
      await onOutlineExpansionModeChange(draftOutlineExpansionMode);
      showToast('原方案目录使用方式已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存原方案目录使用方式失败', 'error');
    } finally {
      setOutlineExpansionModeBusy(false);
    }
  };

  // 按目录生成阶段原有规则校验并保存全文字数配置。
  const saveWordControlOptions = async () => {
    try {
      const options = normalizeWordControlDraft({
        minimumWords: draftMinimumWords,
        maximumWords: draftMaximumWords,
        sectionWords: draftSectionWords,
        strictSectionWords: draftStrictSectionWords,
      });
      setWordControlBusy(true);
      await onOutlineWordControlOptionsChange(options);
      setDraftMinimumWords(formatWordCountDraft(options.minimumWords));
      setDraftMaximumWords(formatWordCountDraft(options.maximumWords));
      setDraftSectionWords(formatWordCountDraft(options.sectionWords));
      setDraftStrictSectionWords(options.strictSectionWords);
      showToast('全文字数设置已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存全文字数设置失败', 'error');
    } finally {
      setWordControlBusy(false);
    }
  };

  // 加载知识库索引，供生成任务选择参考文档。
  const loadKnowledgeIndex = async () => {
    try {
      setLoadingKnowledge(true);
      const index = await window.yibiao?.knowledgeBase.list();
      const nextIndex = index || emptyKnowledgeIndex;
      setKnowledgeIndex(nextIndex);
      setExpandedKnowledgeFolderIds(getInitialExpandedKnowledgeFolders(nextIndex));
    } catch (error) {
      setKnowledgeIndex(emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(new Set());
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setLoadingKnowledge(false);
    }
  };

  // 保存目录与正文生成共用的参考知识库。
  const saveReferenceKnowledgeDocumentIds = async () => {
    try {
      setKnowledgeSaving(true);
      await onReferenceKnowledgeDocumentIdsChange(draftKnowledgeDocumentIds);
      showToast('参考知识库已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存参考知识库失败', 'error');
    } finally {
      setKnowledgeSaving(false);
    }
  };

  const toggleKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || knowledgeSelectionDisabled) return;
    setDraftKnowledgeDocumentIds((current) => (
      current.includes(document.id)
        ? current.filter((id) => id !== document.id)
        : [...current, document.id]
    ));
  };

  const toggleKnowledgeFolder = (folderId: string) => {
    setExpandedKnowledgeFolderIds((current) => (current.has(folderId) ? new Set() : new Set([folderId])));
  };

  const selectKnowledgeFolder = (documents: KnowledgeDocument[]) => {
    if (knowledgeSelectionDisabled) return;
    const ids = documents.filter((document) => document.status === 'success').map((document) => document.id);
    setDraftKnowledgeDocumentIds((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
  };

  const deselectKnowledgeFolder = (documents: KnowledgeDocument[]) => {
    if (knowledgeSelectionDisabled) return;
    const ids = new Set(documents.map((document) => document.id));
    setDraftKnowledgeDocumentIds((current) => current.filter((id) => !ids.has(id)));
  };

  const removeKnowledgeDocument = (documentId: string) => {
    if (knowledgeSelectionDisabled) return;
    setDraftKnowledgeDocumentIds((current) => current.filter((id) => id !== documentId));
  };

  const clearKnowledgeDocuments = () => {
    if (knowledgeSelectionDisabled) return;
    setDraftKnowledgeDocumentIds([]);
  };

  // 渲染可搜索、按文件夹展开的知识库选择器。
  const renderKnowledgePicker = () => {
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

    return (
      <section className="outline-generation-config-section outline-knowledge-picker generation-settings-knowledge-section">
        <div className="outline-generation-config-head">
          <strong>参考知识库</strong>
          <span>已选择 {draftKnowledgeDocumentIds.length} 个文档</span>
        </div>
        {loadingKnowledge ? (
          <div className="outline-knowledge-empty">正在读取知识库...</div>
        ) : !availableDocuments.length ? (
          <div className="outline-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>
        ) : (
          <div className="outline-knowledge-compact">
            <div className="outline-knowledge-search-row">
              <input
                className="outline-knowledge-search"
                value={knowledgeSearch}
                onChange={(event) => setKnowledgeSearch(event.target.value)}
                disabled={knowledgeSelectionDisabled}
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
                            <button type="button" onClick={() => selectKnowledgeFolder(documents)} disabled={knowledgeSelectionDisabled}>全选</button>
                            <button type="button" onClick={() => deselectKnowledgeFolder(documents)} disabled={knowledgeSelectionDisabled || !selectedCount}>取消</button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="outline-knowledge-document-list compact">
                            {documents.map((document) => {
                              const selected = draftKnowledgeDocumentIds.includes(document.id);
                              return (
                                <label className={`outline-knowledge-document compact${selected ? ' is-selected' : ''}`} key={document.id}>
                                  <input type="checkbox" checked={selected} onChange={() => toggleKnowledgeDocument(document)} disabled={knowledgeSelectionDisabled} />
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
                  <button type="button" onClick={clearKnowledgeDocuments} disabled={knowledgeSelectionDisabled || !draftKnowledgeDocumentIds.length}>清空</button>
                </div>
                {selectedDocuments.length ? (
                  <div className="outline-knowledge-selected-list">
                    {selectedDocuments.map((document) => (
                      <div className="outline-knowledge-selected-item" key={document.id}>
                        <strong title={document.file_name}>{document.file_name}</strong>
                        <button type="button" onClick={() => removeKnowledgeDocument(document.id)} disabled={knowledgeSelectionDisabled}>移除</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="outline-knowledge-empty compact">未选择知识库文档</div>
                )}
              </aside>
            </div>
          </div>
        )}
        <div className="generation-settings-save-row">
          <button
            type="button"
            className="primary-action"
            onClick={() => void saveReferenceKnowledgeDocumentIds()}
            disabled={knowledgeSelectionDisabled}
          >
            {knowledgeSaving ? '正在保存...' : '保存设置'}
          </button>
        </div>
      </section>
    );
  };

  return (
    <div className="plan-step-body generation-settings-page">
      <section className="generation-settings-shell">
        <header className="bid-analysis-command-bar generation-settings-command-bar">
          <div>
            <span className="section-kicker">STEP 02</span>
            <strong>生成设置</strong>
            <p>在生成前集中设置投标文件的内容范围、参考知识、篇幅、插图、写法和最终样式。</p>
          </div>
        </header>

        <div className="document-switch-tabs generation-settings-tabs" role="tablist" aria-label="生成设置分类">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab;
            return (
              <button
                type="button"
                className={`document-switch-tab generation-settings-tab${active ? ' is-active' : ''}`}
                id={`generation-settings-tab-${tab.id}`}
                aria-selected={active}
                aria-controls="generation-settings-panel"
                role="tab"
                tabIndex={active ? 0 : -1}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          className="bid-analysis-workspace generation-settings-panel"
          id="generation-settings-panel"
          aria-labelledby={`generation-settings-tab-${activeTab}`}
          role="tabpanel"
        >
          {activeTab === 'content' ? (
            <fieldset className="generation-settings-option-grid" disabled={outlineModeBusy}>
              <legend className="sr-only">选择投标文件生成范围</legend>
              {documentOptions.map((option, index) => (
                <label className={`generation-settings-option${outlineMode === option.value ? ' is-selected' : ''}`} key={option.value}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <input
                    type="radio"
                    name="technical-plan-outline-mode"
                    value={option.value}
                    checked={outlineMode === option.value}
                    onChange={() => void saveOutlineMode(option.value)}
                  />
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </label>
              ))}
              <div className="generation-settings-option-status" role="status" aria-live="polite">
                {outlineModeBusy
                  ? '正在保存生成范围...'
                  : outlineModeRequiresRegeneration
                    ? '生成范围已改变，当前目录和正文仍保留原结果，重新生成目录后生效。'
                    : ''}
              </div>
            </fieldset>
          ) : activeTab === 'existing-plan' ? (
            <div className="generation-settings-stack">
              <UploadRow
                title="已有技术方案"
                className="generation-settings-existing-upload"
                actions={(
                  <button type="button" className="primary-action" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>
                    {originalPlanBusy ? '处理中...' : originalPlanFile ? '替换' : '上传'}
                  </button>
                )}
                onDropFiles={(files) => {
                  const paths = resolveDroppedFilePaths(files);
                  if (paths.length) void importOriginalPlan(paths);
                }}
                dropDisabled={originalPlanBusy}
              >
                {originalPlanFile ? (
                  <UploadFilePill
                    badge="MD"
                    name={originalPlanFile.fileName}
                    meta={[originalPlanFile.parserLabel, `${originalPlanFile.markdownChars} 字`].filter(Boolean).join(' · ')}
                    onRemove={() => setRemoveDialogOpen(true)}
                    removeLabel="移除"
                    removeDisabled={originalPlanBusy}
                  />
                ) : (
                  <UploadEmpty title="等待已有技术方案" hint="上传后将在目录和正文阶段保留、优化并扩充原方案内容。">
                    <button type="button" className="text-button" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>选择已有方案</button>
                  </UploadEmpty>
                )}
              </UploadRow>
              {originalPlanFile && (
                <section className="outline-generation-config-section outline-expansion-mode-section generation-settings-config-section">
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
                          disabled={outlineConfigLocked || outlineExpansionModeBusy}
                          aria-pressed={selected}
                        >
                          <strong>{option.title}</strong>
                          <span>{option.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="generation-settings-save-row">
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => void saveOutlineExpansionMode()}
                      disabled={outlineConfigLocked || outlineExpansionModeBusy || draftOutlineExpansionMode === outlineExpansionMode}
                    >
                      {outlineExpansionModeBusy ? '正在保存...' : '保存设置'}
                    </button>
                  </div>
                </section>
              )}
            </div>
          ) : activeTab === 'knowledge' ? (
            renderKnowledgePicker()
          ) : activeTab === 'length' ? (
            <section className="outline-word-control-section generation-settings-length-section">
              <div className="content-generation-config-row">
                <span>
                  <strong>全文字数/页数预设</strong>
                  <small>在目录生成阶段，就要预设好全文生成的字数，默认0表示不控制</small>
                </span>
              </div>
              <div className="outline-word-control-options">
                <div className="outline-word-control-grid">
                  <label>
                    <span>最少字数（万）</span>
                    <input inputMode="decimal" value={draftMinimumWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMinimumWords(event.target.value)} onBlur={() => setDraftMinimumWords(formatWordCountDraft(parseWordCountDraft(draftMinimumWords) ?? 0))} />
                  </label>
                  <label>
                    <span>最多字数（万）</span>
                    <input inputMode="decimal" value={draftMaximumWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMaximumWords(event.target.value)} onBlur={() => setDraftMaximumWords(formatWordCountDraft(parseWordCountDraft(draftMaximumWords) ?? 0))} />
                  </label>
                  <label>
                    <span>每小节字数（万）</span>
                    <input inputMode="decimal" value={draftSectionWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => {
                      if (!/^\d*(?:\.\d{0,4})?$/.test(event.target.value)) return;
                      setDraftSectionWords(event.target.value);
                    }} onBlur={() => {
                      const sectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
                      setDraftSectionWords(formatWordCountDraft(sectionWords));
                      if (sectionWords === 0) setDraftStrictSectionWords(false);
                    }} />
                  </label>
                </div>
                <small className="outline-word-control-help">
                  <span>填2代表20000字，0.15代表1500字，默认0表示不控制，AI默认生成多少就是多少。</span>
                  <span>如果<strong className="outline-word-control-highlight">您使用的不是gpt-5.6-sol</strong>，推荐按照您模型的能力上限填写每小节字数，否则扩写过程会非常漫长。</span>
                </small>
                <div className="content-generation-config-row">
                  <span>
                    <strong>强控小节字数</strong>
                    <small>{draftStrictSectionWords ? '强制控制每小节字数必须是预设值的正负 20%' : '仅控制总字数'}</small>
                  </span>
                  <AppSwitch checked={draftStrictSectionWords} onCheckedChange={setDraftStrictSectionWords} disabled={outlineConfigLocked || wordControlBusy || parsedDraftSectionWords === 0} aria-label="强控小节字数，允许范围为预设值的正负 20%" />
                </div>
                <div className="outline-word-control-estimate">
                  <div className="outline-word-control-estimate-label">预估页数</div>
                  <div className="outline-word-control-estimate-value">
                    {estimatedPages === null ? (
                      <span className="outline-word-control-estimate-empty">--</span>
                    ) : (
                      <>
                        <span className="outline-word-control-estimate-number">{estimatedPages}</span>
                        <span className="outline-word-control-estimate-unit">页</span>
                      </>
                    )}
                  </div>
                  <div className="outline-word-control-estimate-hint">
                    {estimatedPages === null ? '请先设置总字数范围' : '页数和排版有关，无法精确预估'}
                  </div>
                </div>
              </div>
              {wordControlRequiresRegeneration && (
                <div className="outline-word-control-notice">
                  {outlineWordControlSnapshot ? '生成目录后若修改了字数设置，需要重新生成目录才能生效！' : '当前目录缺少字数控制生效配置，请重新生成目录。'}
                </div>
              )}
              <div className="generation-settings-save-row">
                <button type="button" className="primary-action" onClick={() => void saveWordControlOptions()} disabled={outlineConfigLocked || wordControlBusy}>
                  {wordControlBusy ? '正在保存...' : '保存设置'}
                </button>
              </div>
            </section>
          ) : (
            <div className="generation-settings-placeholder" role="status">
              <strong>{activeTabLabel}设置待补充</strong>
              <p>当前先保留页面结构，后续按实际规则逐项接入。</p>
            </div>
          )}
        </div>
      </section>

      <AppDialog
        open={removeDialogOpen}
        onOpenChange={(open) => !originalPlanBusy && setRemoveDialogOpen(open)}
        kicker="移除已有方案"
        title="确认切回普通生成模式"
        description="移除后会保留招标文件和解析结果，并清空依赖原方案的目录、全局事实、正文和生成进度。"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setRemoveDialogOpen(false)} disabled={originalPlanBusy}>取消</button>
            <button type="button" className="danger-action" onClick={() => void removeOriginalPlan()} disabled={originalPlanBusy}>
              {originalPlanBusy ? '正在移除...' : '确认移除'}
            </button>
          </>
        )}
      />
    </div>
  );
}

export default GenerationSettingsPage;
