import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingToolbar, isLibreOfficeRequiredMessage, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { DuplicateAnalysisStatus, DuplicateAnalysisTabId, DuplicateCheckStep, DuplicateCheckWorkspaceState, DuplicateContentAnalysisState, DuplicateImageAnalysisState, DuplicateMetadataAnalysisState, DuplicateOutlineAnalysisState, DuplicateOutlineFileResult, DuplicateOutlineItem, LocalFileSelection } from '../../../shared/types';

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
}> = [
  { id: 'metadata', label: '元数据' },
  { id: 'outline', label: '目录' },
  { id: 'content', label: '正文' },
  { id: 'image', label: '图片' },
];

const defaultAnalysisTab: DuplicateAnalysisTabId = 'metadata';
const steps: DuplicateCheckStep[] = ['upload', 'analysis'];
const stepLabels: Record<DuplicateCheckStep, string> = {
  upload: '选择标书',
  analysis: '查重结果',
};

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

function statusLabel(status: DuplicateAnalysisStatus) {
  if (status === 'running') return '分析中';
  if (status === 'success') return '已完成';
  if (status === 'error') return '有错误';
  return '待分析';
}

function progressText(progress?: { completed: number; total: number }) {
  if (!progress?.total) return '0/0';
  return `${progress.completed}/${progress.total}`;
}

