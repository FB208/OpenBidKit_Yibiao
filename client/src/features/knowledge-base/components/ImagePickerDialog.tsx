import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../../shared/ui';
import type { KnowledgeFolder, KnowledgeImage } from '../types';

function buildMarkdownReference(image: KnowledgeImage) {
  const alt = (image.name || '图片').replace(/[[\]()]/g, '');
  return `![${alt}](kbimg:${image.id})`;
}

export interface ImagePickerDialogProps {
  open: boolean;
  onCancel: () => void;
  onSelect: (markdown: string) => void;
}

export default function ImagePickerDialog({ open, onCancel, onSelect }: ImagePickerDialogProps) {
  const { showToast } = useToast();
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [images, setImages] = useState<KnowledgeImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const index = await window.yibiao?.knowledgeBase.list('image');
        const list = index?.folders ?? [];
        setFolders(list);
        setActiveFolderId((prev) => prev || list[0]?.id || '');
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取文件夹失败', 'error');
      }
    })();
  }, [open, showToast]);

  useEffect(() => {
    if (!open || !activeFolderId) {
      setImages([]);
      return;
    }
    void (async () => {
      try {
        setLoading(true);
        const list = await window.yibiao?.knowledgeBase.images.list(activeFolderId);
        setImages(Array.isArray(list) ? list : []);
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取图片失败', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, activeFolderId, showToast]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return images;
    return images.filter((image) =>
      `${image.name} ${image.description} ${image.tags.join(' ')}`.toLowerCase().includes(keyword),
    );
  }, [images, search]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="knowledge-source-modal" />
        <Dialog.Content className="knowledge-source-dialog-card knowledge-image-picker">
          <div className="knowledge-source-head">
            <div>
              <span>插入知识库图片</span>
              <Dialog.Title>选择图片素材</Dialog.Title>
              <Dialog.Description>点击图片即可将其 Markdown 引用插入到光标处。</Dialog.Description>
            </div>
            <button type="button" className="secondary-action" onClick={onCancel}>关闭</button>
          </div>
          <div className="knowledge-image-picker-body">
            <div className="knowledge-image-filters">
              <input
                className="knowledge-image-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索图片名称、描述或标签"
              />
            </div>
            <div className="knowledge-image-picker-layout">
              <div className="knowledge-image-folder-list">
                {folders.map((folder) => (
                  <button
                    type="button"
                    key={folder.id}
                    className={`knowledge-image-folder-item${folder.id === activeFolderId ? ' is-active' : ''}`}
                    onClick={() => setActiveFolderId(folder.id)}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
              <div className="knowledge-image-pick-grid">
                {loading ? (
                  <div className="knowledge-empty-box"><strong>正在读取图片...</strong></div>
                ) : filtered.length ? (
                  <div className="knowledge-image-grid">
                    {filtered.map((image) => (
                      <button
                        type="button"
                        key={image.id}
                        className="knowledge-image-pick-card"
                        onClick={() => onSelect(buildMarkdownReference(image))}
                        title={image.name}
                      >
                        <div className="knowledge-image-thumb">
                          {image.thumbnail ? (
                            <img src={image.thumbnail} alt={image.name} loading="lazy" />
                          ) : (
                            <span className="knowledge-image-placeholder">无预览</span>
                          )}
                        </div>
                        <strong>{image.name}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="knowledge-empty-box">
                    <strong>该文件夹暂无图片</strong>
                    <p>请先到图片知识库上传图片素材。</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
