import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
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

function DocumentFilePill({ file }: { file: TechnicalPlanTenderFile | TechnicalPlanOriginalPlanFile }) {
  return (
    <div className="technical-document-file-pill">
      <div className="technical-document-file-icon">MD</div>
      <div className="technical-document-file-info">
        <strong>{file.fileName}</strong>
        <span>{[file.parserLabel, `${file.markdownChars} 字`].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
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

  const importTenderDocument = async () => {
    try {
      setBusy('tender');
      const result = await window.yibiao?.technicalPlan.importTenderDocument();

      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      if (!result.state || !result.markdown) {
        showToast('招标文件解析结果为空', 'error');
        return;
      }

      onFileImported(result.state, result.markdown);
      const firstSource = result.state.tenderFiles?.[0];
      if (firstSource) {
        setTenderSourceMarkdowns(result.state.tenderFiles?.length === 1 ? { [firstSource.id]: result.markdown } : {});
        setActiveDocumentTab(`tender:${firstSource.id}`);
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

  const importOriginalPlanDocument = async () => {
    try {
      setBusy('originalPlan');
      const result = await window.yibiao?.technicalPlan.importOriginalPlanDocument();

      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      if (!result.state || !result.markdown) {
        showToast('原方案解析结果为空', 'error');
        return;
      }

      onOriginalPlanImported(result.state, result.markdown);
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
      <section className="technical-document-upload-board">
        <div className="technical-document-page-title">
          <div>
            <span className="section-kicker">STEP 01</span>
            <h2>选择标书</h2>
            <p>默认解析方案：{configuredParserLabel}</p>
          </div>
        </div>

        <div className="technical-document-upload-stack">
          <article className="technical-document-upload-row">
            <div className="technical-document-upload-label">
              <span>01</span>
              <strong>招标文件</strong>
            </div>
            <div className="technical-document-upload-content">
              {tenderFile ? (
                <DocumentFilePill file={tenderFile} />
              ) : (
                <div className="technical-document-empty-upload">
                  <strong>等待招标文件</strong>
                  <span>用于解析项目概况、技术要求、评分项和后续正文约束。</span>
                </div>
              )}
            </div>
            <div className="technical-document-upload-actions">
              <button type="button" className="primary-action" onClick={() => void importTenderDocument()} disabled={isBusy}>
                {busy === 'tender' ? '解析中...' : tenderFile ? '替换' : '上传'}
              </button>
            </div>
          </article>

          {isExpansionWorkflow && (
            <article className="technical-document-upload-row original-plan-row">
              <div className="technical-document-upload-label">
                <span>02</span>
                <strong>原方案</strong>
              </div>
              <div className="technical-document-upload-content">
                {originalPlanFile ? (
                  <DocumentFilePill file={originalPlanFile} />
                ) : (
                  <div className="technical-document-empty-upload">
                    <strong>等待原方案</strong>
                    <span>上传已经写好的技术方案，后续用于优化和扩充。</span>
                  </div>
                )}
              </div>
              <div className="technical-document-upload-actions">
                <button type="button" className="primary-action" onClick={() => void importOriginalPlanDocument()} disabled={isBusy}>
                  {busy === 'originalPlan' ? '解析中...' : originalPlanFile ? '替换' : '上传'}
                </button>
              </div>
            </article>
          )}
        </div>
      </section>

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
