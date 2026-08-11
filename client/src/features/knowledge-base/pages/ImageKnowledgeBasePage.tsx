import { startTransition, useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import KnowledgeImageManager from '../components/KnowledgeImageManager';
import type { KnowledgeBaseIndex, KnowledgeFolder } from '../types';
import type { SectionId } from '../../../shared/types/navigation';

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

/** 将 service 返回的树形文件夹展开为平级列表 */
function flattenFolderTree(folders: KnowledgeFolder[]): KnowledgeFolder[] {
  const result: KnowledgeFolder[] = [];
  function walk(list: KnowledgeFolder[]) {
    for (const folder of list) {
      result.push(folder);
      if (folder.children?.length) {
        walk(folder.children);
      }
    }
  }
  walk(folders);
  return result;
}

function ImageKnowledgeBasePage({ onSectionChange }: { onSectionChange: (section: SectionId) => void }) {
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!activeFolderId && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);

  /** 从 service 重新加载索引并扁平化，更新本地 state */
  const reloadIndex = async (options?: { keepActiveFolderId?: boolean }) => {
    const data = await window.yibiao?.knowledgeBase.list('image');
    if (!data) return;
    const flatFolders = flattenFolderTree(data.folders);
    setIndex({ ...data, folders: flatFolders });
    if (!options?.keepActiveFolderId) {
      setActiveFolderId((currentId) => (
        flatFolders.some((folder) => folder.id === currentId) ? currentId : flatFolders[0]?.id || ''
      ));
    }
  };

  const loadInitialData = async () => {
    try {
      setListLoading(true);
      await reloadIndex();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setListLoading(false);
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
      const folder = await window.yibiao?.knowledgeBase.createFolder(name.trim(), 'image');
      if (!folder) return;
      // 重新加载索引以获取最新状态（与文档知识库保持一致）
      await reloadIndex();
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

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt('请输入新的文件夹名称', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      const folder = await window.yibiao?.knowledgeBase.renameFolder(folderId, name);
      if (!folder) return;
      // 重新加载索引以获取最新状态
      await reloadIndex({ keepActiveFolderId: true });
      showToast('文件夹已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名文件夹失败', 'error');
    }
  };

  const deleteFolder = async (folderId: string, folderName: string) => {
    if (!window.confirm(`确定删除文件夹"${folderName}"吗？其中的图片也会一起删除。`)) return;
    try {
      setBusy(true);
      const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
      // 重新加载索引以获取正确的删除后状态（含级联删除）
      await reloadIndex();
      showToast(result?.message || '文件夹已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文件夹失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{activeFolder?.name || '图片知识库'}</strong>
          <small>{index.folders.length} 个文件夹</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={() => onSectionChange('knowledge-base')}>返回知识库</button>
          <button type="button" className="secondary-action" onClick={() => setShowCreateFolder((value) => !value)} disabled={listLoading || busy}>
            新建文件夹
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
            disabled={busy}
          />
          <button type="submit" className="primary-action" disabled={creatingFolder || busy}>
            {creatingFolder ? '创建中...' : '创建'}
          </button>
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
          {listLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识库...</strong>
              <p>请稍候，正在加载文件夹列表。</p>
            </div>
          ) : index.folders.length ? (
            <div className="knowledge-folder-list">
              {index.folders.map((folder: KnowledgeFolder) => {
                const dropTarget = folder.id === activeFolder?.id;
                return (
                  <article
                    key={folder.id}
                    className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''}`}
                  >
                    <div className="knowledge-folder-row">
                      <button type="button" className="knowledge-folder-main" onClick={() => startTransition(() => setActiveFolderId(folder.id))} disabled={busy}>
                        <span aria-hidden="true">F</span>
                        <strong>{folder.name}</strong>
                        <small>{dropTarget ? '当前图片库' : '点击切换'}</small>
                      </button>
                    </div>
                    <div className="knowledge-folder-actions">
                      <button type="button" onClick={() => void renameFolder(folder.id, folder.name)} disabled={busy}>重命名</button>
                      <button type="button" className="is-danger" onClick={() => void deleteFolder(folder.id, folder.name)} disabled={busy}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>先创建一个文件夹，再上传或粘贴图片素材。</p>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          {activeFolder ? (
            <KnowledgeImageManager folderId={activeFolder.id} disabled={busy} />
          ) : (
            <div className="knowledge-empty-box large">
              <strong>请先创建文件夹</strong>
              <p>图片素材按文件夹归类，创建文件夹后即可上传、粘贴或拖拽图片。</p>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

export default ImageKnowledgeBasePage;
