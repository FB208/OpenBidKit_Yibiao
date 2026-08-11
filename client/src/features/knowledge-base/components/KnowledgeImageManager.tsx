import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../../shared/ui';
import type { KnowledgeImage } from '../types';

const IMAGE_CATEGORY_OPTIONS = ['图片素材', '图示', '视觉参考'];

interface KnowledgeImageManagerProps {
  folderId: string;
  disabled?: boolean;
}

function readFileAsImageData(file: File): Promise<{ base64: string; mimeType: string; fileName: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
      resolve({ base64, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    };
    reader.readAsDataURL(file);
  });
}

function isImageFile(file: File) {
  return file.type ? file.type.startsWith('image/') : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
}

function parseTags(input: string): string[] {
  return input
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function buildMarkdownReference(image: KnowledgeImage) {
  const alt = (image.name || '图片').replace(/[[\]()]/g, '');
  return `![${alt}](kbimg:${image.id})`;
}

function KnowledgeImageManager({ folderId, disabled = false }: KnowledgeImageManagerProps) {
  const { showToast } = useToast();
  const [images, setImages] = useState<KnowledgeImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editorImage, setEditorImage] = useState<KnowledgeImage | null>(null);
  const [editorPreview, setEditorPreview] = useState('');
  const [editorName, setEditorName] = useState('');
  const [editorDescription, setEditorDescription] = useState('');
  const [editorTagsText, setEditorTagsText] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!folderId) {
      setImages([]);
      return;
    }
    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.images.list(folderId);
      setImages(Array.isArray(result) ? result : []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取图片失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [folderId, showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!editorImage) return;
    setEditorName(editorImage.name);
    setEditorDescription(editorImage.description);
    setEditorTagsText(editorImage.tags.join(', '));
  }, [editorImage]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return images.filter((image) => {
      if (category !== 'all' && !image.tags.includes(category)) return false;
      if (!keyword) return true;
      const haystack = `${image.name} ${image.description} ${image.tags.join(' ')}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [images, search, category]);

  const importFiles = useCallback(async (files: FileList | File[]) => {
    if (!folderId || disabled) return;
    const imageFiles = Array.from(files).filter(isImageFile);
    if (!imageFiles.length) {
      showToast('请选择图片文件', 'info');
      return;
    }
    setImporting(true);
    let successCount = 0;
    for (const file of imageFiles) {
      try {
        const data = await readFileAsImageData(file);
        await window.yibiao?.knowledgeBase.images.create(folderId, {
          base64: data.base64,
          mimeType: data.mimeType,
          fileName: data.fileName,
          name: file.name.replace(/\.[^.]+$/, ''),
        });
        successCount += 1;
      } catch (error) {
        showToast(error instanceof Error ? error.message : `导入 ${file.name} 失败`, 'error');
      }
    }
    setImporting(false);
    if (successCount) {
      showToast(`已导入 ${successCount} 张图片`, 'success');
      await reload();
    }
  }, [folderId, disabled, reload, showToast]);

  const handleFilesPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length) void importFiles(files);
    event.target.value = '';
  };

  const handlePaste = async () => {
    if (!folderId || disabled) return;
    try {
      setImporting(true);
      await window.yibiao?.knowledgeBase.images.createFromClipboard(folderId, {});
      showToast('已从剪贴板导入图片', 'success');
      await reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '粘贴图片失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer?.files?.length) {
      void importFiles(event.dataTransfer.files);
    }
  };

  const openEditor = async (image: KnowledgeImage) => {
    setEditorImage(image);
    setEditorPreview('');
    try {
      const url = await window.yibiao?.knowledgeBase.images.getFile(image.id);
      if (url) setEditorPreview(url);
    } catch {
      // 预览失败不影响打开编辑。
    }
  };

  const handleDelete = async (image: KnowledgeImage) => {
    if (!window.confirm(`确定删除图片“${image.name}”吗？`)) return;
    try {
      const result = await window.yibiao?.knowledgeBase.images.delete(image.id);
      showToast(result?.message || '已删除图片', 'success');
      if (editorImage?.id === image.id) setEditorImage(null);
      await reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除图片失败', 'error');
    }
  };

  const copyReference = async (image: KnowledgeImage) => {
    const markdown = buildMarkdownReference(image);
    try {
      await navigator.clipboard.writeText(markdown);
      showToast('已复制 Markdown 引用，可粘贴到正文', 'success');
    } catch {
      showToast('复制失败，请手动复制', 'error');
    }
  };

  const saveEditor = async () => {
    if (!editorImage) return;
    setEditorSaving(true);
    try {
      await window.yibiao?.knowledgeBase.images.update(editorImage.id, {
        name: editorName.trim(),
        description: editorDescription.trim(),
        tags: parseTags(editorTagsText),
      });
      showToast('已保存图片信息', 'success');
      setEditorImage(null);
      await reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setEditorSaving(false);
    }
  };

  return (
    <section className={`knowledge-image-section${dragging ? ' is-dragging' : ''}`}>
      <div className="knowledge-panel-head knowledge-image-head">
        <strong>图片素材</strong>
        <span>{images.length} 张</span>
        <div className="knowledge-image-tools">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleFilesPicked}
          />
          <button
            type="button"
            className="primary-action"
            onClick={() => fileInputRef.current?.click()}
            disabled={!folderId || disabled || importing}
          >
            {importing ? '导入中...' : '上传图片'}
          </button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => void handlePaste()}
            disabled={!folderId || disabled || importing}
          >
            粘贴图片
          </button>
        </div>
      </div>

      <div className="knowledge-image-filters">
        <input
          className="knowledge-image-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="按名称 / 描述 / 标签搜索"
          disabled={disabled}
        />
        <select
          className="knowledge-image-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          disabled={disabled}
        >
          <option value="all">全部分类</option>
          {IMAGE_CATEGORY_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>

      <div
        className="knowledge-image-dropzone"
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="knowledge-empty-box">
            <strong>正在读取图片...</strong>
          </div>
        ) : filtered.length ? (
          <div className="knowledge-image-grid">
            {filtered.map((image) => (
              <article key={image.id} className="knowledge-image-card" onClick={() => void openEditor(image)}>
                <div className="knowledge-image-thumb">
                  {image.thumbnail ? (
                    <img src={image.thumbnail} alt={image.name} loading="lazy" />
                  ) : (
                    <span className="knowledge-image-placeholder">无预览</span>
                  )}
                </div>
                <div className="knowledge-image-meta">
                  <strong title={image.name}>{image.name}</strong>
                  {image.tags.length > 0 && (
                    <div className="knowledge-image-tags">
                      {image.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="knowledge-image-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="knowledge-image-actions" onClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => void copyReference(image)}>复制引用</button>
                  <button type="button" onClick={() => void handleDelete(image)} className="is-danger">删除</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="knowledge-empty-box">
            <strong>该文件夹暂无图片</strong>
            <p>点击「上传图片」选择文件，或把图片拖拽到此处，也可「粘贴图片」从剪贴板导入。</p>
          </div>
        )}
        {dragging && (
          <div className="knowledge-image-drag-overlay">
            <span>松开以导入图片</span>
          </div>
        )}
      </div>

      <Dialog.Root open={Boolean(editorImage)} onOpenChange={(open) => !open && setEditorImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-source-modal" />
          {editorImage && (
            <Dialog.Content className="knowledge-source-dialog-card knowledge-image-editor">
              <div className="knowledge-source-head">
                <div>
                  <span>图片素材</span>
                  <Dialog.Title>编辑图片信息</Dialog.Title>
                  <Dialog.Description>完善名称、描述与分类标签，便于在正文引用与检索。</Dialog.Description>
                </div>
                <button type="button" className="secondary-action" onClick={() => setEditorImage(null)} disabled={editorSaving}>关闭</button>
              </div>
              <div className="knowledge-image-editor-body">
                <div className="knowledge-image-preview">
                  {editorPreview ? (
                    <img src={editorPreview} alt={editorImage.name} />
                  ) : (
                    <span className="knowledge-image-placeholder">预览加载中...</span>
                  )}
                </div>
                <div className="knowledge-image-fields">
                  <label className="knowledge-field">
                    <span>名称</span>
                    <input
                      value={editorName}
                      onChange={(event) => setEditorName(event.target.value)}
                      placeholder="输入图片名称"
                      disabled={editorSaving}
                    />
                  </label>
                  <label className="knowledge-field">
                    <span>描述</span>
                    <textarea
                      value={editorDescription}
                      onChange={(event) => setEditorDescription(event.target.value)}
                      placeholder="补充这张图片的用途或来源"
                      rows={3}
                      disabled={editorSaving}
                    />
                  </label>
                  <label className="knowledge-field">
                    <span>分类标签（逗号分隔）</span>
                    <input
                      value={editorTagsText}
                      onChange={(event) => setEditorTagsText(event.target.value)}
                      placeholder="例如：图示, 架构图"
                      disabled={editorSaving}
                    />
                  </label>
                </div>
              </div>
              <div className="knowledge-editor-actions">
                <button type="button" className="secondary-action" onClick={() => void copyReference(editorImage)} disabled={editorSaving}>
                  复制引用
                </button>
                <button type="button" className="is-danger" onClick={() => void handleDelete(editorImage)} disabled={editorSaving}>
                  删除
                </button>
                <button type="button" className="primary-action" onClick={() => void saveEditor()} disabled={editorSaving || !editorName.trim()}>
                  {editorSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

export default KnowledgeImageManager;
