import { useCallback, useEffect, useState } from 'react';
import type { DependencyProgress, DependencyStatus } from '../../../shared/types/ipc';
import { AppDialog, FloatingToolbar, ProgressBar, UploadBoard, UploadEmpty, UploadRow, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { DualLayerPdfEnvironment, DualLayerPdfItem, DualLayerPdfState } from '../types';

const EMPTY_STATE: DualLayerPdfState = { running: false, canceling: false, outputDir: '', items: [] };

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function describeItem(item: DualLayerPdfItem) {
  switch (item.status) {
    case 'exporting':
      return '正在用本机 Office 导出 PDF，文档较大时需要几分钟';
    case 'rendering':
      return item.pageCount ? `正在生成页面 ${item.pageDone}/${item.pageCount}` : '正在准备生成页面';
    case 'done':
      return `已完成，共 ${item.pageCount} 页，由 ${item.backendLabel} 导出`;
    case 'error':
      return item.message || '转换失败';
    case 'canceled':
      return '已取消';
    default:
      return '等待转换';
  }
}

function getItemProgress(item: DualLayerPdfItem) {
  if (item.status === 'done') return 100;
  if (item.status === 'rendering' && item.pageCount) return 10 + (item.pageDone / item.pageCount) * 90;
  return item.status === 'exporting' || item.status === 'rendering' ? 5 : 0;
}

/** 批量转双层 PDF：文件列表和进度保存在 Main，离开页面不中断，回来后从 Main 读回。 */
function DualLayerPdfPage() {
  const { showToast } = useToast();
  const [state, setState] = useState<DualLayerPdfState>(EMPTY_STATE);
  const [environment, setEnvironment] = useState<DualLayerPdfEnvironment | null>(null);
  const [ocrStatus, setOcrStatus] = useState<DependencyStatus | null>(null);
  const [ocrProgress, setOcrProgress] = useState<DependencyProgress | null>(null);
  const [ocrDialogOpen, setOcrDialogOpen] = useState(false);
  const [ocrInstalling, setOcrInstalling] = useState(false);

  const reportError = useCallback((error: unknown, fallback: string) => {
    showToast(error instanceof Error ? error.message : fallback, 'error');
  }, [showToast]);

  useEffect(() => {
    let disposed = false;
    const bridge = window.yibiao.dualLayerPdf;
    void bridge.getState().then((next) => { if (!disposed) setState(next); });
    const offEvent = bridge.onEvent((next) => setState(next));

    void bridge.getEnvironment()
      .then(async (env) => {
        if (disposed) return;
        setEnvironment(env);
        const status = await window.yibiao.dependencies.getStatus(env.ocrDependencyId);
        if (disposed) return;
        setOcrStatus(status);
        setOcrInstalling(status.installing);
        setOcrProgress(status.progress);
        // 没有安装文字识别组件且线上有可用安装包时，询问是否下载。
        if (!status.installed && status.available) setOcrDialogOpen(true);
      })
      .catch((error) => reportError(error, '读取转换环境失败'));

    const offProgress = window.yibiao.dependencies.onProgress((progress) => setOcrProgress(progress));
    return () => {
      disposed = true;
      offEvent();
      offProgress();
    };
  }, [reportError]);

  const run = (action: () => Promise<DualLayerPdfState | void>, fallback: string) => {
    void action()
      .then((next) => { if (next) setState(next); })
      .catch((error) => reportError(error, fallback));
  };

  const installOcr = async () => {
    if (!environment) return;
    setOcrInstalling(true);
    setOcrProgress({ id: environment.ocrDependencyId, phase: 'downloading', percent: 0 });
    try {
      setOcrStatus(await window.yibiao.dependencies.install(environment.ocrDependencyId));
      setOcrDialogOpen(false);
      showToast('文字识别组件已安装', 'success');
    } catch (error) {
      reportError(error, '文字识别组件安装失败');
    } finally {
      setOcrInstalling(false);
    }
  };

  const hasBackend = Boolean(environment?.backends.length);
  const pendingCount = state.items.filter((item) => item.status === 'pending').length;
  const ocrAvailable = ocrStatus?.available;
  const ocrPercent = ocrProgress?.phase === 'downloading' ? ocrProgress.percent : 100;

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'files',
      actions: [
        { id: 'add', label: '添加文件', variant: 'secondary', onClick: () => run(() => window.yibiao.dualLayerPdf.selectFiles(), '添加文件失败') },
        { id: 'clear', label: '清空列表', variant: 'ghost', disabled: !state.items.length, onClick: () => run(() => window.yibiao.dualLayerPdf.clear(), '清空列表失败') },
      ],
    },
    {
      id: 'run',
      actions: state.running
        ? [{ id: 'cancel', label: state.canceling ? '正在取消' : '取消转换', variant: 'danger', disabled: state.canceling, onClick: () => run(() => window.yibiao.dualLayerPdf.cancel(), '取消失败') }]
        : [{
            id: 'start',
            label: '开始转换',
            variant: 'primary',
            disabled: !hasBackend || !pendingCount,
            tooltip: !hasBackend ? '本机没有可用的转换程序' : !pendingCount ? '请先添加要转换的 Word 文档' : undefined,
            onClick: () => run(() => window.yibiao.dualLayerPdf.start(), '开始转换失败'),
          }],
    },
  ];

  return (
    <div className="dual-layer-pdf-page">
      <div className="dual-layer-pdf-scroll">
        <UploadBoard
          kicker="其他功能"
          title="批量转双层PDF"
          subtitle="每页生成一张 150 dpi 的图片，下面叠一层位置对齐的文字，可搜索、可复制，并按标题生成书签。"
        >
          <UploadRow
            index="01"
            title="Word 文档"
            note="可多份，支持 docx、doc、wps"
            onDropFiles={(files) => {
              const paths = Array.from(files).map((file) => window.yibiao.file.getPathForFile(file)).filter(Boolean);
              if (paths.length) run(() => window.yibiao.dualLayerPdf.addFiles(paths), '添加文件失败');
            }}
            actions={(
              <button type="button" className="primary-action" onClick={() => run(() => window.yibiao.dualLayerPdf.selectFiles(), '添加文件失败')}>
                {state.items.length ? '继续添加' : '添加文件'}
              </button>
            )}
          >
            {state.items.length ? (
              <div className="dual-layer-pdf-summary">
                已添加 {state.items.length} 份，{state.items.filter((item) => item.status === 'done').length} 份已完成
              </div>
            ) : (
              <UploadEmpty title="等待添加 Word 文档" hint="点击添加文件，或把文件拖到这里。" />
            )}
          </UploadRow>

          <UploadRow
            index="02"
            title="保存位置"
            note="同名文件不会被覆盖"
            actions={(
              <>
                {state.outputDir ? (
                  <button type="button" className="text-button" onClick={() => run(() => window.yibiao.dualLayerPdf.resetOutputDir(), '修改保存位置失败')}>恢复默认</button>
                ) : null}
                <button type="button" className="secondary-action" onClick={() => run(() => window.yibiao.dualLayerPdf.selectOutputDir(), '选择保存位置失败')}>选择文件夹</button>
              </>
            )}
          >
            <div className="dual-layer-pdf-summary" title={state.outputDir}>{state.outputDir || '与源文件相同的文件夹'}</div>
          </UploadRow>

          <UploadRow
            index="03"
            title="转换环境"
            actions={ocrAvailable && (!ocrStatus?.installed || ocrStatus.hasUpdate) ? (
              <button type="button" className="secondary-action" disabled={ocrInstalling || state.running} onClick={() => setOcrDialogOpen(true)}>
                {ocrStatus?.installed ? '更新文字识别组件' : '下载文字识别组件'}
              </button>
            ) : null}
          >
            <div className="dual-layer-pdf-environment">
              {environment ? (
                hasBackend ? (
                  <span>转换程序：{environment.backends.map((backend) => backend.label).join('、')}（按顺序尝试）</span>
                ) : (
                  <span className="is-danger">本机没有找到 Microsoft Word、WPS Office 或 LibreOffice，安装其中一种后才能转换。</span>
                )
              ) : (
                <span>正在检查本机的转换程序</span>
              )}
              {ocrStatus?.installed ? (
                <span>文字识别组件：已安装 {ocrStatus.installedVersion}{ocrStatus.hasUpdate ? `，有新版本 ${ocrStatus.available?.version}` : ''}</span>
              ) : ocrStatus ? (
                <span className="is-warning">
                  文字识别组件：未安装，图片中的文字无法搜索和复制，正文不受影响。{ocrStatus.message || (ocrAvailable ? '' : '暂时没有可下载的安装包。')}
                </span>
              ) : null}
            </div>
          </UploadRow>
        </UploadBoard>

        {state.items.length ? (
          <section className="dual-layer-pdf-list" aria-label="转换列表">
            {state.items.map((item) => {
              const active = item.status === 'exporting' || item.status === 'rendering';
              return (
                <article key={item.id} className={`dual-layer-pdf-item is-${item.status}`}>
                  <div className="dual-layer-pdf-item-main">
                    <strong title={item.sourcePath}>{item.fileName}</strong>
                    <span>{describeItem(item)}</span>
                    {active || item.status === 'done' ? (
                      <ProgressBar value={getItemProgress(item)} active={active} tone={item.status === 'done' ? 'success' : 'primary'} label={describeItem(item)} />
                    ) : null}
                    {item.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                    {item.status === 'done' ? <small className="is-path" title={item.outputPath}>{item.outputPath}</small> : null}
                  </div>
                  <div className="dual-layer-pdf-item-actions">
                    {item.status === 'done' ? (
                      <>
                        <button type="button" className="text-button" onClick={() => void window.yibiao.export.openFile(item.outputPath).catch((error) => reportError(error, '打开文件失败'))}>打开</button>
                        <button type="button" className="text-button" onClick={() => run(() => window.yibiao.dualLayerPdf.showInFolder(item.outputPath), '打开文件夹失败')}>所在文件夹</button>
                      </>
                    ) : null}
                    {item.status === 'error' || item.status === 'canceled' ? (
                      <button type="button" className="text-button" onClick={() => run(() => window.yibiao.dualLayerPdf.retryItem(item.id), '重试失败')}>重试</button>
                    ) : null}
                    {!active ? (
                      <button type="button" className="text-button" onClick={() => run(() => window.yibiao.dualLayerPdf.removeItem(item.id), '移除失败')}>移除</button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
        ) : null}
      </div>

      <FloatingToolbar groups={toolbarGroups} label="批量转双层PDF工具条" />

      <AppDialog
        open={ocrDialogOpen}
        onOpenChange={setOcrDialogOpen}
        preventClose={ocrInstalling}
        kicker="文字识别组件"
        title={ocrStatus?.installed ? '更新文字识别组件？' : '下载文字识别组件？'}
        description={(
          <>
            文档里插入的图片（证书、扫描件等）需要文字识别后，其中的文字才能搜索和复制。
            组件约 {formatSize(ocrAvailable?.size || 0)}，只需下载一次。不下载也可以转换，正文文字不受影响。
          </>
        )}
        actions={(
          <>
            <button type="button" className="secondary-action" disabled={ocrInstalling} onClick={() => setOcrDialogOpen(false)}>暂不下载</button>
            <button type="button" className="primary-action" disabled={ocrInstalling} onClick={() => void installOcr()}>
              {ocrInstalling ? (ocrProgress?.phase === 'extracting' ? '正在解压' : `正在下载 ${Math.round(ocrPercent)}%`) : '下载并安装'}
            </button>
          </>
        )}
      >
        {ocrInstalling ? <ProgressBar value={ocrPercent} active label="文字识别组件下载进度" /> : null}
      </AppDialog>
    </div>
  );
}

export default DualLayerPdfPage;
