import { DocxEditor, useEditorState } from '@docx-editor.dev/react';
import { useEffect, useState } from 'react';

interface ContentWordPreviewProps {
  sectionId: string;
  refreshKey: string;
  contentContext: object;
}

// 订阅编辑器自身的解析状态，不用定时器猜测 Word 是否已打开。
function WordDocumentStatus({ onRetry }: { onRetry: () => void }) {
  const error = useEditorState((snapshot) => snapshot.parseError);
  const loading = useEditorState((snapshot) => snapshot.isLoading || Boolean(snapshot.isOpening));
  if (!error && !loading) return null;
  return (
    <div className="content-word-status" role={error ? 'alert' : 'status'}>
      <strong>{error ? 'Word 加载失败' : '正在打开 Word…'}</strong>
      {error && <><p>{error}</p><button type="button" className="secondary-action" onClick={onRetry}>重新加载</button></>}
    </div>
  );
}

// 每次只读取当前小节；切换时由页面的 key 隔离状态，刷新保留已有文档。
export default function ContentWordPreview({ sectionId, refreshKey, contentContext }: ContentWordPreviewProps) {
  const [loaded, setLoaded] = useState<{ document?: Uint8Array; context: object }>();
  // 在渲染时就撤下失效文档，不等读取结束；迟到的旧响应也不能跨快照展示。
  const document = loaded?.context === contentContext ? loaded.document : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    window.yibiao.technicalPlan.readContentWord(sectionId).then((bytes) => {
      if (active) setLoaded({ document: bytes ? new Uint8Array(bytes) : undefined, context: contentContext });
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [sectionId, refreshKey, reload, contentContext]);

  return (
    <div className="content-word-preview" aria-label={`${sectionId} 小节 Word 只读预览`}>
      {document && (
        <DocxEditor
          className="content-word-editor"
          document={document}
          mode="view"
          chrome={false}
          navigation={false}
          rulers={false}
          locale="zh-CN"
        >
          <WordDocumentStatus onRetry={() => setReload((value) => value + 1)} />
        </DocxEditor>
      )}
      {(!document || error || loading) && (
        <div className={`content-word-status${document ? ' is-notice' : ''}`} role={error ? 'alert' : 'status'}>
          <strong>{error ? 'Word 读取失败' : loading ? '正在读取 Word…' : '该小节尚未生成 Word'}</strong>
          {error ? <p>{error}</p> : !loading && <p>该小节转换成功后会自动显示在这里。</p>}
          {!loading && <button type="button" className="secondary-action" onClick={() => setReload((value) => value + 1)}>重新加载</button>}
        </div>
      )}
    </div>
  );
}
