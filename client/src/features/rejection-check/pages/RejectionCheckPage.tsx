import { useEffect, useRef, useState } from 'react';
import { FloatingToolbar, isLibreOfficeRequiredMessage, MarkdownRenderer, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { RejectionCheckWorkspaceState, RejectionDocumentContent, RejectionDocumentRole, RejectionDocumentSource } from '../types';

interface TechnicalPlanSnapshot {
  fileName?: string;
  fileContent?: string;
}

const documentTabs: RejectionDocumentRole[] = ['tender', 'bid'];

const documentLabels: Record<RejectionDocumentRole, string> = {
  tender: '招标文件',
  bid: '投标文件',
};

const sourceLabels: Record<RejectionDocumentSource, string> = {
  upload: '上传解析',
  'technical-plan': '技术方案',
};

function formatCharacterCount(length: number) {
  if (length >= 10000) return `${(length / 10000).toFixed(1)} 万字`;
  return `${length} 字`;
}

function formatContentLength(content: string) {
  return formatCharacterCount(content.trim().length);
}

function formatImportedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function getFileBadge(document: RejectionDocumentContent) {
  if (document.source === 'technical-plan') return '方案';
  const extension = document.fileName.split('.').pop()?.trim();
  return extension ? extension.slice(0, 4).toUpperCase() : 'DOC';
}

function createDocumentContent(
  role: RejectionDocumentRole,
  source: RejectionDocumentSource,
  fileName: string,
  content: string,
  parserLabel?: string,
): RejectionDocumentContent {
  return {
    role,
    fileName,
    content,
    source,
    parserLabel,
    importedAt: new Date().toISOString(),
  };
}

function DocumentFilePill({ document, onRemove }: { document: RejectionDocumentContent; onRemove: () => void }) {
  return (
    <article className="rejection-file-pill">
      <div className="rejection-file-icon">{getFileBadge(document)}</div>
      <div className="rejection-file-info">
        <strong title={document.fileName}>{document.fileName}</strong>
        <span>{sourceLabels[document.source]} · {formatContentLength(document.content)} · {formatImportedAt(document.importedAt)}</span>
      </div>
      <button type="button" onClick={onRemove} aria-label={`移除${documentLabels[document.role]}`}>
        移除
      </button>
    </article>
  );
}

function RejectionCheckPage() {
  const [tenderDocument, setTenderDocument] = useState<RejectionDocumentContent | null>(null);
  const [bidDocument, setBidDocument] = useState<RejectionDocumentContent | null>(null);
  const [activeDocumentTab, setActiveDocumentTab] = useState<RejectionDocumentRole>('tender');
  const [busy, setBusy] = useState<'technical-plan' | 'tender-upload' | 'bid-upload' | null>(null);
  const hydratedRef = useRef(false);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const activeDocument = activeDocumentTab === 'tender' ? tenderDocument : bidDocument;
  const hasAnyDocument = Boolean(tenderDocument || bidDocument);
  const canGoNext = Boolean(tenderDocument && bidDocument);

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.workspace.loadRejectionCheck()
      .then((state) => {
        if (canceled || !state) return;
        setTenderDocument(state.tenderDocument || null);
        setBidDocument(state.bidDocument || null);
        setActiveDocumentTab(state.activeDocumentTab === 'bid' ? 'bid' : 'tender');
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取废标项检查缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    const state: RejectionCheckWorkspaceState = {
      tenderDocument,
      bidDocument,
      activeDocumentTab,
    };
    void window.yibiao?.workspace.saveRejectionCheck(state)
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存废标项检查缓存失败', 'error');
      });
  }, [activeDocumentTab, bidDocument, showToast, tenderDocument]);

  async function importParsedDocument(role: RejectionDocumentRole) {
    const documentLabel = documentLabels[role];
    try {
      const importer = window.yibiao?.file.importRejectionCheckDocument;
      if (typeof importer !== 'function') {
        throw new Error('文件解析接口尚未加载，请重启应用后重试');
      }

      setBusy(role === 'tender' ? 'tender-upload' : 'bid-upload');
      const result = await importer(role);

      if (!result?.success || !result.file_content) {
        const message = result?.message || `未选择${documentLabel}`;
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      const nextDocument = createDocumentContent(
        role,
        'upload',
        result.file_name || documentLabel,
        result.file_content,
        result.parser_label,
      );
      if (role === 'tender') {
        setTenderDocument(nextDocument);
      } else {
        setBidDocument(nextDocument);
      }
      setActiveDocumentTab(role);
      showToast(`${documentLabel}已解析`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : `${documentLabel}解析失败`;
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function readTenderFromTechnicalPlan() {
    const loader = window.yibiao?.workspace.loadTechnicalPlan;
    if (typeof loader !== 'function') {
      showToast('技术方案缓存接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    try {
      setBusy('technical-plan');
      const technicalPlan = await loader<TechnicalPlanSnapshot>();
      if (!technicalPlan?.fileContent?.trim()) {
        showToast('技术方案中暂无可读取的招标文件正文', 'info');
        return;
      }

      setTenderDocument(createDocumentContent(
        'tender',
        'technical-plan',
        technicalPlan.fileName || '技术方案招标文件',
        technicalPlan.fileContent,
      ));
      setActiveDocumentTab('tender');
      showToast('已从技术方案读取招标文件', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取技术方案招标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  function removeDocument(role: RejectionDocumentRole) {
    if (role === 'tender') {
      setTenderDocument(null);
    } else {
      setBidDocument(null);
    }
  }

  function resetWorkspace() {
    setTenderDocument(null);
    setBidDocument(null);
    setActiveDocumentTab('tender');
    void window.yibiao?.workspace.clearRejectionCheck()
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空废标项检查缓存失败', 'error');
      });
    showToast('已重置废标项检查文件', 'success');
  }

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'rejection-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          disabled: !hasAnyDocument || busy !== null,
          tooltip: '清空当前废标项检查文件',
          onClick: resetWorkspace,
        },
        {
          id: 'home',
          label: '首页',
          variant: 'primary',
          tooltip: '回到选择标书',
          onClick: () => setActiveDocumentTab('tender'),
        },
      ],
    },
    {
      id: 'rejection-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: true,
          tooltip: '当前已经是第一步',
          onClick: () => undefined,
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: !canGoNext,
          tooltip: canGoNext ? '进入废标项检查结果' : '请先准备招标文件和投标文件',
          onClick: () => showToast('废标项检查结果将在下一步接入', 'info'),
        },
      ],
    },
  ];

  return (
    <div className="rejection-check-page">
      <section className="rejection-upload-board">
        <div className="rejection-page-title">
          <div>
            <span className="section-kicker">STEP 01</span>
            <h2>选择标书</h2>
          </div>
        </div>

        <div className="rejection-upload-stack">
          <article className="rejection-upload-row">
            <div className="rejection-upload-label">
              <span>01</span>
              <strong>招标文件</strong>
            </div>
            <div className="rejection-upload-content">
              {tenderDocument ? (
                <DocumentFilePill document={tenderDocument} onRemove={() => removeDocument('tender')} />
              ) : (
                <div className="rejection-empty-upload">
                  <strong>等待招标文件</strong>
                  <span>用于识别废标条款、响应格式和强制性要求。</span>
                </div>
              )}
            </div>
            <div className="rejection-upload-actions">
              <button type="button" className="secondary-action" onClick={readTenderFromTechnicalPlan} disabled={busy !== null}>
                {busy === 'technical-plan' ? '读取中...' : '从技术方案读取'}
              </button>
              <button type="button" className="primary-action" onClick={() => void importParsedDocument('tender')} disabled={busy !== null}>
                {busy === 'tender-upload' ? '解析中...' : tenderDocument ? '替换' : '上传'}
              </button>
            </div>
          </article>

          <article className="rejection-upload-row bid-row">
            <div className="rejection-upload-label">
              <span>02</span>
              <strong>投标文件</strong>
            </div>
            <div className="rejection-upload-content">
              {bidDocument ? (
                <DocumentFilePill document={bidDocument} onRemove={() => removeDocument('bid')} />
              ) : (
                <div className="rejection-empty-upload">
                  <strong>等待投标文件</strong>
                  <span>重新上传会直接替换当前投标文件。</span>
                </div>
              )}
            </div>
            <div className="rejection-upload-actions single-action">
              <button type="button" className="primary-action" onClick={() => void importParsedDocument('bid')} disabled={busy !== null}>
                {busy === 'bid-upload' ? '解析中...' : bidDocument ? '替换' : '上传'}
              </button>
            </div>
          </article>
        </div>
      </section>

      <div className="rejection-document-tabs" role="tablist" aria-label="废标项检查正文切换">
        {documentTabs.map((tab) => {
          const isActive = tab === activeDocumentTab;
          return (
            <button
              type="button"
              className={`rejection-document-tab${isActive ? ' is-active' : ''}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`rejection-document-panel-${tab}`}
              id={`rejection-document-tab-${tab}`}
              key={tab}
              onClick={() => setActiveDocumentTab(tab)}
            >
              <strong>{documentLabels[tab]}</strong>
            </button>
          );
        })}
      </div>

      <section
        className="rejection-reader-card analysis-markdown-card"
        role="tabpanel"
        id={`rejection-document-panel-${activeDocumentTab}`}
        aria-labelledby={`rejection-document-tab-${activeDocumentTab}`}
      >
        <div className="analysis-result-head rejection-reader-head">
          <strong>{documentLabels[activeDocumentTab]}正文</strong>
          <span>{activeDocument ? `${activeDocument.fileName} · ${sourceLabels[activeDocument.source]}` : '等待上传'}</span>
        </div>

        {activeDocument ? (
          <div className="markdown-viewer rejection-markdown-viewer">
            <MarkdownRenderer>
              {activeDocument.content}
            </MarkdownRenderer>
          </div>
        ) : (
          <div className="markdown-empty-state rejection-empty-reader">
            <strong>尚未准备{documentLabels[activeDocumentTab]}</strong>
            <p>{activeDocumentTab === 'tender' ? '可从技术方案读取招标文件，也可以直接上传并解析成 Markdown。' : '请上传一份投标文件，页面会在这里展示解析后的 Markdown 正文。'}</p>
          </div>
        )}
      </section>

      <FloatingToolbar groups={toolbarGroups} label="废标项检查工具条" />
    </div>
  );
}

export default RejectionCheckPage;