function fileIndexLabel(index: number) {
  let value = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function buildFileLabelMap(files: LocalFileSelection[]) {
  return new Map(files.map((file, index) => [file.id, fileIndexLabel(index)]));
}

function formatDuplicateSentenceText(normalized: string, sentence: string) {
  const text = normalized || sentence;
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function createDuplicateCheckSignature(files: LocalFileSelection[]) {
  const source = files
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`)
    .join('\n');
  const bytes = new TextEncoder().encode(source);
  const words = new Uint32Array(80);
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f = 0;
      let k = 0;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, '0')).join('');
}

function rotateLeft(value: number, bits: number) {
  return (value << bits) | (value >>> (32 - bits));
}

function DuplicateFileCodeBar({ files }: { files: LocalFileSelection[] }) {
  return (
    <div className="duplicate-file-codebar" aria-label="投标文件编号">
      {files.map((file, index) => (
        <span key={file.id} title={file.file_name}>
          <strong>{fileIndexLabel(index)}</strong>{file.file_name}
        </span>
      ))}
    </div>
  );
}

function PaginationControls({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="duplicate-pagination">
      <span>第 {Math.min(page, totalPages)} / {totalPages} 页，共 {total} 条</span>
      <div>
        <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>上一页</button>
        <button type="button" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>下一页</button>
      </div>
    </div>
  );
}

function DuplicateMetadataPane({ analysis, bidFiles }: { analysis?: DuplicateMetadataAnalysisState; bidFiles: LocalFileSelection[] }) {
  const isRunning = analysis?.status === 'running';
  const isDone = analysis?.status === 'success' || analysis?.status === 'error';
  const rows = analysis?.rows || [];
  const files = analysis?.files?.length ? analysis.files : bidFiles.map((file) => ({ file_id: file.id, file_name: file.file_name, status: 'pending' as const, metadata: [] }));

  return (
    <div className="duplicate-metadata-panel">
      <div className="duplicate-metadata-status-grid">
        <article>
          <span>正文内容提取</span>
          <strong>{progressText(analysis?.contentExtraction)}</strong>
          <small>{statusLabel(analysis?.contentExtraction?.status || 'pending')}</small>
        </article>
        <article>
          <span>元数据提取</span>
          <strong>{progressText(analysis?.metadataExtraction)}</strong>
          <small>{statusLabel(analysis?.metadataExtraction?.status || 'pending')}</small>
        </article>
      </div>

      {!analysis && (
        <div className="duplicate-analysis-empty">
          <strong>等待启动元数据分析</strong>
          <p>首次进入查重结果后，会自动并发执行正文内容提取和投标文件元数据提取。</p>
        </div>
      )}

      {analysis && !rows.length && (
        <div className="duplicate-analysis-empty">
          <strong>{isRunning ? '正在提取元数据' : '暂无可对比元数据'}</strong>
          <p>{analysis.message || '请稍候，文件较多时需要一定时间。'}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="duplicate-metadata-table-wrap">
          <table className="duplicate-metadata-table">
            <thead>
              <tr>
                <th>元数据项</th>
                {files.map((file) => <th key={file.file_id} title={file.file_name}>{file.file_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th>{row.label}</th>
                  {files.map((file) => {
                    const duplicated = row.duplicate_file_ids.includes(file.file_id);
                    const sameDay = row.same_day_file_ids?.includes(file.file_id);
                    return (
                      <td key={file.file_id} className={duplicated ? 'is-duplicate' : sameDay ? 'is-same-day' : undefined}>
                        {row.values[file.file_id] || '-'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isDone && analysis?.contentFiles?.some((file) => file.status === 'error') && (
        <p className="duplicate-analysis-warning">部分文件正文提取失败，可重新选择文件后再分析。</p>
      )}
    </div>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function sourceLabel(source?: string) {
  if (source === 'catalog') return '目录页';
  if (source === 'heading') return '标题样式';
  if (source === 'semantic') return '语义标题';
  return '未识别';
}

function buildOutlineChildren(items: DuplicateOutlineItem[]) {
  const children = new Map<string, DuplicateOutlineItem[]>();
  for (const item of items) {
    const key = item.parent_id || 'root';
    children.set(key, [...(children.get(key) || []), item]);
  }
  return children;
}

function DuplicateOutlineTree({ file }: { file?: DuplicateOutlineFileResult }) {
  if (!file) {
    return <div className="duplicate-analysis-empty"><strong>请选择投标文件</strong><p>左侧选择文件后查看多级目录树。</p></div>;
  }
  if (!file.items.length) {
    return <div className="duplicate-analysis-empty"><strong>未识别到目录</strong><p>{file.error || '当前文件没有提取到可用目录结构。'}</p></div>;
  }

  const children = buildOutlineChildren(file.items);
  const renderItems = (parentId = 'root') => (children.get(parentId) || []).map((item) => {
    const duplicated = item.duplicate_group_ids.length > 0;
    const similar = item.similar_group_ids.length > 0;
    return (
      <li key={item.id} className={`duplicate-outline-node${duplicated ? ' is-duplicate' : similar ? ' is-similar' : ''}${item.from_tender ? ' is-from-tender' : ''}`}>
        <div className="duplicate-outline-node-main" title={item.matched_tender_sentence || item.path_titles.join(' > ')}>
          <span className="duplicate-outline-node-title">{item.number ? `${item.number} ` : ''}{item.title}</span>
          <span className="duplicate-outline-node-tags">
            {duplicated && <em>重复</em>}
            {!duplicated && similar && <em>相似</em>}
            {item.from_tender && <em className="is-muted">来自招标文件</em>}
            <em className="is-source">{sourceLabel(item.source)}</em>
          </span>
        </div>
        {children.has(item.id) && <ol>{renderItems(item.id)}</ol>}
      </li>
    );
  });

  return <ol className="duplicate-outline-tree">{renderItems()}</ol>;
}

function DuplicateOutlinePane({ analysis, bidFiles }: { analysis?: DuplicateOutlineAnalysisState; bidFiles: LocalFileSelection[] }) {
  const files = analysis?.files || [];
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const selectedFile = files.find((file) => file.file_id === selectedFileId) || files[0];
  const successfulFiles = files.filter((file) => file.status === 'success');

  useEffect(() => {
    if (!selectedFileId && files[0]) setSelectedFileId(files[0].file_id);
    if (selectedFileId && files.length && !files.some((file) => file.file_id === selectedFileId)) setSelectedFileId(files[0].file_id);
  }, [files, selectedFileId]);

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待目录分析</strong><p>元数据提取完成后会自动开始目录分析。</p></div>;
  }

  return (
    <div className="duplicate-outline-panel">
      <div className="duplicate-outline-workbench">
        <aside className="duplicate-outline-files">
          <strong>投标文件目录</strong>
          {files.length ? files.map((file) => (
            <button type="button" key={file.file_id} className={file.file_id === selectedFile?.file_id ? 'is-active' : undefined} onClick={() => setSelectedFileId(file.file_id)}>
              <span>{file.file_name}</span>
              <small>{file.item_count} 项 · {sourceLabel(file.source)} · 招标命中 {file.tender_matched_count}</small>
            </button>
          )) : bidFiles.map((file) => <button type="button" key={file.id} disabled><span>{file.file_name}</span><small>等待提取</small></button>)}
        </aside>

        <section className="duplicate-outline-card duplicate-outline-tree-card">
          <div className="duplicate-outline-card-head">
            <strong>{selectedFile?.file_name || '目录树'}</strong>
            {selectedFile && <span>{selectedFile.item_count} 项 · 置信度 {formatPercent(selectedFile.confidence || 0)}</span>}
          </div>
          <DuplicateOutlineTree file={selectedFile} />
        </section>

        <aside className="duplicate-outline-groups">
          <strong>重复组</strong>
          {analysis.duplicateGroups.length ? analysis.duplicateGroups.slice(0, 80).map((group) => (
            <article key={group.id} className={`is-${group.type}`}>
              <div><span>{group.type === 'duplicate' ? '强重复' : '疑似相似'}</span><em>{formatPercent(group.score)}</em></div>
              <strong>{group.title}</strong>
              <small>涉及 {group.file_ids.length} 份文件</small>
              {group.file_ids.map((fileId) => <p key={fileId}>{files.find((file) => file.file_id === fileId)?.file_name || fileId}：{(group.paths[fileId] || []).join('；')}</p>)}
            </article>
          )) : <p className="duplicate-outline-muted">暂无投标文件之间的目录重复项。</p>}
        </aside>
      </div>

      {analysis.status === 'error' && <p className="duplicate-analysis-warning">部分文件目录提取失败，可重新查重或检查文档是否包含可选中文字。</p>}
      {analysis.status === 'success' && successfulFiles.length > 0 && !analysis.duplicateGroups.length && (
        <p className="duplicate-outline-muted">未发现投标文件之间的目录重复；来自招标文件的目录项已自动排除。</p>
      )}
    </div>
  );
}

function DuplicateContentPane({ analysis, bidFiles }: { analysis?: DuplicateContentAnalysisState; bidFiles: LocalFileSelection[] }) {
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const labelMap = useMemo(() => buildFileLabelMap(bidFiles), [bidFiles]);
  const duplicateSentences = analysis?.duplicateSentences || [];
  const totalPages = Math.max(1, Math.ceil(duplicateSentences.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = duplicateSentences.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => setPage(1), [duplicateSentences.length]);

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待正文比对</strong><p>正文内容提取完成后会自动开始句子级比对。</p></div>;
  }

  return (
    <div className="duplicate-match-panel">
      <DuplicateFileCodeBar files={bidFiles} />
      {duplicateSentences.length ? (
        <section className="duplicate-match-card">
          <div className="duplicate-match-card-head">
            <strong>重复句子</strong>
            <span>{analysis.message} · 已排除招标引用 {analysis.tenderMatchedSentenceCount} 句</span>
          </div>
          <div className="duplicate-sentence-list">
            {pageItems.map((item) => (
              <article key={item.id}>
                <p>{formatDuplicateSentenceText(item.normalized, item.sentence)}</p>
                <div className="duplicate-file-badges">
                  {item.file_ids.map((fileId) => (
                    <span key={fileId} title={bidFiles.find((file) => file.id === fileId)?.file_name || fileId}>
                      {labelMap.get(fileId) || '?'}{item.occurrences[fileId] > 1 ? ` x${item.occurrences[fileId]}` : ''}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <PaginationControls page={currentPage} pageSize={pageSize} total={duplicateSentences.length} onPageChange={setPage} />
        </section>
      ) : (
        <div className="duplicate-analysis-empty">
          <strong>{analysis.status === 'running' ? '正在比对正文' : '未发现重复句子'}</strong>
          <p>{analysis.status === 'running' ? analysis.message : '未发现投标文件之间的重复句子；引用招标文件的句子已自动排除。'}</p>
        </div>
      )}
    </div>
  );
}

function DuplicateImagePane({ analysis, bidFiles }: { analysis?: DuplicateImageAnalysisState; bidFiles: LocalFileSelection[] }) {
  const [page, setPage] = useState(1);
  const pageSize = 24;
  const labelMap = useMemo(() => buildFileLabelMap(bidFiles), [bidFiles]);
  const duplicateImages = analysis?.duplicateImages || [];
  const totalPages = Math.max(1, Math.ceil(duplicateImages.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = duplicateImages.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => setPage(1), [duplicateImages.length]);

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待图片比对</strong><p>正文内容提取完成后会自动按图片 hash 比对。</p></div>;
  }

  return (
    <div className="duplicate-match-panel">
      <DuplicateFileCodeBar files={bidFiles} />
      {duplicateImages.length ? (
        <section className="duplicate-match-card">
          <div className="duplicate-match-card-head">
            <strong>重复图片</strong>
            <span>{analysis.message} · 共识别 {analysis.totalImageCount} 张图片</span>
          </div>
          <div className="duplicate-image-grid">
            {pageItems.map((item) => (
              <article key={item.id}>
                <div className="duplicate-image-preview">
                  <img src={item.preview_url} alt={`重复图片 ${item.hash.slice(0, 10)}`} loading="lazy" />
                </div>
                <strong>Hash {item.hash.slice(0, 12)}</strong>
                <div className="duplicate-file-badges">
                  {item.file_ids.map((fileId) => (
                    <span key={fileId} title={bidFiles.find((file) => file.id === fileId)?.file_name || fileId}>
                      {labelMap.get(fileId) || '?'}{item.occurrences[fileId] > 1 ? ` x${item.occurrences[fileId]}` : ''}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <PaginationControls page={currentPage} pageSize={pageSize} total={duplicateImages.length} onPageChange={setPage} />
        </section>
      ) : (
        <div className="duplicate-analysis-empty">
          <strong>{analysis.status === 'running' ? '正在比对图片' : '未发现重复图片'}</strong>
          <p>{analysis.status === 'running' ? analysis.message : '未发现投标文件之间完全相同的图片。'}</p>
        </div>
      )}
    </div>
  );
}

function DuplicateAnalysisPane({ activeTab, onTabChange, metadataAnalysis, outlineAnalysis, contentAnalysis, imageAnalysis, bidFiles, onRerun }: { activeTab: DuplicateAnalysisTabId; onTabChange: (tab: DuplicateAnalysisTabId) => void; metadataAnalysis?: DuplicateMetadataAnalysisState; outlineAnalysis?: DuplicateOutlineAnalysisState; contentAnalysis?: DuplicateContentAnalysisState; imageAnalysis?: DuplicateImageAnalysisState; bidFiles: LocalFileSelection[]; onRerun: () => void }) {
  const activeItem = analysisTabs.find((item) => item.id === activeTab) || analysisTabs[0];
  const metadataStatus = metadataAnalysis?.status || 'pending';
  const metadataProgress = metadataAnalysis?.status === 'success' || metadataAnalysis?.status === 'error'
    ? 100
    : metadataAnalysis?.metadataExtraction?.total
      ? Math.round((metadataAnalysis.metadataExtraction.completed / metadataAnalysis.metadataExtraction.total) * 100)
      : 0;
  const analysisRunning = metadataStatus === 'running' || outlineAnalysis?.status === 'running' || contentAnalysis?.status === 'running' || imageAnalysis?.status === 'running';

  return (
    <section className="duplicate-analysis-panel">
      <div className="duplicate-page-title duplicate-analysis-title">
        <div>
          <span className="section-kicker">STEP 02</span>
          <h2>查重结果</h2>
        </div>
        <button type="button" className="secondary-action" onClick={onRerun} disabled={!bidFiles.length || analysisRunning}>
          重新查重
        </button>
      </div>

      <div className="duplicate-analysis-tabs" role="tablist" aria-label="标书查重维度">
        {analysisTabs.map((item) => {
          const isActive = item.id === activeTab;
          const status: DuplicateAnalysisStatus = item.id === 'metadata'
            ? metadataStatus
            : item.id === 'outline'
              ? outlineAnalysis?.status || 'pending'
              : item.id === 'content'
                ? contentAnalysis?.status || 'pending'
                : item.id === 'image'
                  ? imageAnalysis?.status || 'pending'
                  : 'pending';
          const progress = item.id === 'metadata'
            ? metadataProgress
            : item.id === 'outline'
              ? outlineAnalysis?.progress || 0
              : item.id === 'content'
                ? contentAnalysis?.progress || 0
                : item.id === 'image'
                  ? imageAnalysis?.progress || 0
                  : 0;
          const isRunning = status === 'running';

          return (
            <button
              type="button"
              className={`duplicate-analysis-tab${isActive ? ' is-active' : ''} is-${status}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`duplicate-analysis-panel-${item.id}`}
              id={`duplicate-analysis-tab-${item.id}`}
              key={item.id}
              onClick={() => onTabChange(item.id)}
            >
              <span className="duplicate-analysis-tab-main">
                <strong>{item.label}</strong>
                <em>{statusLabel(status)}</em>
              </span>
              {status !== 'pending' && (
                <span className="duplicate-analysis-progress" aria-label={`${item.label}分析进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
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
        {activeItem.id === 'metadata' ? (
          <DuplicateMetadataPane analysis={metadataAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'outline' ? (
          <DuplicateOutlinePane analysis={outlineAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'content' ? (
          <DuplicateContentPane analysis={contentAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'image' ? (
          <DuplicateImagePane analysis={imageAnalysis} bidFiles={bidFiles} />
        ) : (
          <>
            <span className="section-kicker">{activeItem.label}</span>
            <h3>{activeItem.label}查重结果区域</h3>
            <p>这里先保留内容骨架，后续接入查重任务后展示分析日志、重复项列表和处理结果。</p>
          </>
        )}
      </div>
    </section>
  );
}

function DuplicateCheckPage() {
  const [tenderFile, setTenderFile] = useState<LocalFileSelection | null>(null);
  const [bidFiles, setBidFiles] = useState<LocalFileSelection[]>([]);
  const [step, setStep] = useState<DuplicateCheckStep>('upload');
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<DuplicateAnalysisTabId>(defaultAnalysisTab);
  const [metadataAnalysis, setMetadataAnalysis] = useState<DuplicateMetadataAnalysisState | undefined>();
  const [outlineAnalysis, setOutlineAnalysis] = useState<DuplicateOutlineAnalysisState | undefined>();
  const [contentAnalysis, setContentAnalysis] = useState<DuplicateContentAnalysisState | undefined>();
  const [imageAnalysis, setImageAnalysis] = useState<DuplicateImageAnalysisState | undefined>();
  const [busy, setBusy] = useState<'tender' | 'bid' | null>(null);
  const startedMetadataSignatureRef = useRef<string | null>(null);
  const currentAnalysisSignatureRef = useRef('');
  const hydratedRef = useRef(false);
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const totalSize = useMemo(() => bidFiles.reduce((sum, file) => sum + file.size, tenderFile?.size || 0), [bidFiles, tenderFile]);
  const canGoNext = bidFiles.length > 0;
  const activeIndex = steps.indexOf(step);
  const isNextDisabled = activeIndex >= steps.length - 1 || !canGoNext;
  const nextTooltip = activeIndex >= steps.length - 1
    ? '当前已经是最后一步'
    : canGoNext
      ? `进入${stepLabels[steps[activeIndex + 1]]}`
      : '请先上传至少一份投标文件';

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.workspace.loadDuplicateCheck()
      .then((state) => {
        if (canceled || !state) return;
        setTenderFile(state.tenderFile || null);
        setBidFiles(Array.isArray(state.bidFiles) ? state.bidFiles : []);
        setStep(state.step === 'analysis' ? 'analysis' : 'upload');
        setActiveAnalysisTab(analysisTabs.some((item) => item.id === state.activeAnalysisTab) ? state.activeAnalysisTab as DuplicateAnalysisTabId : defaultAnalysisTab);
        setMetadataAnalysis(state.metadataAnalysis);
        setOutlineAnalysis(state.outlineAnalysis);
        setContentAnalysis(state.contentAnalysis);
        setImageAnalysis(state.imageAnalysis);
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

    const state: DuplicateCheckWorkspaceState = { tenderFile, bidFiles, step, activeAnalysisTab, metadataAnalysis, outlineAnalysis, contentAnalysis, imageAnalysis };
    void window.yibiao?.workspace.saveDuplicateCheck(state)
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存标书查重缓存失败', 'error');
      });
  }, [activeAnalysisTab, bidFiles, metadataAnalysis, outlineAnalysis, contentAnalysis, imageAnalysis, showToast, step, tenderFile]);

  useEffect(() => {
    const unsubscribe = window.yibiao?.duplicateCheck?.onEvent?.((event) => {
      if (!event?.duplicateCheck) return;
      const eventSignature = event.duplicateCheck.metadataAnalysis?.signature
        || event.duplicateCheck.outlineAnalysis?.signature
        || event.duplicateCheck.contentAnalysis?.signature
        || event.duplicateCheck.imageAnalysis?.signature;
      if (eventSignature && eventSignature !== currentAnalysisSignatureRef.current) return;
      event.duplicateCheck.metadataAnalysis?.contentFiles?.forEach((file) => {
        const noticeId = `content:${file.file_id}`;
        if (file.status === 'error'
          && isLibreOfficeRequiredMessage(file.error)
          && !documentParseNoticeIdsRef.current.has(noticeId)) {
          documentParseNoticeIdsRef.current.add(noticeId);
          showDocumentParseNotice(file.error);
        }
      });
      setMetadataAnalysis(event.duplicateCheck.metadataAnalysis);
      setOutlineAnalysis(event.duplicateCheck.outlineAnalysis);
      setContentAnalysis(event.duplicateCheck.contentAnalysis);
      setImageAnalysis(event.duplicateCheck.imageAnalysis);
    });
    return () => unsubscribe?.();
  }, []);

  const currentAnalysisSignature = useMemo(() => {
    const files: LocalFileSelection[] = tenderFile ? [tenderFile, ...bidFiles] : bidFiles;
    return createDuplicateCheckSignature(files);
  }, [bidFiles, tenderFile]);

  useEffect(() => {
    currentAnalysisSignatureRef.current = currentAnalysisSignature;
  }, [currentAnalysisSignature]);

  const startMetadataAnalysis = (force = false) => {
    if (!bidFiles.length) {
      showToast('请先上传至少一份投标文件', 'info');
      return;
    }
    if (force) {
      startedMetadataSignatureRef.current = null;
      setMetadataAnalysis(undefined);
      setOutlineAnalysis(undefined);
      setContentAnalysis(undefined);
      setImageAnalysis(undefined);
    }
    startedMetadataSignatureRef.current = currentAnalysisSignature;
    void window.yibiao?.duplicateCheck?.startMetadataAnalysis({ tenderFile, bidFiles, force })
      .then((analysis) => {
        if (analysis) setMetadataAnalysis(analysis);
      })
      .catch((error) => {
        startedMetadataSignatureRef.current = null;
        const message = error instanceof Error ? error.message : '启动元数据分析失败';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'error');
      });
  };

  useEffect(() => {
    if (step !== 'analysis' || !bidFiles.length) return;
    if (metadataAnalysis?.status === 'success'
      && metadataAnalysis.signature
      && outlineAnalysis?.status === 'success'
      && contentAnalysis?.status === 'success'
      && imageAnalysis?.status === 'success') return;
    if (startedMetadataSignatureRef.current === currentAnalysisSignature) return;
    startMetadataAnalysis(false);
  }, [bidFiles, contentAnalysis?.status, currentAnalysisSignature, imageAnalysis?.status, metadataAnalysis?.signature, metadataAnalysis?.status, outlineAnalysis?.status, showToast, step, tenderFile]);

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
        const message = result?.message || '未选择招标文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      setTenderFile(result.files[0]);
      setMetadataAnalysis(undefined);
      setOutlineAnalysis(undefined);
      setContentAnalysis(undefined);
      setImageAnalysis(undefined);
      startedMetadataSignatureRef.current = null;
      showToast('招标文件已加入，暂不执行解析', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择招标文件失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const uploadBidFiles = async () => {
    try {
      setBusy('bid');
      const result = await selectFiles(true);
      if (!result?.success || !result.files?.length) {
        const message = result?.message || '未选择投标文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      const exists = new Set(bidFiles.map((file) => file.file_path));
      const nextFiles = result.files.filter((file) => !exists.has(file.file_path));
      if (nextFiles.length < result.files.length) {
        showToast('已跳过重复选择的投标文件', 'info');
      }
      setBidFiles((prev) => [...prev, ...nextFiles]);
      if (nextFiles.length > 0) {
        setMetadataAnalysis(undefined);
        setOutlineAnalysis(undefined);
        setContentAnalysis(undefined);
        setImageAnalysis(undefined);
        startedMetadataSignatureRef.current = null;
        showToast('投标文件已加入，暂不执行解析', 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择投标文件失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetFiles = () => {
    setTenderFile(null);
    setBidFiles([]);
    setStep('upload');
    setActiveAnalysisTab(defaultAnalysisTab);
    setMetadataAnalysis(undefined);
    setOutlineAnalysis(undefined);
    setContentAnalysis(undefined);
    setImageAnalysis(undefined);
    startedMetadataSignatureRef.current = null;
    void window.yibiao?.workspace.clearDuplicateCheck()
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空标书查重缓存失败', 'error');
      });
    showToast('已重置上传列表', 'success');
  };

  const switchStep = (nextStep: DuplicateCheckStep) => {
    setStep(nextStep);
  };

  const goToOffset = (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (!nextStep) return;
    switchStep(nextStep);
  };

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'duplicate-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          tooltip: '清空当前标书查重流程',
          onClick: resetFiles,
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'upload' ? 'primary' : 'secondary',
          tooltip: '回到选择标书',
          onClick: () => switchStep('upload'),
        },
      ],
    },
    {
      id: 'duplicate-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: isNextDisabled,
          tooltip: nextTooltip,
          onClick: () => goToOffset(1),
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
                <span className="section-kicker">STEP 01</span>
                <h2>选择标书</h2>
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
                    <FilePill file={tenderFile} onRemove={() => {
                      setTenderFile(null);
                      setMetadataAnalysis(undefined);
                      setOutlineAnalysis(undefined);
                      setContentAnalysis(undefined);
                      setImageAnalysis(undefined);
                      startedMetadataSignatureRef.current = null;
                    }} />
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
                        <FilePill key={file.file_path} file={file} onRemove={() => {
                          setBidFiles((prev) => prev.filter((item) => item.file_path !== file.file_path));
                          setMetadataAnalysis(undefined);
                          setOutlineAnalysis(undefined);
                          setContentAnalysis(undefined);
                          setImageAnalysis(undefined);
                          startedMetadataSignatureRef.current = null;
                        }} />
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
        <DuplicateAnalysisPane activeTab={activeAnalysisTab} onTabChange={setActiveAnalysisTab} metadataAnalysis={metadataAnalysis} outlineAnalysis={outlineAnalysis} contentAnalysis={contentAnalysis} imageAnalysis={imageAnalysis} bidFiles={bidFiles} onRerun={() => startMetadataAnalysis(true)} />
      )}

      <FloatingToolbar groups={toolbarGroups} label="标书查重工具条" />
    </div>
  );
}

export default DuplicateCheckPage;
