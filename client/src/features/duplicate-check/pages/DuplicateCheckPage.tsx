import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingToolbar, ToolbarArrowRightIcon, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { DuplicateAnalysisTabId, DuplicateCheckStep, DuplicateCheckWorkspaceState, LocalFileSelection } from '../../../shared/types';

const guideItems = [
  '同设备、同用户、同一个 WPS 账号、时间相近等问题，一秒锁定。',
  '可选上传招标文件，多份投标文件都引用了招标文件中的内容，不算重复。',
  '图片基于哈希校验，只能识别同一张图片，截图、压缩等相似图片筛不出来。',
];

const dimensions = [
  { title: '元数据', text: '检查设备、账号、编辑时间、作者等隐藏信息。' },
  { title: '目录', text: '比对章节结构和标题顺序，识别模板化复制。' },
  { title: '正文', text: '筛查段落、表格和关键描述的重复内容。' },
  { title: '图片', text: '对原图做哈希校验，定位完全一致的图片。' },
];

const analysisTabs: Array<{
  id: DuplicateAnalysisTabId;
  label: string;
  status: 'running' | 'completed';
  progress: number;
}> = [
  { id: 'metadata', label: '元数据', status: 'running', progress: 42 },
  { id: 'outline', label: '目录', status: 'running', progress: 18 },
  { id: 'content', label: '正文', status: 'running', progress: 8 },
  { id: 'image', label: '图片', status: 'completed', progress: 100 },
];

const defaultAnalysisTab: DuplicateAnalysisTabId = 'metadata';

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function FilePill({ file, onRemove }: { file: LocalFileSelection; onRemove: () => void }) {
  return (
    <article className="duplicate-file-pill">
      <div className="duplicate-file-icon">{file.extension.replace('.', '').slice(0, 4).toUpperCase() || 'DOC'}</div>
      <div className="duplicate-file-info">
        <strong title={file.file_name}>{file.file_name}</strong>
        <span>{formatFileSize(file.size)} · {formatDate(file.modified_at)}</span>
      </div>
      <button type="button" onClick={onRemove} aria-label={`删除 ${file.file_name}`}>删除</button>
    </article>
  );
}

