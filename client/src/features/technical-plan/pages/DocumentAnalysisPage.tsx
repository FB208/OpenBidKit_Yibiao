import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FileParserProvider } from '../../../shared/types';
import type { PendingSectionSelection, TechnicalPlanOriginalPlanFile, TechnicalPlanState, TechnicalPlanTenderFile, TechnicalPlanWorkflowKind } from '../types';
import BidSectionSelectorDialog from '../components/BidSectionSelectorDialog';

type TechnicalPlanDocumentTab = 'tender' | 'originalPlan';
type TechnicalPlanUploadBusy = 'tender' | 'originalPlan' | 'section' | null;

const parserLabels: Record<FileParserProvider, string> = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

const documentTabs: TechnicalPlanDocumentTab[] = ['tender', 'originalPlan'];

const documentLabels: Record<TechnicalPlanDocumentTab, string> = {
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
  tenderMarkdown: string;
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  originalPlanMarkdown: string;
  pendingSectionSelection: PendingSectionSelection | null;
  onFileImported: (state: TechnicalPlanState, markdown: string) => void;
  onOriginalPlanImported: (state: TechnicalPlanState, markdown: string) => void;
  onStateChanged: (state: TechnicalPlanState) => void;
}

function DocumentAnalysisPage({
  workflowKind,
  tenderFile,
  tenderMarkdown,
  originalPlanFile,
  originalPlanMarkdown,
  pendingSectionSelection,
  onFileImported,
  onOriginalPlanImported,
  onStateChanged,
}: DocumentAnalysisPageProps) {
  const [configuredParserLabel, setConfiguredParserLabel] = useState(parserLabels.local);
  const [busy, setBusy] = useState<TechnicalPlanUploadBusy>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingSectionSelection | null>(null);
  const [activeDocumentTab, setActiveDocumentTab] = useState<TechnicalPlanDocumentTab>('tender');
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const isBusy = busy !== null;

  useEffect(() => {
    let mounted = true;

    const loadParserConfig = async () => {
      if (!window.yibiao) {
        return;
      }

      try {
        const config = await window.yibiao.config.load();
        if (mounted) {
          setConfiguredParserLabel(parserLabels[config.file_parser.provider] || parserLabels.local);
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
    setPendingSelection(pendingSectionSelection);
  }, [pendingSectionSelection]);

  useEffect(() => {
    if (!isExpansionWorkflow) {
      setActiveDocumentTab('tender');
    }
  }, [isExpansionWorkflow]);

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

      if (result.needsSectionSelection && result.sections) {
        const nextPendingSelection = {
          fileName: result.fileName || '未命名文件',
          parserLabel: result.parserLabel || undefined,
          sections: result.sections,
          totalDeclared: result.totalDeclared,
        };
        setPendingSelection(nextPendingSelection);
        if (result.state) {
          onStateChanged(result.state);
        }
        return;
      }

      if (!result.state || !result.markdown) {
        showToast('招标文件解析结果为空', 'error');
        return;
      }

      onFileImported(result.state, result.markdown);
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

  const handleSectionSelect = async (sectionId: string) => {
    if (!pendingSelection) return;
    try {
      setBusy('section');
      const selectedSection = pendingSelection.sections.find((section) => section.id === sectionId);
      if (!selectedSection) {
        showToast('未找到选择的投标范围', 'error');
        return;
      }
      const result = await window.yibiao?.technicalPlan.selectBidSection(selectedSection);
      if (!result?.success || !result.state || !result.markdown) {
        showToast(result?.message || '标段选择失败', 'error');
        return;
      }
      onFileImported(result.state, result.markdown);
      showToast(result.message || '已选择标段并导入招标文件', 'success');
      setPendingSelection(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '标段选择失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleSectionCancel = async () => {
    if (!pendingSelection) return;
    try {
      const result = await window.yibiao?.technicalPlan.cancelBidSectionSelection();
      if (result?.state) {
        onStateChanged(result.state);
      }
    } catch {
      // 忽略取消失败
    }
    setPendingSelection(null);
  };

  const selectedSectionTitle = tenderFile?.selectedSectionTitle;
  const selectedSectionHeadLine = tenderFile?.selectedSectionHeadLine;
  const hasSectionHint = Boolean(selectedSectionTitle);
  const visibleDocumentTab = isExpansionWorkflow ? activeDocumentTab : 'tender';
  const activeFile = visibleDocumentTab === 'originalPlan' ? originalPlanFile : tenderFile;
  const activeMarkdown = visibleDocumentTab === 'originalPlan' ? originalPlanMarkdown : tenderMarkdown;
  const readerEmptyText = visibleDocumentTab === 'originalPlan'
    ? '请上传一份已经写好的技术方案，页面会在这里展示解析后的 Markdown 正文。'
    : '当前步骤只负责把招标文件解析成 Markdown。下一步再基于这里的 Markdown 内容进行 AI 标书理解。';

  return (
    <div className={`plan-step-body document-analysis-page technical-document-page${hasSectionHint ? ' has-section-hint' : ''}${isExpansionWorkflow ? ' has-document-tabs' : ''}`}>
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
          {selectedSectionHeadLine && (
            <span className="analysis-section-hint-detail">（{selectedSectionHeadLine.replace(/^.*?(?:标段|标包|分包|包)[：:]\s*/, '')}）</span>
          )}
        </section>
      )}

      {isExpansionWorkflow && (
        <div className="technical-document-tabs" role="tablist" aria-label="技术方案文件正文切换">
          {documentTabs.map((tab) => {
            const isActive = tab === activeDocumentTab;
            return (
              <button
                type="button"
                className={`technical-document-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`technical-document-panel-${tab}`}
                id={`technical-document-tab-${tab}`}
                key={tab}
                onClick={() => setActiveDocumentTab(tab)}
              >
                <strong>{documentLabels[tab]}</strong>
              </button>
            );
          })}
        </div>
      )}

      <section
        className="technical-document-reader-card analysis-markdown-card"
        role={isExpansionWorkflow ? 'tabpanel' : undefined}
        id={isExpansionWorkflow ? `technical-document-panel-${visibleDocumentTab}` : undefined}
        aria-labelledby={isExpansionWorkflow ? `technical-document-tab-${visibleDocumentTab}` : undefined}
      >
        <div className="analysis-result-head technical-document-reader-head">
          <strong>{documentLabels[visibleDocumentTab]}内容</strong>
          <span>{activeFile ? `${activeFile.fileName} · ${activeFile.markdownChars} 字` : '等待上传'}</span>
        </div>

        {activeMarkdown ? (
          <div className="markdown-viewer">
            <MarkdownRenderer>
              {activeMarkdown}
            </MarkdownRenderer>
          </div>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入{documentLabels[visibleDocumentTab]}</strong>
            <p>{readerEmptyText}</p>
          </div>
        )}
      </section>

      <BidSectionSelectorDialog
        open={Boolean(pendingSelection)}
        sections={pendingSelection?.sections || []}
        totalDeclared={pendingSelection?.totalDeclared}
        onSelect={handleSectionSelect}
        onCancel={handleSectionCancel}
        busy={isBusy}
      />
    </div>
  );
}

export default DocumentAnalysisPage;
