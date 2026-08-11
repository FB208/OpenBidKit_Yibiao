import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { KnowledgeBaseIndex, KnowledgeDocument, KnowledgeSnippet } from '../../knowledge-base/types';

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

function includesKeyword(value: string, keyword: string) {
  return value.toLowerCase().includes(keyword);
}

interface KnowledgeReferencePickerProps {
  disabled?: boolean;
  documentIds: string[];
  snippetIds: string[];
  onChange: (documentIds: string[], snippetIds: string[]) => void;
}

export function KnowledgeReferencePicker({ disabled, documentIds, snippetIds, onChange }: KnowledgeReferencePickerProps) {
  const { showToast } = useToast();
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [snippets, setSnippets] = useState<KnowledgeSnippet[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!disabled) {
      void loadIndex();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const loadIndex = async () => {
    try {
      setLoading(true);
      const data = await window.yibiao?.knowledgeBase.list('document');
      setKnowledgeIndex(data || emptyIndex);
      setExpandedFolderIds(new Set((data?.folders || []).slice(0, 1).map((folder) => folder.id)));
      const snippetData = await window.yibiao?.knowledgeBase.listSnippets();
      setSnippets(Array.isArray(snippetData) ? snippetData : []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
      setKnowledgeIndex(emptyIndex);
      setSnippets([]);
    } finally {
      setLoading(false);
    }
  };

  const availableDocuments = useMemo(
    () => knowledgeIndex.documents.filter((document) => document.status === 'success'),
    [knowledgeIndex.documents],
  );

  const selectedDocuments = documentIds
    .map((id) => knowledgeIndex.documents.find((document) => document.id === id))
    .filter((document): document is KnowledgeDocument => Boolean(document));
  const selectedSnippets = snippetIds
    .map((id) => snippets.find((snippet) => snippet.id === id))
    .filter((snippet): snippet is KnowledgeSnippet => Boolean(snippet));

  const keyword = search.trim().toLowerCase();
  const visibleFolders = knowledgeIndex.folders.flatMap((folder) => {
    const folderDocuments = availableDocuments.filter((document) => document.folder_id === folder.id);
    const folderMatched = keyword ? includesKeyword(folder.name, keyword) : false;
    const documents = keyword
      ? folderDocuments.filter((document) => folderMatched || includesKeyword(document.file_name, keyword))
      : folderDocuments;
    return documents.length ? [{ folder, documents }] : [];
  });

  const toggleDocument = (document: KnowledgeDocument) => {
    if (disabled) return;
    onChange(
      documentIds.includes(document.id) ? documentIds.filter((id) => id !== document.id) : [...documentIds, document.id],
      snippetIds,
    );
  };

  const toggleSnippet = (snippet: KnowledgeSnippet) => {
    if (disabled) return;
    onChange(
      documentIds,
      snippetIds.includes(snippet.id) ? snippetIds.filter((id) => id !== snippet.id) : [...snippetIds, snippet.id],
    );
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((prev) => (prev.has(folderId) ? new Set() : new Set([folderId])));
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([], []);
  };

  if (loading) {
    return <div className="bid-knowledge-empty">正在读取知识库...</div>;
  }

  if (!availableDocuments.length) {
    return <div className="bid-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>;
  }

  return (
    <div className="bid-knowledge-compact">
      <div className="bid-knowledge-search-row">
        <input
          className="bid-knowledge-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={disabled}
          placeholder="搜索文件夹或文档"
        />
        <span>{keyword ? `匹配 ${visibleFolders.reduce((total, group) => total + group.documents.length, 0)} 个文档` : `共 ${availableDocuments.length} 个可用文档`}</span>
      </div>
      <div className="bid-knowledge-grid">
        <div className="bid-knowledge-browser">
          {visibleFolders.length ? visibleFolders.map(({ folder, documents }) => {
            const expanded = keyword ? true : expandedFolderIds.has(folder.id);
            const folderSnippets = keyword
              ? snippets.filter((snippet) => snippet.folder_id === folder.id && (includesKeyword(folder.name, keyword) || includesKeyword(snippet.title, keyword)))
              : snippets.filter((snippet) => snippet.folder_id === folder.id);
            return (
              <section className="bid-knowledge-folder" key={folder.id}>
                <div className="bid-knowledge-folder-head">
                  <button type="button" onClick={() => toggleFolder(folder.id)} disabled={Boolean(keyword)} aria-expanded={expanded}>
                    <span>{expanded ? '▾' : '▸'}</span>
                    <strong>{folder.name}</strong>
                  </button>
                  <small>{documents.length} 个 / 已选 {documents.filter((document) => documentIds.includes(document.id)).length}</small>
                </div>
                {expanded && (
                  <div className="bid-knowledge-document-list">
                    {documents.map((document) => {
                      const selected = documentIds.includes(document.id);
                      return (
                        <label className={`bid-knowledge-document${selected ? ' is-selected' : ''}`} key={document.id}>
                          <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleDocument(document)} />
                          <strong title={document.file_name}>{document.file_name}</strong>
                          <small>{document.item_count || 0} 条</small>
                        </label>
                      );
                    })}
                  </div>
                )}
                {expanded && Boolean(folderSnippets.length) && (
                  <div className="bid-knowledge-snippet-block">
                    <div className="bid-knowledge-subhead">片段</div>
                    <div className="bid-knowledge-snippet-list">
                      {folderSnippets.map((snippet) => {
                        const selected = snippetIds.includes(snippet.id);
                        return (
                          <label className={`bid-knowledge-snippet${selected ? ' is-selected' : ''}`} key={snippet.id}>
                            <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleSnippet(snippet)} />
                            <strong title={snippet.title}>{snippet.title}</strong>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          }) : <div className="bid-knowledge-empty">没有匹配的知识库文档</div>}
        </div>
        <aside className="bid-knowledge-selected-pane">
          <div className="bid-knowledge-pane-head">
            <strong>本次已选</strong>
            <button type="button" onClick={clearAll} disabled={disabled || (!documentIds.length && !snippetIds.length)}>清空</button>
          </div>
          <div className="bid-knowledge-subhead">文档</div>
          {selectedDocuments.length ? (
            <div className="bid-knowledge-selected-list">
              {selectedDocuments.map((document) => (
                <div className="bid-knowledge-selected-item" key={document.id}>
                  <strong title={document.file_name}>{document.file_name}</strong>
                  <button type="button" onClick={() => toggleDocument(document)} disabled={disabled}>移除</button>
                </div>
              ))}
            </div>
          ) : <div className="bid-knowledge-empty">未选择知识库文档</div>}
          <div className="bid-knowledge-subhead">片段</div>
          {selectedSnippets.length ? (
            <div className="bid-knowledge-selected-list">
              {selectedSnippets.map((snippet) => (
                <div className="bid-knowledge-selected-item" key={snippet.id}>
                  <strong title={snippet.title}>{snippet.title}</strong>
                  <button type="button" onClick={() => toggleSnippet(snippet)} disabled={disabled}>移除</button>
                </div>
              ))}
            </div>
          ) : <div className="bid-knowledge-empty">未选择知识库片段</div>}
        </aside>
      </div>
    </div>
  );
}
