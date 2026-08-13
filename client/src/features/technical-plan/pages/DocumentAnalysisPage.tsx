import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, UploadBoard, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FileParserProvider } from '../../../shared/types';
import type { TechnicalPlanOriginalPlanFile, TechnicalPlanState, TechnicalPlanTenderFile, TechnicalPlanTenderSourceFile, TechnicalPlanWorkflowKind } from '../types';

type TechnicalPlanUploadBusy = 'tender' | 'originalPlan' | null;

const parserLabels: Record<FileParserProvider, string> = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

const documentLabels = {
  tender: '招标文件',
  originalPlan: '原方案',
};

function DocumentFilePill({ file, onRemove, removeDisabled = false }: { file: TechnicalPlanTenderFile | TechnicalPlanTenderSourceFile | TechnicalPlanOriginalPlanFile; onRemove?: () => void; removeDisabled?: boolean }) {
  return (
    <UploadFilePill
      badge="MD"
      name={file.fileName}
      meta={[file.parserLabel, `${file.markdownChars} 字`].filter(Boolean).join(' · ')}
      onRemove={onRemove}
      removeDisabled={removeDisabled}
    />
  );
}

interface DocumentAnalysisPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  tenderFile: TechnicalPlanTenderFile | null;
  tenderFiles: TechnicalPlanTenderSourceFile[];
  tenderMarkdown: string;
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  originalPlanMarkdown: string;
  onFileImported: (state: TechnicalPlanState, markdown: string) => void;
  onOriginalPlanImported: (state: TechnicalPlanState, markdown: string) => void;
}

