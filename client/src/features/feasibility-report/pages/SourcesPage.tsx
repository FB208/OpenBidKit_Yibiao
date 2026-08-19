import { useEffect, useState } from 'react';
import { isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, UploadBoard, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FeasibilitySourceFile } from '../types';

interface SourcesPageProps {
  sourceFiles: FeasibilitySourceFile[];
  busy: boolean;
  onImport: (filePaths?: string[]) => Promise<void>;
  onRemove: (sourceId: string) => Promise<void>;
}

function resolveDroppedFilePaths(files: FileList) {
  return Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);
}

function SourcesPage({ sourceFiles, busy, onImport, onRemove }: SourcesPageProps) {
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const [activeSourceId, setActiveSourceId] = useState(sourceFiles[0]?.id || '');
  const [sourceMarkdown, setSourceMarkdown] = useState('');
  const [parserLabel, setParserLabel] = useState('本地解析');
  const activeFile = sourceFiles.find((file) => file.id === activeSourceId) || sourceFiles[0] || null;
  const hasDocumentTabs = sourceFiles.length > 1;

  useEffect(() => {
    void window.yibiao?.config.load().then((config) => {
      const provider = config.components?.file_parser?.provider;
      setParserLabel(provider === 'local' || !provider ? '本地解析' : provider);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setActiveSourceId((prev) => (sourceFiles.some((file) => file.id === prev) ? prev : (sourceFiles[0]?.id || '')));
  }, [sourceFiles]);

  useEffect(() => {
    let mounted = true;
    if (!activeFile) {
      setSourceMarkdown('');
      return undefined;
    }
    window.yibiao?.feasibilityReport.readSourceMarkdown(activeFile.id).then((markdown) => {
      if (mounted) setSourceMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取资料失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [activeFile, showToast]);

  const handleImport = async (filePaths?: string[]) => {
    try {
      await onImport(filePaths);
    } catch (error) {
      const message = error instanceof Error ? error.message : '资料导入失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    }
  };

  return (
    <div className={`plan-step-body document-analysis-page technical-document-page${hasDocumentTabs ? ' has-document-tabs' : ''}`}>
      <UploadBoard kicker="STEP 02" title="项目资料文件" subtitle={`默认解析方案：${parserLabel}`}>
        <UploadRow
          index="01"
          title="可研资料"
          onDropFiles={(files) => {
            const paths = resolveDroppedFilePaths(files);
            if (paths.length) void handleImport(paths);
          }}
          dropDisabled={busy}
          actions={(
            <button type="button" className="primary-action" onClick={() => void handleImport()} disabled={busy}>
              {busy ? '解析中...' : sourceFiles.length ? '重新导入' : '上传'}
            </button>
          )}
        >
          {sourceFiles.length ? (
            <div className="upload-file-list">
              {sourceFiles.map((file) => (
                <UploadFilePill
                  key={file.id}
                  badge="MD"
                  name={file.fileName}
                  meta={[file.parserLabel, `${file.markdownChars} 字`].filter(Boolean).join(' · ')}
                  onRemove={() => { void onRemove(file.id); }}
                  removeDisabled={busy}
                />
              ))}
            </div>
          ) : (
            <UploadEmpty title="资料文件为可选项" hint="可补充招标、可研草稿等 Word、PDF、Excel 或 Markdown；未上传也可进入资料分析。重新导入会整批替换并清空后续步骤。">
              <button type="button" className="text-button" onClick={() => void handleImport()} disabled={busy}>选择资料文件</button>
            </UploadEmpty>
          )}
        </UploadRow>
      </UploadBoard>

      {hasDocumentTabs && (
        <div className="document-switch-tabs" role="tablist" aria-label="可研资料正文切换">
          {sourceFiles.map((file, index) => (
            <button
              key={file.id}
              type="button"
              className={`document-switch-tab${file.id === activeFile?.id ? ' is-active' : ''}`}
              role="tab"
              aria-selected={file.id === activeFile?.id}
              aria-controls="feasibility-source-document-panel"
              id={`feasibility-source-tab-${file.id}`}
              onClick={() => setActiveSourceId(file.id)}
            >
              <strong>{`资料${index + 1}`}</strong>
            </button>
          ))}
        </div>
      )}

      <section
        className="technical-document-reader-card analysis-markdown-card"
        role={hasDocumentTabs ? 'tabpanel' : undefined}
        id="feasibility-source-document-panel"
        aria-labelledby={hasDocumentTabs && activeFile ? `feasibility-source-tab-${activeFile.id}` : undefined}
      >
        <div className="analysis-result-head technical-document-reader-head">
          <strong>资料内容</strong>
          <span>{activeFile ? `${activeFile.fileName} · ${activeFile.markdownChars} 字` : '等待上传'}</span>
        </div>
        {activeFile && sourceMarkdown ? (
          <MarkdownFullscreenViewer title={`${activeFile.fileName}全屏预览`} description="全屏查看当前资料解析出的 Markdown。">
            <MarkdownRenderer allowRawHtml={false}>{sourceMarkdown}</MarkdownRenderer>
          </MarkdownFullscreenViewer>
        ) : activeFile ? (
          <div className="markdown-empty-state">
            <strong>正在读取资料正文...</strong>
            <p>文件较大时需要稍等片刻。</p>
          </div>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入资料</strong>
            <p>导入后可在这里预览解析出的 Markdown。下一步会基于项目参数和资料做事实分析。</p>
          </div>
        )}
      </section>
    </div>
  );
}

export default SourcesPage;
