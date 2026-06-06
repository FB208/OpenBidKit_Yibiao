import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FileParserProvider } from '../../../shared/types';
import type { PendingSectionSelection, TechnicalPlanState, TechnicalPlanTenderFile } from '../types';
import BidSectionSelectorDialog from '../components/BidSectionSelectorDialog';

const parserLabels: Record<FileParserProvider, string> = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

interface DocumentAnalysisPageProps {
  tenderFile: TechnicalPlanTenderFile | null;
  tenderMarkdown: string;
  pendingSectionSelection: PendingSectionSelection | null;
  onFileImported: (state: TechnicalPlanState, markdown: string) => void;
  onStateChanged: (state: TechnicalPlanState) => void;
}

function DocumentAnalysisPage({
  tenderFile,
  tenderMarkdown,
  pendingSectionSelection,
  onFileImported,
  onStateChanged,
}: DocumentAnalysisPageProps) {
  const [parserLabel, setParserLabel] = useState(parserLabels.local);
  const [busy, setBusy] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<PendingSectionSelection | null>(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  useEffect(() => {
    let mounted = true;

    const loadParserConfig = async () => {
      if (!window.yibiao) {
        return;
      }

      try {
        const config = await window.yibiao.config.load();
        if (mounted) {
          setParserLabel(parserLabels[config.file_parser.provider] || parserLabels.local);
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

  const importDocument = async () => {
    try {
      setBusy(true);
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
      if (result.state.tenderFile?.parserLabel) {
        setParserLabel(result.state.tenderFile.parserLabel);
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
      setBusy(false);
    }
  };

  const handleSectionSelect = async (sectionId: string) => {
    if (!pendingSelection) return;
    try {
      setBusy(true);
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
      if (result.state.tenderFile?.parserLabel) {
        setParserLabel(result.state.tenderFile.parserLabel);
      }
      showToast(result.message || '已选择标段并导入招标文件', 'success');
      setPendingSelection(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '标段选择失败', 'error');
    } finally {
      setBusy(false);
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

  return (
    <div className={`plan-step-body document-analysis-page${hasSectionHint ? ' has-section-hint' : ''}`}>
      <section className="analysis-import-card">
        <div>
          <span className="section-kicker">STEP 01</span>
          <strong>上传招标文件</strong>
          <p>当前解析方案：{parserLabel}</p>
        </div>
        <div className="analysis-actions">
          <button type="button" className="primary-action" onClick={importDocument} disabled={busy}>
            {busy ? '解析中...' : tenderFile ? '重新选择文件' : '选择文件'}
          </button>
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

      <section className="analysis-markdown-card">
        <div className="analysis-result-head">
          <strong>招标文件内容</strong>
          <span>{tenderFile ? `${tenderFile.fileName} · ${tenderFile.markdownChars} 字` : '等待上传'}</span>
        </div>

        {tenderMarkdown ? (
          <div className="markdown-viewer">
            <MarkdownRenderer>
              {tenderMarkdown}
            </MarkdownRenderer>
          </div>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入招标文件</strong>
            <p>当前步骤只负责把招标文件解析成 Markdown。下一步再基于这里的 Markdown 内容进行 AI 标书理解。</p>
          </div>
        )}
      </section>

      <BidSectionSelectorDialog
        open={Boolean(pendingSelection)}
        sections={pendingSelection?.sections || []}
        totalDeclared={pendingSelection?.totalDeclared}
        onSelect={handleSectionSelect}
        onCancel={handleSectionCancel}
        busy={busy}
      />
    </div>
  );
}

export default DocumentAnalysisPage;
