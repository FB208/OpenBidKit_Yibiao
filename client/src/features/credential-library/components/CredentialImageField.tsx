import { useRef, useState, type DragEvent } from 'react';
import { AppDialog, useToast } from '../../../shared/ui';

export interface CredentialImageItemView {
  id: string;
  name: string;
  url: string;
  customName?: string;
  draft?: boolean;
}

interface CredentialImageFieldProps {
  title: string;
  hint?: string;
  images: CredentialImageItemView[];
  disabled?: boolean;
  editableNames?: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (image: CredentialImageItemView) => void;
  onCustomNameChange?: (image: CredentialImageItemView, value: string) => void;
}

/** 资信图片多选、拖拽、预览和删除控件。 */
function CredentialImageField({
  title,
  hint,
  images,
  disabled = false,
  editableNames = false,
  onFiles,
  onRemove,
  onCustomNameChange,
}: CredentialImageFieldProps) {
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<CredentialImageItemView | null>(null);

  /** 接收文件选择器或拖拽得到的图片。 */
  const acceptFiles = (files: File[]) => {
    const imageFiles = files.filter((file) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name));
    if (imageFiles.length !== files.length) {
      showToast(`已跳过 ${files.length - imageFiles.length} 个不支持的文件，仅支持 PNG、JPG、WebP、BMP 和 GIF 图片`, 'info');
    }
    if (imageFiles.length) onFiles(imageFiles);
  };

  /** 接收拖入控件的多张图片。 */
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!disabled) acceptFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <section className={`credential-image-field${dragOver ? ' is-drag-over' : ''}`}>
      <div className="credential-image-field-head">
        <div>
          <strong>{title}</strong>
          {hint ? <small>{hint}</small> : null}
        </div>
        <span>{images.length} 张</span>
      </div>

      <div
        className="credential-image-grid"
        onDragEnter={(event) => {
          if (disabled || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(event) => {
          if (!disabled) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={handleDrop}
      >
        {images.map((image) => (
          <article className="credential-image-item" key={image.id}>
            <button type="button" className="credential-image-preview" onClick={() => setPreview(image)} aria-label={`预览 ${image.name}`}>
              <img src={image.url} alt={image.customName || image.name} />
              {image.draft ? <span>待保存</span> : null}
            </button>
            <div className="credential-image-item-meta">
              {editableNames ? (
                <input
                  value={image.customName || ''}
                  placeholder="证书名称"
                  aria-label={`${image.name}的证书名称`}
                  onChange={(event) => onCustomNameChange?.(image, event.target.value)}
                  disabled={disabled}
                />
              ) : (
                <span title={image.name}>{image.name}</span>
              )}
              <button type="button" className="text-button" onClick={() => onRemove(image)} disabled={disabled}>移除</button>
            </div>
          </article>
        ))}

        <button type="button" className="credential-image-add" onClick={() => inputRef.current?.click()} disabled={disabled}>
          <span aria-hidden="true">+</span>
          <strong>添加图片</strong>
          <small>支持多选或拖入</small>
        </button>
      </div>

      <input
        ref={inputRef}
        className="credential-image-input"
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.bmp,.gif"
        multiple
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />

      <AppDialog
        open={Boolean(preview)}
        onOpenChange={(open) => !open && setPreview(null)}
        kicker="原图预览"
        title={preview?.customName || preview?.name || '资信图片'}
        cardClassName="credential-image-preview-dialog"
        actions={<button type="button" className="secondary-action" onClick={() => setPreview(null)}>关闭</button>}
      >
        {preview ? <img src={preview.url} alt={preview.customName || preview.name} /> : null}
      </AppDialog>
    </section>
  );
}

export default CredentialImageField;