function DocumentAnalysisPage({
  workflowKind,
  tenderFile,
  tenderFiles,
  tenderMarkdown,
  originalPlanFile,
  originalPlanMarkdown,
  onFileImported,
  onOriginalPlanImported,
}: DocumentAnalysisPageProps) {
  const [configuredParserLabel, setConfiguredParserLabel] = useState(parserLabels.local);
  const [busy, setBusy] = useState<TechnicalPlanUploadBusy>(null);
  const [activeDocumentTab, setActiveDocumentTab] = useState('tender');
  const [tenderSourceMarkdowns, setTenderSourceMarkdowns] = useState<Record<string, string>>({});
  const [loadingTenderSourceId, setLoadingTenderSourceId] = useState('');
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const isBusy = busy !== null;
  const firstTenderSourceId = tenderFiles[0]?.id || '';

  useEffect(() => {
    let mounted = true;

    const loadParserConfig = async () => {
      if (!window.yibiao) {
        return;
      }

      try {
        const config = await window.yibiao.config.load();
        if (mounted) {
          setConfiguredParserLabel(parserLabels[config.components?.file_parser?.provider] || parserLabels.local);
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取文件解析配置失败', 'error');
      }
    };

    loadParserConfig();

    return () => {
      mounted = false;
    };
  }, [showToast]);

  useEffect(() => {
    if (isExpansionWorkflow) return;
    if (!firstTenderSourceId) {
      setActiveDocumentTab('tender');
      return;
    }
    const activeTenderSourceId = activeDocumentTab.startsWith('tender:') ? activeDocumentTab.slice('tender:'.length) : '';
    if (!activeTenderSourceId || !tenderFiles.some((file) => file.id === activeTenderSourceId)) {
      setActiveDocumentTab(`tender:${firstTenderSourceId}`);
    }
  }, [activeDocumentTab, firstTenderSourceId, isExpansionWorkflow, tenderFiles]);

  useEffect(() => {
    if (activeDocumentTab.startsWith('tender:')) return;
    if (activeDocumentTab === 'originalPlan') return;
    if (firstTenderSourceId) {
      setActiveDocumentTab(`tender:${firstTenderSourceId}`);
    }
  }, [activeDocumentTab, firstTenderSourceId]);

  useEffect(() => {
    if (!activeDocumentTab.startsWith('tender:')) return;
    const sourceId = activeDocumentTab.slice('tender:'.length);
    if (!sourceId || tenderSourceMarkdowns[sourceId] !== undefined) return;
    let mounted = true;
    setLoadingTenderSourceId(sourceId);
    window.yibiao?.technicalPlan.readTenderSourceMarkdown(sourceId).then((markdown) => {
      if (mounted) {
        setTenderSourceMarkdowns((prev) => ({ ...prev, [sourceId]: markdown || '' }));
      }
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取招标文件正文失败', 'error');
    }).finally(() => {
      if (mounted) setLoadingTenderSourceId((current) => (current === sourceId ? '' : current));
    });
    return () => {
      mounted = false;
    };
  }, [activeDocumentTab, showToast, tenderSourceMarkdowns]);

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  const importTenderDocument = async (filePaths?: string[]) => {
    try {
      setBusy('tender');
      const result = await window.yibiao?.technicalPlan.importTenderDocument(filePaths);

      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' || message.startsWith('已跳过') ? 'info' : 'error');
        return;
      }

      if (!result.markdown) {
        showToast('招标文件解析结果为空', 'error');
        return;
      }

      const state = await window.yibiao.technicalPlan.loadState();
      onFileImported(state, result.markdown);
      const lastSource = state.tenderFiles?.[state.tenderFiles.length - 1];
      if (lastSource) {
        setTenderSourceMarkdowns(state.tenderFiles.length === 1 ? { [lastSource.id]: result.markdown } : {});
        setActiveDocumentTab(`tender:${lastSource.id}`);
      }
      showToast(result.message || '招标文件已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件解析失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const removeTenderDocument = async (sourceId: string) => {
    try {
      setBusy('tender');
      const result = await window.yibiao?.technicalPlan.removeTenderDocument(sourceId);
      if (!result?.success) {
        showToast(result?.message || '移除招标文件失败', 'error');
        return;
      }
      const state = await window.yibiao.technicalPlan.loadState();
      onFileImported(state, result.markdown || '');
      const firstSource = state.tenderFiles?.[0];
      if (firstSource) {
        setTenderSourceMarkdowns(state.tenderFiles.length === 1 ? { [firstSource.id]: result.markdown || '' } : {});
        setActiveDocumentTab(`tender:${firstSource.id}`);
      } else {
        setTenderSourceMarkdowns({});
        setActiveDocumentTab('tender');
      }
      showToast(result.message || '已移除招标文件', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移除招标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const importOriginalPlanDocument = async (filePaths?: string[]) => {
    try {
      setBusy('originalPlan');
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
        showToast('原方案解析结果为空', 'error');
        return;
      }

      const state = await window.yibiao.technicalPlan.loadState();
      onOriginalPlanImported(state, result.markdown);
      setActiveDocumentTab('originalPlan');
      showToast(result.message || '原方案已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件解析失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const selectedSectionTitle = tenderFile?.selectedSectionTitle;
  const hasSectionHint = Boolean(selectedSectionTitle);
  const activeTenderSource = activeDocumentTab.startsWith('tender:')
    ? tenderFiles.find((file) => file.id === activeDocumentTab.slice('tender:'.length)) || null
    : null;
  const visibleDocumentTab = activeDocumentTab === 'originalPlan' ? 'originalPlan' : 'tender';
  const activeFile = visibleDocumentTab === 'originalPlan' ? originalPlanFile : activeTenderSource || tenderFile;
  const activeMarkdown = visibleDocumentTab === 'originalPlan'
    ? originalPlanMarkdown
    : activeTenderSource
      ? tenderSourceMarkdowns[activeTenderSource.id] || ''
      : tenderMarkdown;
  const readerEmptyText = visibleDocumentTab === 'originalPlan'
    ? '请上传一份已经写好的技术方案，页面会在这里展示解析后的 Markdown 正文。'
    : '当前步骤只负责把招标文件解析成 Markdown。下一步再基于这里的 Markdown 内容进行 AI 标书理解。';
  const documentTabs = [
    ...(tenderFiles.length ? tenderFiles.map((file, index) => ({ id: `tender:${file.id}`, label: `招标文件${index + 1}` })) : [{ id: 'tender', label: '招标文件' }]),
    ...(isExpansionWorkflow ? [{ id: 'originalPlan', label: '原方案' }] : []),
  ];
  const hasDocumentTabs = isExpansionWorkflow || tenderFiles.length > 1;
  const activeTenderSourceLoading = activeTenderSource && loadingTenderSourceId === activeTenderSource.id;

  return (
    <div className={`plan-step-body document-analysis-page technical-document-page${hasSectionHint ? ' has-section-hint' : ''}${hasDocumentTabs ? ' has-document-tabs' : ''}`}>
      <UploadBoard kicker="STEP 01" title="选择标书" subtitle={`默认解析方案：${configuredParserLabel}`}>
        <UploadRow
          index="01"
          title="招标文件"
          onDropFiles={(files) => {
            const paths = resolveDroppedFilePaths(files);
            if (paths.length) void importTenderDocument(paths);
          }}
          dropDisabled={isBusy}
          actions={(
            <button type="button" className="primary-action" onClick={() => void importTenderDocument()} disabled={isBusy}>
              {busy === 'tender' ? '解析中...' : tenderFiles.length ? '继续上传' : '上传'}
            </button>
          )}
        >
          {tenderFiles.length ? (
            <div className="upload-file-list">
              {tenderFiles.map((file) => (
                <DocumentFilePill
                  key={file.id}
                  file={file}
                  onRemove={() => void removeTenderDocument(file.id)}
                  removeDisabled={isBusy}
                />
              ))}
            </div>
          ) : (
            <UploadEmpty title="等待招标文件" hint="用于解析项目概况、技术要求、评分项和后续正文约束。">
              <button type="button" className="text-button" onClick={() => void importTenderDocument()} disabled={isBusy}>选择招标文件</button>
            </UploadEmpty>
          )}
        </UploadRow>

        {isExpansionWorkflow && (
          <UploadRow
            index="02"
            title="原方案"
            onDropFiles={(files) => {
              const paths = resolveDroppedFilePaths(files);
              if (paths.length) void importOriginalPlanDocument(paths);
            }}
            dropDisabled={isBusy}
            actions={(
              <button type="button" className="primary-action" onClick={() => void importOriginalPlanDocument()} disabled={isBusy}>
                {busy === 'originalPlan' ? '解析中...' : originalPlanFile ? '替换' : '上传'}
              </button>
            )}
          >
            {originalPlanFile ? (
              <DocumentFilePill file={originalPlanFile} />
            ) : (
              <UploadEmpty title="等待原方案" hint="上传已经写好的技术方案，后续用于优化和扩充。">
                <button type="button" className="text-button" onClick={() => void importOriginalPlanDocument()} disabled={isBusy}>导入原方案</button>
              </UploadEmpty>
            )}
          </UploadRow>
        )}
      </UploadBoard>

      {selectedSectionTitle && (
        <section className="analysis-section-hint">
          <strong>投标范围：</strong>
          <span>{selectedSectionTitle}</span>
        </section>
      )}

      {hasDocumentTabs && (
        <div className="document-switch-tabs" role="tablist" aria-label="技术方案文件正文切换">
          {documentTabs.map((tab) => {
            const isActive = tab.id === activeDocumentTab;
            return (
              <button
                type="button"
                className={`document-switch-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`technical-document-panel-${tab.id}`}
                id={`document-switch-tab-${tab.id}`}
                key={tab.id}
                onClick={() => setActiveDocumentTab(tab.id)}
              >
                <strong>{tab.label}</strong>
              </button>
            );
          })}
        </div>
      )}

      <section
        className="technical-document-reader-card analysis-markdown-card"
        role={hasDocumentTabs ? 'tabpanel' : undefined}
        id={hasDocumentTabs ? `technical-document-panel-${activeDocumentTab}` : undefined}
        aria-labelledby={hasDocumentTabs ? `document-switch-tab-${activeDocumentTab}` : undefined}
      >
        <div className="analysis-result-head technical-document-reader-head">
          <strong>{documentLabels[visibleDocumentTab]}内容</strong>
          <span>{activeFile ? `${activeFile.fileName} · ${activeFile.markdownChars} 字` : '等待上传'}</span>
        </div>

        {activeTenderSourceLoading ? (
          <div className="markdown-empty-state">
            <strong>正在读取招标文件正文...</strong>
            <p>文件较大时需要稍等片刻。</p>
          </div>
        ) : activeMarkdown ? (
          <MarkdownFullscreenViewer title={`${documentLabels[visibleDocumentTab]}全屏预览`}>
            <MarkdownRenderer>
              {activeMarkdown}
            </MarkdownRenderer>
          </MarkdownFullscreenViewer>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入{documentLabels[visibleDocumentTab]}</strong>
            <p>{readerEmptyText}</p>
          </div>
        )}
      </section>
    </div>
  );
}

export default DocumentAnalysisPage;
