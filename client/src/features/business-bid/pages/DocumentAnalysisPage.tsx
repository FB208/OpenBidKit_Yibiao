import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { BusinessBidState, BusinessBidTenderFile } from '../types';
import { KnowledgeReferencePicker } from '../components/KnowledgeReferencePicker';

interface DocumentAnalysisPageProps {
  tenderFile: BusinessBidTenderFile | null;
  tenderMarkdown: string;
  referenceTechnicalPlan: boolean;
  referenceTechnicalPlanSummary?: string;
  referenceKnowledgeDocumentIds: string[];
  referenceKnowledgeSnippetIds: string[];
  hasTechnicalPlan: boolean;
  onTenderImported: (state: BusinessBidState, markdown: string) => void;
  onStateChange: (state: BusinessBidState) => void;
}

function DocumentFilePill({ file }: { file: BusinessBidTenderFile }) {
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

export default function DocumentAnalysisPage({
  tenderFile,
  tenderMarkdown,
  referenceTechnicalPlan,
  referenceTechnicalPlanSummary,
  referenceKnowledgeDocumentIds,
  referenceKnowledgeSnippetIds,
  hasTechnicalPlan,
  onTenderImported,
  onStateChange,
}: DocumentAnalysisPageProps) {
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const [busy, setBusy] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [localDocIds, setLocalDocIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [localSnippetIds, setLocalSnippetIds] = useState<string[]>(referenceKnowledgeSnippetIds);

  useEffect(() => {
    setLocalDocIds(referenceKnowledgeDocumentIds);
    setLocalSnippetIds(referenceKnowledgeSnippetIds);
  }, [referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds]);

  const importTenderDocument = async () => {
    try {
      setBusy(true);
      const result = await window.yibiao?.businessBid.importTenderDocument();
      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      if (!result.state || result.markdown === undefined) {
        showToast('招标文件解析结果为空', 'error');
        return;
      }
      onTenderImported(result.state, result.markdown);
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

  const toggleTechnicalPlan = async (next: boolean) => {
    if (!hasTechnicalPlan && next) {
      showToast('尚未生成技术方案，无法关联', 'info');
      return;
    }
    try {
      setAssociating(true);
      const state = next
        ? await window.yibiao?.businessBid.associateTechnicalPlan()
        : await window.yibiao?.businessBid.disassociateTechnicalPlan();
      if (state) {
        onStateChange(state);
        showToast(next ? '已关联技术方案' : '已取消关联技术方案', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换技术方案关联失败', 'error');
    } finally {
      setAssociating(false);
    }
  };

  const saveKnowledge = async (nextDocIds: string[], nextSnippetIds: string[]) => {
    setLocalDocIds(nextDocIds);
    setLocalSnippetIds(nextSnippetIds);
    try {
      const state = await window.yibiao?.businessBid.saveOutlineConfig({
        referenceKnowledgeDocumentIds: nextDocIds,
        referenceKnowledgeSnippetIds: nextSnippetIds,
      });
      if (state) onStateChange(state);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存参考知识库失败', 'error');
    }
  };

  return (
    <div className="plan-step-body document-analysis-page business-document-page">
      <section className="technical-document-upload-board">
        <div className="technical-document-page-title">
          <div>
            <span className="section-kicker">STEP 01</span>
            <h2>导入招标文件</h2>
            <p>解析商务条款、报价口径和合同约束，作为商务标编制的基础。</p>
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
                  <span>用于解析付款、质保、履约、报价有效期等商务条款。</span>
                </div>
              )}
            </div>
            <div className="technical-document-upload-actions">
              <button type="button" className="primary-action" onClick={() => void importTenderDocument()} disabled={busy}>
                {busy ? '解析中...' : tenderFile ? '替换' : '上传'}
              </button>
            </div>
          </article>
        </div>
      </section>

      <section className="business-reference-board">
        <div className="business-reference-head">
          <span className="section-kicker">STEP 01 · 关联上下文</span>
          <h3>可选参考上下文</h3>
          <p>关联已生成的技术方案，并挑选知识库文档/片段作为生成素材。</p>
        </div>

        <article className="business-reference-block">
          <div className="business-reference-block-head">
            <strong>关联技术方案</strong>
            <span>{referenceTechnicalPlan ? '已关联' : '未关联'}</span>
          </div>
          <div className="business-reference-toggle">
            <button
              type="button"
              className={`business-switch${referenceTechnicalPlan ? ' is-on' : ''}`}
              role="switch"
              aria-checked={referenceTechnicalPlan}
              disabled={associating || !hasTechnicalPlan}
              onClick={() => void toggleTechnicalPlan(!referenceTechnicalPlan)}
            >
              <span className="business-switch-thumb" />
            </button>
            <div className="business-reference-block-text">
              {hasTechnicalPlan ? (
                <span>{referenceTechnicalPlan ? '已引用技术方案目录/正文/全局事实作为上下文。' : '开启后，正文与事实设定会引用技术方案已确认内容。'}</span>
              ) : (
                <span>尚未生成技术方案，无法关联。可先在技术方案工作台完成编制。</span>
              )}
            </div>
          </div>
          {referenceTechnicalPlan && referenceTechnicalPlanSummary && (
            <div className="business-technical-summary">
              <div className="analysis-result-head">
                <strong>技术方案摘要</strong>
                <span>{referenceTechnicalPlanSummary.length} 字</span>
              </div>
              <MarkdownFullscreenViewer className="markdown-viewer bid-technical-summary-preview" title="技术方案上下文全屏预览">
                <MarkdownRenderer>{referenceTechnicalPlanSummary.slice(0, 6000)}</MarkdownRenderer>
              </MarkdownFullscreenViewer>
            </div>
          )}
        </article>

        <article className="business-reference-block">
          <div className="business-reference-block-head">
            <strong>参考知识库</strong>
            <span>已选 {localDocIds.length} 文档 / {localSnippetIds.length} 片段</span>
          </div>
          <KnowledgeReferencePicker
            documentIds={localDocIds}
            snippetIds={localSnippetIds}
            onChange={(docIds, snippetIds) => void saveKnowledge(docIds, snippetIds)}
          />
        </article>
      </section>

      <section className="technical-document-reader-card analysis-markdown-card">
        <div className="analysis-result-head technical-document-reader-head">
          <strong>招标文件内容</strong>
          <span>{tenderFile ? `${tenderFile.fileName} · ${tenderFile.markdownChars} 字` : '等待上传'}</span>
        </div>
        {tenderMarkdown ? (
          <MarkdownFullscreenViewer title="招标文件全屏预览">
            <MarkdownRenderer>{tenderMarkdown}</MarkdownRenderer>
          </MarkdownFullscreenViewer>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入招标文件</strong>
            <p>上传招标文件后，这里会展示解析后的 Markdown 正文。</p>
          </div>
        )}
      </section>
    </div>
  );
}
