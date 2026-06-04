import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownRenderer, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FileParserProvider } from '../../../shared/types';
import type { AttachmentType, TechnicalPlanState, TechnicalPlanTenderFile, TenderAttachment } from '../types';

const parserLabels: Record<FileParserProvider, string> = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

const attachmentTypeLabels: Record<AttachmentType, string> = {
  procurement_list: '采购清单',
  technical_spec: '技术规格',
  reference: '参考说明',
};

interface DocumentAnalysisPageProps {
  tenderFile: TechnicalPlanTenderFile | null;
  tenderMarkdown: string;
  attachments: TenderAttachment[];
  onFileImported: (state: TechnicalPlanState, markdown: string) => void;
  onAttachmentsChanged: (attachments: TenderAttachment[]) => void;
}

function DocumentAnalysisPage({
  tenderFile,
  tenderMarkdown,
  attachments,
  onFileImported,
  onAttachmentsChanged,
}: DocumentAnalysisPageProps) {
  const [parserLabel, setParserLabel] = useState(parserLabels.local);
  const [busy, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<TenderAttachment | null>(null);
  const [previewMarkdown, setPreviewMarkdown] = useState('');
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

  const importDocument = async () => {
    try {
      setBusy(true);
      const result = await window.yibiao?.technicalPlan.importTenderDocument();

      if (!result?.success || !result.markdown) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
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

  const importAttachment = async () => {
    try {
      setAttachmentBusy(true);
      const result = await window.yibiao?.technicalPlan.importAttachment();
      if (!result?.success) {
        showToast(result?.message || '未导入附件', 'error');
        return;
      }
      const updated = await window.yibiao?.technicalPlan.listAttachments();
      onAttachmentsChanged(updated || []);
      showToast('附件已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '附件导入失败';
      showToast(message, 'error');
    } finally {
      setAttachmentBusy(false);
    }
  };

  const deleteAttachment = async (attachmentId: string) => {
    try {
      await window.yibiao?.technicalPlan.deleteAttachment(attachmentId);
      const updated = await window.yibiao?.technicalPlan.listAttachments();
      onAttachmentsChanged(updated || []);
      if (previewAttachment?.attachment_id === attachmentId) {
        setPreviewAttachment(null);
        setPreviewMarkdown('');
      }
      showToast('附件已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除附件失败', 'error');
    }
  };

  const changeAttachmentType = async (attachmentId: string, attachmentType: AttachmentType) => {
    try {
      await window.yibiao?.technicalPlan.setAttachmentType(attachmentId, attachmentType);
      const updated = await window.yibiao?.technicalPlan.listAttachments();
      onAttachmentsChanged(updated || []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '修改附件分类失败', 'error');
    }
  };

  const previewAttachmentContent = async (attachment: TenderAttachment) => {
    try {
      const markdown = await window.yibiao?.technicalPlan.readAttachmentMarkdown(attachment.attachment_id);
      setPreviewAttachment(attachment);
      setPreviewMarkdown(markdown || '');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取附件内容失败', 'error');
    }
  };

  return (
    <div className="plan-step-body">
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

      <section className="analysis-attachments-card">
        <div className="analysis-result-head">
          <strong>招标文件附件</strong>
          {attachments.length > 0 && <span>{attachments.length} 个附件</span>}
        </div>

        {attachments.length > 0 ? (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div key={attachment.attachment_id} className="attachment-item">
                <div className="attachment-info">
                  <span className="attachment-name">{attachment.file_name}</span>
                  <span className="attachment-meta">
                    {attachmentTypeLabels[attachment.attachment_type] || '参考说明'}
                    {' · '}
                    {attachment.markdown_chars > 0 ? `${attachment.markdown_chars} 字` : '解析中…'}
                    {' · '}
                    {attachment.extension?.toUpperCase()}
                  </span>
                </div>
                <div className="attachment-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => previewAttachmentContent(attachment)}
                    disabled={!attachment.markdown_path}
                  >
                    预览
                  </button>
                  <select
                    className="type-select"
                    value={attachment.attachment_type}
                    onChange={(e) => changeAttachmentType(attachment.attachment_id, e.target.value as AttachmentType)}
                  >
                    <option value="procurement_list">采购清单</option>
                    <option value="technical_spec">技术规格</option>
                    <option value="reference">参考说明</option>
                  </select>
                  <button
                    type="button"
                    className="text-button"
                    style={{ color: '#c83220' }}
                    onClick={() => deleteAttachment(attachment.attachment_id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="attachment-empty">
            <p>如果招标文件中含有 "请详见附件" 的采购清单、技术规格或图纸文件，请将附件上传到这里，AI 会在生成标书时自动引用。</p>
          </div>
        )}

        <div className="attachment-footer">
          <button
            type="button"
            className="secondary-action"
            onClick={importAttachment}
            disabled={attachmentBusy}
          >
            {attachmentBusy ? '导入中…' : '添加附件'}
          </button>
        </div>

        {previewAttachment && previewMarkdown && (
          <div className="attachment-preview">
            <div className="analysis-result-head">
              <strong>{previewAttachment.file_name}</strong>
              <button
                type="button"
                className="text-button"
                onClick={() => { setPreviewAttachment(null); setPreviewMarkdown(''); }}
              >
                关闭预览
              </button>
            </div>
            <div className="markdown-viewer">
              <MarkdownRenderer>
                {previewMarkdown}
              </MarkdownRenderer>
            </div>
          </div>
        )}
      </section>

    </div>
  );
}

export default DocumentAnalysisPage;
