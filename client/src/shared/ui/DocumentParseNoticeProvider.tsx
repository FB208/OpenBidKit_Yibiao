import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export const LIBREOFFICE_DOWNLOAD_URL = 'https://zh-tw.libreoffice.org/download/';
export const LIBREOFFICE_REQUIRED_MESSAGE = `.doc和.wps识别，需要安装LibreOffice （点此下载：${LIBREOFFICE_DOWNLOAD_URL}），或者手动将文件转换为.docx格式再上传`;

interface DocumentParseNoticeContextValue {
  showDocumentParseNotice: (message?: string) => void;
}

const DocumentParseNoticeContext = createContext<DocumentParseNoticeContextValue | null>(null);

export function isLibreOfficeRequiredMessage(value: unknown) {
  const message = String(value || '');
  return message.includes('需要安装LibreOffice') && (message.includes('.doc') || message.includes('.wps'));
}

export function DocumentParseNoticeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const showDocumentParseNotice = useCallback(() => {
    setOpen(true);
  }, []);

  const openDownload = useCallback(() => {
    void window.yibiao?.openExternal(LIBREOFFICE_DOWNLOAD_URL);
  }, []);

  const value = useMemo(() => ({ showDocumentParseNotice }), [showDocumentParseNotice]);

  return (
    <DocumentParseNoticeContext.Provider value={value}>
      {children}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="document-parse-notice-modal" />
          <Dialog.Content className="document-parse-notice-card">
            <div className="document-parse-notice-head">
              <div>
                <span>本地转换组件缺失</span>
                <Dialog.Title>需要安装 LibreOffice</Dialog.Title>
              </div>
              <Dialog.Close className="document-parse-notice-close" type="button" aria-label="关闭提示">×</Dialog.Close>
            </div>
            <Dialog.Description className="document-parse-notice-body">
              .doc 和 .wps 识别需要安装 LibreOffice，或者手动将文件转换为 .docx 格式再上传。
            </Dialog.Description>
            <div className="document-parse-notice-actions">
              <button className="primary-action" type="button" onClick={openDownload}>下载 LibreOffice</button>
              <Dialog.Close className="secondary-action" type="button">我知道了</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </DocumentParseNoticeContext.Provider>
  );
}

export function useDocumentParseNotice() {
  const context = useContext(DocumentParseNoticeContext);

  if (!context) {
    throw new Error('useDocumentParseNotice 必须在 DocumentParseNoticeProvider 内使用');
  }

  return context;
}
