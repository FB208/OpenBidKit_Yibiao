import { DocxEditor, useEditorState } from '@docx-editor.dev/react';
import { useEffect, useState } from 'react';

interface ContentWordPreviewProps {
  sectionId: string;
  requestVersion: number;
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

// 只在明确点击或重新加载时生成当前小节的临时 Word，不跟随后台扫描自动转换。
export default function ContentWordPreview({ sectionId, requestVersion, contentContext }: ContentWordPreviewProps) {
  const [loaded, setLoaded] = useState<{ document?: Uint8Array; context: object }>();
  // 在渲染时就撤下失效文档，不等读取结束；迟到的旧响应也不能跨快照展示。
  const document = loaded?.context === contentContext ? loaded.document : undefined;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState<{ context: object; version: number }>();
  const reloadVersion = reload?.context === contentContext ? reload.version : 0;
  const requested = Boolean(requestVersion || reloadVersion);

  // 重新加载也请求最新 HTML；旧任务的重试次数不带入新上下文。
  const retry = () => setReload((previous) => ({ context: contentContext, version: (previous?.version || 0) + 1 }));

  useEffect(() => {
    let active = true;
    if (!requestVersion && !reloadVersion) {
      setLoading(false);
      setError('');
      return;
    }
    setLoaded(undefined);
    setLoading(true);
    setError('');
    window.yibiao.technicalPlan.previewContentWord(sectionId).then((bytes) => {
      if (active) setLoaded({ document: bytes ? new Uint8Array(bytes) : undefined, context: contentContext });
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [sectionId, requestVersion, reloadVersion, contentContext]);

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
          <WordDocumentStatus onRetry={retry} />
        </DocxEditor>
      )}
      {(!document || error || loading) && (
        <div className={`content-word-status${document ? ' is-notice' : ''}`} role={error ? 'alert' : 'status'}>
          <strong>{error ? 'Word 预览失败' : loading ? '正在生成 Word 预览…' : requested ? '该小节尚无可预览正文' : '点击小节查看当前正文'}</strong>
          {error ? <p>{error}</p> : !loading && <p>每次点击小节或重新加载，都会按当前内容生成预览，后续流程仍可能修改正文。</p>}
          {!loading && <button type="button" className="secondary-action" onClick={retry}>重新加载</button>}
        </div>
      )}
    </div>
  );
}
