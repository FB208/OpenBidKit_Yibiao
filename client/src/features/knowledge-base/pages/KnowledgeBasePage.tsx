import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useToast } from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeDocument, KnowledgeItem } from '../types';

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

function markdownUrlTransform(value: string) {
  return value.startsWith('yibiao-asset://') ? value : defaultUrlTransform(value);
}

const statusLabels: Record<KnowledgeDocument['status'], string> = {
  pending: '等待处理',
  copying: '复制文件',
  converting: '转换 Markdown',
  extracting: '提取条目',
  ready_for_matching: '待匹配',
  matching: '匹配段落',
  recovering: '补漏中',
  analyzing: 'AI 整理中',
  saving: '保存结果',
  success: '完成',
  error: '失败',
};

type KnowledgeViewer = {
  document: KnowledgeDocument;
  mode: 'analysis' | 'items' | 'markdown';
};

function KnowledgeBasePage() {
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<KnowledgeViewer | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [itemsPreview, setItemsPreview] = useState<KnowledgeItem[]>([]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<KnowledgeAnalysisSnapshot | null>(null);
  const [batchSize, setBatchSize] = useState(20);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const { showToast } = useToast();

  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];
  const documents = useMemo(
    () => index.documents.filter((document) => document.folder_id === activeFolder?.id),
    [activeFolder?.id, index.documents]
  );

  useEffect(() => {
    void loadIndex();
    void loadDeveloperMode();
    window.addEventListener('focus', loadDeveloperMode);
    document.addEventListener('visibilitychange', loadDeveloperMode);
    const unsubscribe = window.yibiao?.knowledgeBase.onEvent(({ document }) => {
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.some((item) => item.id === document.id)
          ? prev.documents.map((item) => (item.id === document.id ? document : item))
          : [...prev.documents, document],
      }));
      setViewer((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
      setAnalysisSnapshot((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
    });
    return () => {
      window.removeEventListener('focus', loadDeveloperMode);
      document.removeEventListener('visibilitychange', loadDeveloperMode);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (developerMode) return;
    const pendingDocuments = index.documents.filter((document) => document.status === 'ready_for_matching' && !autoMatchingIdsRef.current.has(document.id));
    pendingDocuments.forEach((document) => {
      autoMatchingIdsRef.current.add(document.id);
      void startMatching(document, 20, { silent: true });
    });
  }, [developerMode, index.documents]);

  useEffect(() => {
    if (!developerMode && viewer?.mode === 'analysis') {
      setViewer(null);
    }
  }, [developerMode, viewer?.mode]);

  useEffect(() => {
    if (!activeFolderId && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);

  useEffect(() => {
    if (viewer?.mode === 'analysis') {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);

  const loadIndex = async () => {
    try {
      await loadDeveloperMode();
      const data = await window.yibiao?.knowledgeBase.list();
      if (data) setIndex(data);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    }
  };

  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn('读取开发者模式失败', error);
      setDeveloperMode(false);
    }
  };

  const loadAnalysis = async (documentId: string, options?: { silent?: boolean }) => {
    try {
      const data = await window.yibiao?.knowledgeBase.readAnalysis(documentId);
      if (data) setAnalysisSnapshot(data);
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '读取分析结果失败', 'error');
      }
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast('请输入文件夹名称', 'info');
      return;
    }

    try {
      setCreatingFolder(true);
      const folder = await window.yibiao?.knowledgeBase.createFolder(name.trim());
      if (!folder) return;
      setIndex((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
      setActiveFolderId(folder.id);
      setNewFolderName('');
      setShowCreateFolder(false);
      showToast('文件夹已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const uploadDocuments = async () => {
    if (!activeFolder) {
      showToast('请先创建文件夹', 'info');
      return;
    }

    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.uploadDocuments(activeFolder.id);
      if (!result?.success) {
        showToast(result?.message || '未选择文档', 'info');
        return;
      }
      if (result.documents?.length) {
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, result.documents || []) }));
      }
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '上传文档失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt('请输入新的文件夹名称', currentName)?.trim();
    if (!name || name === currentName) return;

    try {
      const folder = await window.yibiao?.knowledgeBase.renameFolder(folderId, name);
      if (!folder) return;
      setIndex((prev) => ({
        ...prev,
        folders: prev.folders.map((item) => (item.id === folder.id ? folder : item)),
      }));
      showToast('文件夹已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名文件夹失败', 'error');
    }
  };

  const deleteFolder = async (folderId: string, folderName: string) => {
    const count = index.documents.filter((document) => document.folder_id === folderId).length;
    if (!window.confirm(`确定删除文件夹“${folderName}”吗？其中 ${count} 个文档也会一起删除。`)) return;

    try {
      const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
      const folders = index.folders.filter((item) => item.id !== folderId);
      const documents = index.documents.filter((document) => document.folder_id !== folderId);
      setIndex({ folders, documents });
      if (activeFolderId === folderId) {
        setActiveFolderId(folders[0]?.id || '');
      }
      setViewer((prev) => (prev?.document.folder_id === folderId ? null : prev));
      showToast(result?.message || '文件夹已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文件夹失败', 'error');
    }
  };

  const deleteDocument = async (document: KnowledgeDocument) => {
    if (!window.confirm(`确定删除文档“${document.file_name}”吗？`)) return;

    try {
      const result = await window.yibiao?.knowledgeBase.deleteDocument(document.id);
      setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document.id) }));
      setViewer((prev) => (prev?.document.id === document.id ? null : prev));
      showToast(result?.message || '文档已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文档失败', 'error');
    }
  };

  const openDocument = async (document: KnowledgeDocument, mode: KnowledgeViewer['mode']) => {
    if (mode === 'analysis' && !developerMode) {
      return;
    }
    setViewer({ document, mode });
    setMarkdownPreview('');
    setItemsPreview([]);
    if (mode === 'analysis') {
      setAnalysisSnapshot(null);
      await loadAnalysis(document.id);
      return;
    }

    try {
      if (mode === 'markdown') {
        const markdown = await window.yibiao?.knowledgeBase.readMarkdown(document.id);
        setMarkdownPreview(markdown || '');
      } else {
        const items = await window.yibiao?.knowledgeBase.readItems(document.id);
        setItemsPreview(items || []);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取文档结果失败', 'error');
    }
  };

  const startMatching = async (targetDocument = viewer?.document, batchSizeOverride = batchSize, options?: { silent?: boolean }) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id, batchSizeOverride);
      if (!options?.silent) {
        showToast(result?.message || '已提交匹配任务', result?.success ? 'success' : 'info');
      }
      if (developerMode) {
        await loadAnalysis(targetDocument.id, { silent: true });
      }
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '启动段落匹配失败', 'error');
      }
    } finally {
      setStartingMatching(false);
    }
  };

  if (viewer) {
    return (
      <KnowledgeDocumentViewer
        document={viewer.document}
        mode={viewer.mode}
        itemsPreview={itemsPreview}
        markdownPreview={markdownPreview}
        analysisSnapshot={analysisSnapshot}
        batchSize={batchSize}
        startingMatching={startingMatching}
        developerMode={developerMode}
        onBatchSizeChange={setBatchSize}
        onBack={() => setViewer(null)}
        onModeChange={(mode) => void openDocument(viewer.document, mode)}
        onStartMatching={() => void startMatching()}
        onRefreshAnalysis={() => void loadAnalysis(viewer.document.id)}
      />
    );
  }

  return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{activeFolder?.name || '未选择文件夹'}</strong>
          <small>{index.folders.length} 个文件夹 / {index.documents.length} 个文档</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={() => setShowCreateFolder((value) => !value)}>新建文件夹</button>
          <button type="button" className="primary-action" onClick={uploadDocuments} disabled={loading || !activeFolder}>
            {loading ? '处理中...' : '上传文档'}
          </button>
        </div>
      </section>

      {showCreateFolder && (
        <form
          className="knowledge-create-folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="输入文件夹名称"
          />
          <button type="submit" className="primary-action" disabled={creatingFolder}>{creatingFolder ? '创建中...' : '创建'}</button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              setNewFolderName('');
              setShowCreateFolder(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <span>{index.folders.length} 个</span>
          </div>
          {index.folders.length ? (
            <div className="knowledge-folder-list">
              {index.folders.map((folder) => {
                const count = index.documents.filter((document) => document.folder_id === folder.id).length;
                return (
                  <article key={folder.id} className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''}`}>
                    <button type="button" className="knowledge-folder-main" onClick={() => setActiveFolderId(folder.id)}>
                      <span aria-hidden="true">F</span>
                      <strong>{folder.name}</strong>
                      <small>{count} 个文档</small>
                    </button>
                    <div className="knowledge-folder-actions">
                      <button type="button" onClick={() => void renameFolder(folder.id, folder.name)}>重命名</button>
                      <button type="button" className="is-danger" onClick={() => void deleteFolder(folder.id, folder.name)}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>先创建一个文件夹，再上传历史资料。</p>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          <div className="knowledge-panel-head">
            <strong>{activeFolder?.name || '未选择文件夹'}</strong>
            <span>{documents.length} 个文档</span>
          </div>

          {documents.length ? (
            <div className="knowledge-document-list">
              {documents.map((document) => (
                <article className="knowledge-document-card" key={document.id}>
                  <div className="knowledge-document-title">
                    <div className="knowledge-document-name">
                      <strong>{document.file_name}</strong>
                      {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
                    </div>
                    <span className={`knowledge-status is-${document.status}`}>{statusLabels[document.status]}</span>
                  </div>
                  <div className="knowledge-progress-track" aria-label={`处理进度 ${document.progress}%`}>
                    <span style={{ width: `${Math.max(0, Math.min(100, document.progress || 0))}%` }} />
                  </div>
                  <div className="knowledge-document-meta">
                    <span>{document.message}</span>
                    <span>{document.item_count || 0} 条知识</span>
                    <span>{document.candidate_item_count || 0} 个候选</span>
                    <span>{document.block_count || 0} 个 block</span>
                  </div>
                  <div className="knowledge-document-actions">
                    {developerMode && <button type="button" onClick={() => void openDocument(document, 'analysis')} disabled={!canOpenAnalysis(document)}>分析调试</button>}
                    <button type="button" onClick={() => void openDocument(document, 'items')} disabled={document.status !== 'success'}>查看条目</button>
                    <button type="button" onClick={() => void openDocument(document, 'markdown')} disabled={!canOpenMarkdown(document)}>查看 Markdown</button>
                    <button type="button" className="is-danger" onClick={() => void deleteDocument(document)}>删除</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="knowledge-empty-box large">
              <strong>当前文件夹暂无文档</strong>
              <p>支持上传 .doc、.docx、.wps、.pdf、.md 文档。</p>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

interface KnowledgeDocumentViewerProps {
  document: KnowledgeDocument;
  mode: KnowledgeViewer['mode'];
  itemsPreview: KnowledgeItem[];
  markdownPreview: string;
  analysisSnapshot: KnowledgeAnalysisSnapshot | null;
  batchSize: number;
  startingMatching: boolean;
  developerMode: boolean;
  onBatchSizeChange: (value: number) => void;
  onBack: () => void;
  onModeChange: (mode: KnowledgeViewer['mode']) => void;
  onStartMatching: () => void;
  onRefreshAnalysis: () => void;
}

function KnowledgeDocumentViewer({
  document,
  mode,
  itemsPreview,
  markdownPreview,
  analysisSnapshot,
  batchSize,
  startingMatching,
  developerMode,
  onBatchSizeChange,
  onBack,
  onModeChange,
  onStartMatching,
  onRefreshAnalysis,
}: KnowledgeDocumentViewerProps) {
  return (
    <div className="page-stack knowledge-viewer-page">
      <section className="knowledge-workspace-bar knowledge-viewer-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{document.file_name}</strong>
          {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
          <small>{mode === 'analysis' ? '分析调试' : mode === 'items' ? `${document.item_count || 0} 条知识` : 'Markdown 原文'}</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={onBack}>返回知识库</button>
          {developerMode && <button type="button" className={`secondary-action ${mode === 'analysis' ? 'is-active' : ''}`} onClick={() => onModeChange('analysis')}>分析调试</button>}
          <button type="button" className={`secondary-action ${mode === 'items' ? 'is-active' : ''}`} onClick={() => onModeChange('items')} disabled={document.status !== 'success'}>知识条目</button>
          <button type="button" className={`secondary-action ${mode === 'markdown' ? 'is-active' : ''}`} onClick={() => onModeChange('markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
        </div>
      </section>

      <section className="knowledge-viewer-panel">
        {mode === 'analysis' && developerMode ? (
          <KnowledgeAnalysisView
            document={document}
            snapshot={analysisSnapshot}
            batchSize={batchSize}
            startingMatching={startingMatching}
            onBatchSizeChange={onBatchSizeChange}
            onStartMatching={onStartMatching}
            onRefresh={onRefreshAnalysis}
          />
        ) : mode === 'items' ? (
          <div className="knowledge-item-list knowledge-viewer-item-list">
            {itemsPreview.length ? itemsPreview.map((item) => (
              <article className="knowledge-item-card" key={item.id}>
                {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
                <strong>{item.title}</strong>
                <p>{item.resume}</p>
                <details>
                  <summary>查看原文</summary>
                  <div className="knowledge-item-content markdown-viewer">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} urlTransform={markdownUrlTransform}>
                      {item.content}
                    </ReactMarkdown>
                  </div>
                </details>
              </article>
            )) : <div className="knowledge-empty-box"><strong>暂无知识条目</strong><p>文档完成整理后会显示结果。</p></div>}
          </div>
        ) : (
          <div className="markdown-viewer knowledge-viewer-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} urlTransform={markdownUrlTransform}>
              {markdownPreview || '暂无 Markdown 内容'}
            </ReactMarkdown>
          </div>
        )}
      </section>
    </div>
  );
}

interface KnowledgeAnalysisViewProps {
  document: KnowledgeDocument;
  snapshot: KnowledgeAnalysisSnapshot | null;
  batchSize: number;
  startingMatching: boolean;
  onBatchSizeChange: (value: number) => void;
  onStartMatching: () => void;
  onRefresh: () => void;
}

function KnowledgeAnalysisView({ document, snapshot, batchSize, startingMatching, onBatchSizeChange, onStartMatching, onRefresh }: KnowledgeAnalysisViewProps) {
  const report = snapshot?.report;
  const canStart = ['ready_for_matching', 'success', 'error'].includes(document.status) && Boolean(snapshot?.candidate_items.length);

  return (
    <div className="knowledge-analysis-view">
      <div className="knowledge-analysis-command">
        <div>
          <strong>分批段落匹配</strong>
          <p>候选条目已由 AI 两轮抽取生成。这里设置每批投入多少条知识条目，程序会用稳定全文前缀循环匹配段落并执行补漏。</p>
        </div>
        <label>
          <span>每批条目数</span>
          <input
            type="number"
            min={1}
            max={100}
            value={batchSize}
            onChange={(event) => onBatchSizeChange(Number(event.target.value) || 1)}
          />
        </label>
        <button type="button" className="primary-action" onClick={onStartMatching} disabled={!canStart || startingMatching}>
          {startingMatching ? '提交中...' : document.status === 'success' ? '重新匹配' : '开始匹配'}
        </button>
        <button type="button" className="secondary-action" onClick={onRefresh}>刷新</button>
      </div>

      <div className="knowledge-analysis-stats">
        <StatCard label="有效 block" value={snapshot?.block_count ?? document.block_count ?? 0} />
        <StatCard label="筛除 block" value={snapshot?.filtered_blocks_count ?? document.filtered_block_count ?? 0} />
        <StatCard label="候选条目" value={snapshot?.candidate_items.length ?? document.candidate_item_count ?? 0} />
        <StatCard label="最终条目" value={report?.final_items_count ?? document.item_count ?? 0} />
        <StatCard label="覆盖率" value={report ? `${Math.round(report.coverage_rate * 100)}%` : '-'} />
        <StatCard label="补漏新增" value={report?.new_items_from_recovery_count ?? 0} />
        <StatCard label="Markdown 字符" value={formatInteger(snapshot?.markdown_chars)} />
        <StatCard label="保留 block 字符" value={formatInteger(snapshot?.kept_block_chars)} />
        <StatCard label="条目覆盖字符" value={formatInteger(snapshot?.covered_unique_content_chars)} />
        <StatCard label="原文真实覆盖率" value={formatPercent(snapshot?.coverage_rate_vs_markdown)} />
      </div>

      {report && (
        <div className="knowledge-analysis-report">
          <strong>处理报告</strong>
          <span>已匹配 {report.matched_blocks_count} 个 block</span>
          <span>AI 舍弃 {report.discarded_blocks_count} 个 block</span>
          <span>重试后系统舍弃 {report.system_discarded_after_retry_count} 个 block</span>
          <span>补漏轮次 {report.recovery_attempt_count}</span>
          <span>批次大小 {report.batch_size}</span>
        </div>
      )}

      {snapshot?.debug_log_path && (
        <div className="knowledge-analysis-debug-log">
          <strong>开发者日志</strong>
          <code>{snapshot.debug_log_path}</code>
        </div>
      )}

      <div className="knowledge-analysis-grid">
        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>候选知识条目</strong>
            <span>{snapshot?.candidate_items.length || 0} 条</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot?.candidate_items.length ? snapshot.candidate_items.map((item) => (
              <article className="knowledge-candidate-card" key={item.id}>
                <small>{item.id}</small>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
              </article>
            )) : <div className="knowledge-empty-box"><strong>暂无候选条目</strong><p>上传处理完成后会显示 AI 提取出的知识条目。</p></div>}
          </div>
        </section>

        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>舍弃记录</strong>
            <span>{(snapshot?.discarded.length || 0) + (snapshot?.system_discarded_after_retry.length || 0)} 组</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot && (snapshot.discarded.length || snapshot.system_discarded_after_retry.length) ? (
              [...snapshot.discarded, ...snapshot.system_discarded_after_retry].map((item, index) => (
                <article className="knowledge-candidate-card" key={`${item.reason}-${index}`}>
                  <small>{item.block_ids.length} 个 block</small>
                  <strong>{item.reason}</strong>
                  <p>{item.block_ids.join('、')}</p>
                </article>
              ))
            ) : <div className="knowledge-empty-box"><strong>暂无舍弃记录</strong><p>完成段落匹配和补漏后会显示。</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatInteger(value?: number) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '-';
}

function formatPercent(value?: number) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '-';
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="knowledge-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function canOpenAnalysis(document: KnowledgeDocument) {
  return !['pending', 'copying', 'converting', 'extracting'].includes(document.status);
}

function canOpenMarkdown(document: KnowledgeDocument) {
  return !['pending', 'copying'].includes(document.status);
}

function mergeDocuments(prev: KnowledgeDocument[], next: KnowledgeDocument[]) {
  const byId = new Map(prev.map((document) => [document.id, document]));
  next.forEach((document) => byId.set(document.id, document));
  return Array.from(byId.values());
}

export default KnowledgeBasePage;