function DuplicateAnalysisPane({ activeTab, onTabChange }: { activeTab: DuplicateAnalysisTabId; onTabChange: (tab: DuplicateAnalysisTabId) => void }) {
  const activeItem = analysisTabs.find((item) => item.id === activeTab) || analysisTabs[0];

  return (
    <section className="duplicate-analysis-panel">
      <div className="duplicate-analysis-tabs" role="tablist" aria-label="标书查重维度">
        {analysisTabs.map((item) => {
          const isActive = item.id === activeTab;
          const isRunning = item.status === 'running';

          return (
            <button
              type="button"
              className={`duplicate-analysis-tab${isActive ? ' is-active' : ''}${isRunning ? ' is-running' : ' is-completed'}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`duplicate-analysis-panel-${item.id}`}
              id={`duplicate-analysis-tab-${item.id}`}
              key={item.id}
              onClick={() => onTabChange(item.id)}
            >
              <span className="duplicate-analysis-tab-main">
                <strong>{item.label}</strong>
                <em>{isRunning ? '分析中' : '已完成'}</em>
              </span>
              {isRunning && (
                <span className="duplicate-analysis-progress" aria-label={`${item.label}分析进度 ${item.progress}%`}>
                  <span style={{ width: `${item.progress}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        className="duplicate-analysis-content"
        role="tabpanel"
        id={`duplicate-analysis-panel-${activeItem.id}`}
        aria-labelledby={`duplicate-analysis-tab-${activeItem.id}`}
      >
        <span className="section-kicker">{activeItem.label}</span>
        <h3>{activeItem.label}查重结果区域</h3>
        <p>这里先保留内容骨架，后续接入查重任务后展示分析日志、重复项列表和处理结果。</p>
      </div>
    </section>
  );
}

function DuplicateCheckPage() {
  const [tenderFile, setTenderFile] = useState<LocalFileSelection | null>(null);
  const [bidFiles, setBidFiles] = useState<LocalFileSelection[]>([]);
  const [step, setStep] = useState<DuplicateCheckStep>('upload');
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<DuplicateAnalysisTabId>(defaultAnalysisTab);
  const [busy, setBusy] = useState<'tender' | 'bid' | null>(null);
  const hydratedRef = useRef(false);
  const { showToast } = useToast();

  const totalSize = useMemo(() => bidFiles.reduce((sum, file) => sum + file.size, tenderFile?.size || 0), [bidFiles, tenderFile]);
  const canGoNext = bidFiles.length > 0;

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.workspace.loadDuplicateCheck()
      .then((state) => {
        if (canceled || !state) return;
        setTenderFile(state.tenderFile || null);
        setBidFiles(Array.isArray(state.bidFiles) ? state.bidFiles : []);
        setStep(state.step === 'analysis' ? 'analysis' : 'upload');
        setActiveAnalysisTab(analysisTabs.some((item) => item.id === state.activeAnalysisTab) ? state.activeAnalysisTab as DuplicateAnalysisTabId : defaultAnalysisTab);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取标书查重缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    const state: DuplicateCheckWorkspaceState = { tenderFile, bidFiles, step, activeAnalysisTab };
    void window.yibiao?.workspace.saveDuplicateCheck(state)
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存标书查重缓存失败', 'error');
      });
  }, [activeAnalysisTab, bidFiles, showToast, step, tenderFile]);

  const selectFiles = async (multiple: boolean) => {
    const selector = window.yibiao?.file?.selectDuplicateCheckFiles;
    if (typeof selector !== 'function') {
      throw new Error('文件选择接口尚未加载，请重启应用后重试');
    }
    return selector({ multiple });
  };

  const uploadTenderFile = async () => {
    try {
      setBusy('tender');
      const result = await selectFiles(false);
      if (!result?.success || !result.files?.length) {
        showToast(result?.message || '未选择招标文件', result?.message === '已取消选择' ? 'info' : 'error');
        return;
      }
      setTenderFile(result.files[0]);
      showToast('招标文件已加入，暂不执行解析', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择招标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const uploadBidFiles = async () => {
    try {
      setBusy('bid');
      const result = await selectFiles(true);
      if (!result?.success || !result.files?.length) {
        showToast(result?.message || '未选择投标文件', result?.message === '已取消选择' ? 'info' : 'error');
        return;
      }

      const exists = new Set(bidFiles.map((file) => file.file_path));
      const nextFiles = result.files.filter((file) => !exists.has(file.file_path));
      if (nextFiles.length < result.files.length) {
        showToast('已跳过重复选择的投标文件', 'info');
      }
      setBidFiles((prev) => [...prev, ...nextFiles]);
      if (nextFiles.length > 0) {
        showToast('投标文件已加入，暂不执行解析', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择投标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetFiles = () => {
    setTenderFile(null);
    setBidFiles([]);
    setStep('upload');
    setActiveAnalysisTab(defaultAnalysisTab);
    void window.yibiao?.workspace.clearDuplicateCheck()
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空标书查重缓存失败', 'error');
      });
    showToast('已重置上传列表', 'success');
  };

  const goNext = () => {
    if (!canGoNext) {
      showToast('请先上传至少一份投标文件', 'info');
      return;
    }

    if (step === 'upload') {
      setStep('analysis');
      return;
    }

    showToast('查重处理流程待接入', 'info');
  };

  const goHome = () => {
    setStep('upload');
  };

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'duplicate-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          disabled: !tenderFile && bidFiles.length === 0,
          tooltip: '清空已选择的招标文件和投标文件',
          onClick: resetFiles,
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'upload' ? 'primary' : 'secondary',
          tooltip: '回到上传文件首页',
          onClick: goHome,
        },
      ],
    },
    {
      id: 'duplicate-check-navigation',
      actions: [
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: !canGoNext,
          tooltip: canGoNext ? '进入查重处理流程' : '请先上传至少一份投标文件',
          onClick: goNext,
        },
      ],
    },
  ];

  return (
    <div className="duplicate-check-page">
      {step === 'upload' ? (
        <>
          <section className="duplicate-upload-board">
            <div className="duplicate-page-title">
              <div>
                <span className="section-kicker">文本风险</span>
                <h2>标书查重</h2>
              </div>
              <div className="duplicate-upload-summary">
                <span>{tenderFile ? '1 份招标文件' : '未上传招标文件'}</span>
                <strong>{bidFiles.length} 份投标文件</strong>
                <small>{formatFileSize(totalSize)}</small>
              </div>
            </div>

            <div className="duplicate-upload-stack">
              <article className="duplicate-upload-row">
                <div className="duplicate-upload-label">
                  <span>01</span>
                  <strong>招标文件</strong>
                  <small>可选，仅一份</small>
                </div>
                <div className="duplicate-upload-content">
                  {tenderFile ? (
                    <FilePill file={tenderFile} onRemove={() => setTenderFile(null)} />
                  ) : (
                    <div className="duplicate-empty-upload" />
                  )}
                </div>
                <button type="button" className="primary-action duplicate-upload-button" onClick={uploadTenderFile} disabled={busy !== null}>
                  {busy === 'tender' ? '选择中...' : tenderFile ? '替换' : '上传'}
                </button>
              </article>

              <article className="duplicate-upload-row bid-row">
                <div className="duplicate-upload-label">
                  <span>02</span>
                  <strong>投标文件</strong>
                  <small>必选，可多份</small>
                </div>
                <div className="duplicate-upload-content">
                  {bidFiles.length ? (
                    <div className="duplicate-file-list">
                      {bidFiles.map((file) => (
                        <FilePill key={file.file_path} file={file} onRemove={() => setBidFiles((prev) => prev.filter((item) => item.file_path !== file.file_path))} />
                      ))}
                    </div>
                  ) : (
                    <div className="duplicate-empty-upload" />
                  )}
                </div>
                <button type="button" className="primary-action duplicate-upload-button" onClick={uploadBidFiles} disabled={busy !== null}>
                  {busy === 'bid' ? '选择中...' : '上传'}
                </button>
              </article>
            </div>
          </section>

          <section className="duplicate-guide-panel">
            <div className="duplicate-guide-head">
              <div>
                <strong>多维度筛查重复项</strong>
              </div>
            </div>

            <div className="duplicate-dimension-grid">
              {dimensions.map((item) => (
                <article key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>

            <ul className="duplicate-guide-list">
              {guideItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        </>
      ) : (
        <DuplicateAnalysisPane activeTab={activeAnalysisTab} onTabChange={setActiveAnalysisTab} />
      )}

      <FloatingToolbar groups={toolbarGroups} label="标书查重工具条" />
    </div>
  );
}

export default DuplicateCheckPage;
