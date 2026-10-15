import * as Dialog from '@radix-ui/react-dialog';

export interface PreviewImage {
  src: string;
  alt: string;
}

export interface ImagePreviewDialogProps {
  image: PreviewImage | null;
  onClose: () => void;
}

/** 远程公告等 Markdown 内容中的图片大图预览，层级高于普通弹窗。 */
export default function ImagePreviewDialog({ image, onClose }: ImagePreviewDialogProps) {
  return (
    <Dialog.Root open={Boolean(image)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="remote-notice-preview-modal" />
        <Dialog.Content className="remote-notice-preview-card">
          <Dialog.Title className="sr-only">{image?.alt || '公告图片预览'}</Dialog.Title>
          <Dialog.Description className="sr-only">查看公告中的图片大图。</Dialog.Description>
          <button className="remote-notice-preview-close" type="button" aria-label="关闭图片预览" onClick={onClose}>×</button>
          {image ? <img src={image.src} alt={image.alt} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
