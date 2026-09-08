/**
 * 开发者测试页：版面预算驱动的正文生成验证。
 *
 * 验证链路：导出模板 → 版面度量 → 小节骨架（含图片位置和尺寸）→ AI 按配额写正文
 * → 组装受限 HTML → 渲染真实 docx → 预测分页与实际分页对照。
 *
 * 不写回技术方案状态，不触发任何正式任务，只读取投标文件里已有的小节做试验。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react';
import { aiClient } from '../../../shared/ai/aiClient';
import { useToast } from '../../../shared/ui';
import { countReadableWords } from '../../../shared/utils/wordCount';
import { parseRestrictedHtml } from '../../../shared/bodyHtml/restrictedHtml';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { OutlineItem } from '../../../shared/types/outline';
import type { DeveloperLayoutFigureResult } from '../../../shared/types/ipc';
import { FIGURE_SIZES, MAX_FIGURE_PAGE_RATIO, resolvePageMetrics } from '../../../shared/layoutBudget/pageMetrics';
import type { SkeletonPlan } from '../../../shared/layoutBudget/sectionSkeleton';
import { FIGURE_LAYOUTS, describeGapPosition, maxFiguresForChars, planSectionSkeleton, resolveFigureBudget, simulateLayout } from '../../../shared/layoutBudget/sectionSkeleton';
import { relaxOverflow, type RelaxResult } from '../../../shared/layoutBudget/overflowRelax';
import { DEFAULT_BATCH_CHARS, buildBatchUserPrompt, planBatches } from '../../../shared/layoutBudget/generationBatches';
import {
  assembleRestrictedHtml,
  buildSkeletonSystemPrompt,
  describeSkeleton,
  extractHtml,
  measureBlocks,
} from '../../../shared/layoutBudget/skeletonPrompt';

interface TestSection {
  id: string;
  title: string;
  description: string;
  path: string;
  level: number;
}

function flattenOutline(items: OutlineItem[] = [], parents: string[] = []): TestSection[] {
  return items.flatMap((item) => {
    const title = String(item.title || '').trim() || item.id;
    const path = [...parents, title];
    const isLeaf = !item.children || item.children.length === 0;
    const current: TestSection[] = isLeaf
      ? [{
        id: item.id,
        title,
        description: String(item.description || '').trim(),
        path: path.join(' / '),
        level: Math.min(6, path.length),
      }]
      : [];
    return [...current, ...flattenOutline(item.children || [], path)];
  });
}

/** 批次产出之间的分隔：受限 HTML 的块之间空一行。 */
const BLOCK_GAP = '\n\n';

const formatCm = (value: number) => `${value.toFixed(2)} cm`;
const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

function ContentLayoutBudgetTestPage() {
  const { showToast } = useToast();

  const [loadingState, setLoadingState] = useState(false);
  const [sections, setSections] = useState<TestSection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [config, setConfig] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [templateLabel, setTemplateLabel] = useState('默认导出格式');
  const [projectName, setProjectName] = useState('');
  const [projectOverview, setProjectOverview] = useState('');
  const [globalFacts, setGlobalFacts] = useState('');

  const [targetChars, setTargetChars] = useState(3000);
  const [figureCount, setFigureCount] = useState(3);
  const [withList, setWithList] = useState(true);
  const [withTable, setWithTable] = useState(true);
  const [batchChars, setBatchChars] = useState(DEFAULT_BATCH_CHARS);

  const [realFigures, setRealFigures] = useState(true);
  const [figureResults, setFigureResults] = useState<DeveloperLayoutFigureResult[]>([]);
  const [figureErrors, setFigureErrors] = useState<string[]>([]);
  const [relax, setRelax] = useState<RelaxResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [rawHtml, setRawHtml] = useState('');
  const [assembled, setAssembled] = useState('');
  const [assembleInfo, setAssembleInfo] = useState<ReturnType<typeof assembleRestrictedHtml> | null>(null);
  const [events, setEvents] = useState<string[]>([]);

  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [rendering, setRendering] = useState(false);
  const [actualPages, setActualPages] = useState<number | null>(null);

  const editorRef = useRef<DocxEditorRef | null>(null);
  const editorReadyRef = useRef(false);
  const loadedKeyRef = useRef('');

  const appendEvent = (message: string) => {
    setEvents((current) => [...current, `${new Date().toLocaleTimeString()} ${message}`]);
  };

  const metrics = useMemo(() => resolvePageMetrics(config), [config]);

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedId) || sections[0] || null,
    [sections, selectedId],
  );

  const affordableFigures = useMemo(() => maxFiguresForChars(metrics, targetChars), [metrics, targetChars]);
  const figureBudget = useMemo(() => resolveFigureBudget(metrics), [metrics]);

  const plan: SkeletonPlan | null = useMemo(() => {
    if (!selectedSection) return null;
    return planSectionSkeleton({
      metrics,
      headingLevel: selectedSection.level,
      headingText: selectedSection.title,
      targetChars,
      figureCount,
      withList,
      withTable,
    });
  }, [selectedSection, metrics, targetChars, figureCount, withList, withTable]);

  const batchPlan = useMemo(() => (plan ? planBatches(plan.blocks, batchChars) : []), [plan, batchChars]);

  const loadState = useCallback(async () => {
    setLoadingState(true);
    try {
      const bridge = window.yibiao;
      if (!bridge?.technicalPlan?.loadState) throw new Error('preload 未暴露 technicalPlan.loadState');
      const state = await bridge.technicalPlan.loadState();

      const nextSections = flattenOutline(state.outlineData?.outline || []);
      setSections(nextSections);
      setSelectedId((current) => (nextSections.some((item) => item.id === current) ? current : nextSections[0]?.id || ''));

      setProjectName(state.outlineData?.project_name || '');
      setProjectOverview(state.projectOverview || state.outlineData?.project_overview || '');
      setGlobalFacts(
        (state.globalFacts || [])
          .map((group) => `【${group.title}】\n${group.content}`)
          .join('\n\n'),
      );

      const templateId = state.exportTemplateId || '';
      if (templateId && bridge.templates?.get) {
        const record = await bridge.templates.get(templateId);
        if (record?.config) {
          setConfig(record.config);
          setTemplateLabel(`${record.template_name}（${templateId}）`);
        } else {
          setTemplateLabel(`模板 ${templateId} 已不存在，回退默认格式`);
        }
      } else {
        setTemplateLabel('技术方案未选模板，使用默认导出格式');
      }

      appendEvent(`读取到 ${nextSections.length} 个叶子小节。`);
      if (!nextSections.length) {
        showToast('当前投标文件没有可用的目录叶子节点。', 'info', { title: '没有可测试的小节' });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取技术方案状态失败', 'error', { title: '读取失败' });
    } finally {
      setLoadingState(false);
    }
  }, [showToast]);

  useEffect(() => { void loadState(); }, [loadState]);

  /**
   * 组装完先按真实内容重装一次箱：模型仍可能突破配额，
   * 这时只降级排版（换矮画框、图组减张、图文混排拆开），一个字都不改。
   */
  const applyAssembled = (info: ReturnType<typeof assembleRestrictedHtml>, html: string) => {
    const result = relaxOverflow(html, metrics);
    setRelax(result);
    setAssembled(result.html);
    setAssembleInfo(info);
    if (result.actions.length > 0) {
      appendEvent(`真实装箱发现 ${result.before.gaps.length} 处空洞，降级排版 ${result.actions.length} 次，剩余 ${result.after.gaps.length} 处。`);
      result.actions.forEach((action) => appendEvent(`  ${action}`));
    } else {
      appendEvent(`真实装箱：${result.after.pageCount} 页，空洞 ${result.after.gaps.length} 处，无需降级。`);
    }
  };

  const runGeneration = async () => {
    if (!plan || !selectedSection) return;
    setGenerating(true);
    setRawHtml('');
    setAssembled('');
    setAssembleInfo(null);
    setFigureResults([]);
    setFigureErrors([]);
    setRelax(null);
    setPreviewBytes(null);
    setActualPages(null);
    const batches = planBatches(plan.blocks, batchChars);
    appendEvent(
      `按骨架生成正文：${plan.blocks.length} 块，计划 ${plan.plannedChars} 字，`
      + `预测 ${plan.simulation.pageCount} 页，分 ${batches.length} 批生成。`,
    );

    try {
      const context = {
        projectName,
        projectOverview,
        sectionPath: selectedSection.path,
        sectionTitle: selectedSection.title,
        sectionDescription: selectedSection.description,
        globalFacts,
      };

      // 串行：每批都要接着上一批的原文往下写，不能并发。
      const pieces: string[] = [];
      for (const batch of batches) {
        appendEvent(`第 ${batch.index + 1}/${batches.length} 批：${batch.blocks.length} 块，约 ${batch.chars} 字…`);
        const reply = await aiClient.chat({
          messages: [
            { role: 'system', content: buildSkeletonSystemPrompt() },
            {
              role: 'user',
              content: buildBatchUserPrompt({
                plan,
                context,
                batches,
                batch,
                generatedHtml: pieces.join(BLOCK_GAP),
              }),
            },
          ],
          logTitle: `开发者测试-版面预算正文生成-第${batch.index + 1}批`,
        });
        const piece = extractHtml(reply);
        pieces.push(piece);
        appendEvent(`第 ${batch.index + 1} 批完成，产出 ${countReadableWords(piece)} 字。`);
      }
      const answer = pieces.join(BLOCK_GAP);
      setRawHtml(answer);
      const drafted = assembleRestrictedHtml(answer, plan);
      appendEvent(`正文完成：产出 ${drafted.blockDiff.actual} 块（期望 ${drafted.blockDiff.expected}），${drafted.figures.length} 张图待生成。`);

      if (!realFigures || drafted.figures.length === 0) {
        applyAssembled(drafted, drafted.html);
        if (!realFigures) appendEvent('已关闭真实生图，使用占位图。');
        return;
      }

      // 配图提示词是模型刚写的，画框比例是版面预算定的，两边在这里汇合。
      const bridge = window.yibiao.developerLayoutFigure;
      await bridge.reset();
      const refs: Record<string, string> = {};
      const results: DeveloperLayoutFigureResult[] = [];
      const errors: string[] = [];
      for (const figure of drafted.figures) {
        appendEvent(
          `生成配图 ${figure.id}：模型选了 ${figure.generation}、${figure.size} 画框`
          + `${figure.downgraded ? `（原想要 ${figure.requestedSize}，超预算已降级）` : ''}…`,
        );
        try {
          const rendered = await bridge.render({
            id: figure.id,
            generation: figure.generation,
            prompt: figure.prompt || figure.alt || figure.caption,
            caption: figure.caption,
            aspectWidth: figure.aspectWidth,
            aspectHeight: figure.aspectHeight,
          });
          refs[figure.id] = rendered.assetRef;
          results.push(rendered);
          appendEvent(`配图 ${figure.id} 完成：${rendered.width}×${rendered.height}px，用时 ${(rendered.elapsedMs / 1000).toFixed(1)}s。`);
        } catch (error) {
          const message = error instanceof Error ? error.message : '配图生成失败';
          errors.push(`${figure.id}：${message}`);
          appendEvent(`配图 ${figure.id} 失败，退回占位图：${message}`);
        }
      }
      setFigureResults(results);
      setFigureErrors(errors);

      const final = assembleRestrictedHtml(answer, plan, refs);
      appendEvent(`组装完成：${Object.keys(refs).length}/${drafted.figures.length} 张图用真实生成的图片。`);
      applyAssembled(final, final.html);
    } catch (error) {
      appendEvent(`生成失败：${error instanceof Error ? error.message : '未知错误'}`);
      showToast(error instanceof Error ? error.message : '正文生成失败', 'error', { title: '生成失败' });
    } finally {
      setGenerating(false);
    }
  };

  const runRender = async () => {
    if (!assembled) return;
    setRendering(true);
    setActualPages(null);
    try {
      // 走开发者资源目录：真实生成的配图落在那儿，模板样张目录会被同步清理。
      const result = await window.yibiao.developerLayoutFigure.renderPreview(assembled, { ...config, template_name: '' });
      setPreviewBytes(new Uint8Array(result.bytes));
      setPreviewKey(result.key);
      appendEvent('已渲染成 Word 文档，等待排版引擎完成分页。');
    } catch (error) {
      appendEvent(`渲染失败：${error instanceof Error ? error.message : '未知错误'}`);
      showToast(error instanceof Error ? error.message : 'Word 渲染失败', 'error', { title: '渲染失败' });
    } finally {
      setRendering(false);
    }
  };

  // 文档换了就重新加载；加载后向排版引擎问一次真实页数，用来校准度量器。
  const applyDocument = useCallback(() => {
    if (!editorReadyRef.current || !previewBytes || loadedKeyRef.current === previewKey) return;
    loadedKeyRef.current = previewKey;
    editorRef.current?.load(previewBytes);
    window.setTimeout(() => {
      try {
        const editor = editorRef.current?.getEditor?.() as { getPageGeometry?: () => unknown[] } | null;
        const pages = editor?.getPageGeometry?.() || [];
        setActualPages(pages.length);
        appendEvent(`排版引擎实际分页：${pages.length} 页。`);
      } catch {
        setActualPages(null);
      }
    }, 600);
  }, [previewBytes, previewKey]);

  useEffect(() => { applyDocument(); }, [applyDocument]);

  const blockMeasure = useMemo(() => (assembled ? measureBlocks(assembled) : []), [assembled]);

  /** 组装后先按受限 HTML 规范自检，结构错在这里就能看到，不用等 Word 渲染失败。 */
  const validation = useMemo(() => {
    if (!assembled) return null;
    const parsed = parseRestrictedHtml(assembled, { allowImageSrc: true });
    const issues = [
      ...parsed.issues,
      ...parsed.blocks.flatMap((block) => block.issues),
    ];
    return {
      errors: issues.filter((issue) => issue.level === 'error'),
      warnings: issues.filter((issue) => issue.level === 'warning'),
    };
  }, [assembled]);


  const figureRows = FIGURE_SIZES.map((size) => ({
    size,
    heightCm: metrics.figureBlockHeightCm[size],
    ratio: metrics.figurePageRatio[size],
  }));

  return (
    <div className="developer-layout-budget-page">
      <section className="panel developer-test-hero">
        <div>
          <h2>版面预算正文生成测试</h2>
          <p className="developer-test-hero-desc">
            从投标文件里取一个真实小节，按当前导出模板算出版面容量，先排骨架再让模型按配额写正文，最后渲染成 Word 对照预测分页。
          </p>
        </div>
        <div className="developer-test-actions">
          <button type="button" className="btn" onClick={() => void loadState()} disabled={loadingState}>
            {loadingState ? '读取中...' : '重新读取投标文件'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void runGeneration()} disabled={generating || !plan}>
            {generating ? '生成中...' : '按骨架生成正文'}
          </button>
          <button type="button" className="btn" onClick={() => void runRender()} disabled={rendering || !assembled}>
            {rendering ? '渲染中...' : '渲染 Word 并对照'}
          </button>
        </div>
      </section>

      <div className="developer-layout-budget-grid">
        <section className="panel developer-test-panel">
          <h3>1 · 版面度量</h3>
          <p className="developer-layout-budget-note">模板：{templateLabel}</p>
          <dl className="developer-layout-budget-metrics">
            <div><dt>正文区</dt><dd>{formatCm(metrics.contentWidthCm)} × {formatCm(metrics.contentHeightCm)}</dd></div>
            <div><dt>正文字号</dt><dd>{config.body_text.size}（{metrics.bodySizePt} pt）</dd></div>
            <div><dt>行高</dt><dd>{formatCm(metrics.lineHeightCm)}</dd></div>
            <div><dt>每行字数</dt><dd>{metrics.charsPerLine} 字</dd></div>
            <div><dt>每页行数</dt><dd>{metrics.linesPerPage} 行</dd></div>
            <div><dt>每页纯正文</dt><dd>约 {metrics.charsPerPage} 字</dd></div>
            <div><dt>一级标题分页</dt><dd>{metrics.pageBreakBeforeLevel1 ? '开启，误差不跨章累积' : '关闭'}</dd></div>
          </dl>

          <h4 className="developer-layout-budget-subtitle">图片尺寸在本模板下的实际占位</h4>
          <table className="developer-layout-budget-table">
            <thead>
              <tr><th>画框</th><th>整块高度</th><th>占一页</th><th>判定</th></tr>
            </thead>
            <tbody>
              {figureRows.map((row) => (
                <tr key={row.size} className={row.ratio > MAX_FIGURE_PAGE_RATIO ? 'is-danger' : ''}>
                  <td>{row.size}</td>
                  <td>{formatCm(row.heightCm)}</td>
                  <td>{formatPercent(row.ratio)}</td>
                  <td>{row.ratio > MAX_FIGURE_PAGE_RATIO ? '超出高度预算，模型选了会被降级' : '模型可选'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel developer-test-panel">
          <h3>2 · 小节与配额</h3>
          <label className="developer-layout-budget-field">
            <span>测试小节</span>
            <select value={selectedSection?.id || ''} onChange={(event) => setSelectedId(event.target.value)}>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>{section.id} {section.path}</option>
              ))}
            </select>
          </label>
          {selectedSection?.description && (
            <p className="developer-layout-budget-note">小节说明：{selectedSection.description}</p>
          )}
          <div className="developer-layout-budget-fields">
            <label className="developer-layout-budget-field">
              <span>目标字数</span>
              <input
                type="number"
                min={200}
                step={100}
                value={targetChars}
                onChange={(event) => setTargetChars(Math.max(200, Number(event.target.value) || 0))}
              />
            </label>
            <label className="developer-layout-budget-field">
              <span>每批字数</span>
              <input
                type="number"
                min={600}
                step={200}
                value={batchChars}
                onChange={(event) => setBatchChars(Math.max(600, Number(event.target.value) || DEFAULT_BATCH_CHARS))}
              />
            </label>
            <label className="developer-layout-budget-field">
              <span>配图块数（本节字数约支撑 {affordableFigures} 块）</span>
              <input
                type="number"
                min={0}
                value={figureCount}
                onChange={(event) => setFigureCount(Math.max(0, Number(event.target.value) || 0))}
              />
            </label>
          </div>
          <p className="developer-layout-budget-note">
            画框和生成方式都交给模型按内容定，版面只给上界：单张图不超过 {formatPercent(MAX_FIGURE_PAGE_RATIO)} 页高
            （{formatCm(figureBudget.heightCm)}），可选画框 {figureBudget.sizes.join('、')}。
            超预算的画框会被降级到最接近的可用画框。
          </p>
          <p className="developer-layout-budget-note">
            图块版式按 {FIGURE_LAYOUTS.join(' → ')} 轮转，生成方式按 mermaid → htmlImage → aiImage 轮转，
            保证一节里独立图、图文混排、并列图组和三种生成方式都能露面。
          </p>
          <div className="developer-layout-budget-checks">
            <label>
              <input type="checkbox" checked={withList} onChange={(event) => setWithList(event.target.checked)} />
              <span>正文中安排一处列表</span>
            </label>
            <label>
              <input type="checkbox" checked={withTable} onChange={(event) => setWithTable(event.target.checked)} />
              <span>按字数安排数据表格（每 1500 字一个，最多 2 个）</span>
            </label>
            <label>
              <input type="checkbox" checked={realFigures} onChange={(event) => setRealFigures(event.target.checked)} />
              <span>真实生成配图（关掉则用占位图，只验证版面）</span>
            </label>
          </div>
        </section>

        <section className="panel developer-test-panel">
          <h3>3 · 骨架与预测分页</h3>
          {plan ? (
            <>
              <p className="developer-layout-budget-note">
                共 {plan.blocks.length} 块，计划正文 {plan.plannedChars} 字，预测 {plan.simulation.pageCount} 页，
                残留空洞 {plan.simulation.gaps.length} 处，
                <strong className={plan.feasible ? '' : 'is-danger'}>{plan.feasible ? '版面可行' : '版面排不开'}</strong>。
              </p>
              {plan.advice.length > 0 && (
                <ul className="developer-layout-budget-list is-advice">
                  {plan.advice.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
              )}
              <pre className="developer-layout-budget-pre">{describeSkeleton(plan.blocks)}</pre>
              <h4 className="developer-layout-budget-subtitle">
                生成批次（{batchPlan.length} 批，避开单次输出上限）
              </h4>
              <ul className="developer-layout-budget-list">
                {batchPlan.map((batch) => (
                  <li key={batch.index}>
                    第 {batch.index + 1} 批：{batch.blocks.length} 块 / 约 {batch.chars} 字
                    {' — '}
                    {batch.blocks.map((block) => block.id).join(' ')}
                  </li>
                ))}
              </ul>

              <h4 className="developer-layout-budget-subtitle">装箱调整记录</h4>
              {plan.adjustments.length ? (
                <ul className="developer-layout-budget-list">
                  {plan.adjustments.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
              ) : (
                <p className="developer-layout-budget-note">初始排布即无空洞，未做调整。</p>
              )}
              <h4 className="developer-layout-budget-subtitle">
                {plan.simulation.columnsPerPage > 1 ? '每栏栏尾剩余' : '每页页尾剩余'}
              </h4>
              <ul className="developer-layout-budget-list">
                {plan.simulation.tailLines.map((lines, index) => (
                  <li key={index} className={index < plan.simulation.tailLines.length - 1 && lines > 2 ? 'is-danger' : ''}>
                    {describeGapPosition(
                      { page: Math.floor(index / plan.simulation.columnsPerPage), column: index },
                      plan.simulation.columnsPerPage,
                    )}
                    剩 {lines} 行（{formatCm(plan.simulation.tailCm[index])}）
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="developer-layout-budget-note">先选择一个小节。</p>
          )}
        </section>

        <section className="panel developer-test-panel">
          <h3>4 · 生成结果对照</h3>
          {assembleInfo ? (
            <>
              <p className="developer-layout-budget-note">
                块数 {assembleInfo.blockDiff.actual}/{assembleInfo.blockDiff.expected}（不含标题，标题由程序拼），
                配图 {assembleInfo.blockDiff.figureActual}/{assembleInfo.blockDiff.figureExpected}，
                正文字数 {countReadableWords(assembled)} 字。
                {assembleInfo.strippedHeadings > 0 && ` 模型多写了 ${assembleInfo.strippedHeadings} 个标题，已剥掉。`}
                {relax && `真实装箱：${relax.after.pageCount} 页，空洞 ${relax.after.gaps.length} 处`}
                {relax && relax.actions.length > 0 && `（降级前 ${relax.before.gaps.length} 处）`}
                {relax && '。'}
                {actualPages !== null && ` 排版引擎实测：${actualPages} 页。`}
              </p>
              {relax && relax.actions.length > 0 && (
                <ul className="developer-layout-budget-list is-advice">
                  {relax.actions.map((action, index) => <li key={index}>{action}</li>)}
                </ul>
              )}
              {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
                <ul className="developer-layout-budget-list is-advice">
                  {validation.errors.map((issue, index) => (
                    <li key={`e${index}`} className="is-danger">块 {issue.blockIndex + 1}：{issue.message}</li>
                  ))}
                  {validation.warnings.map((issue, index) => (
                    <li key={`w${index}`}>块 {issue.blockIndex + 1}：{issue.message}</li>
                  ))}
                </ul>
              )}
              {validation && validation.errors.length === 0 && (
                <p className="developer-layout-budget-note">受限 HTML 自检通过，结构合规。</p>
              )}
              <table className="developer-layout-budget-table">
                <thead>
                  <tr><th>块</th><th>类型</th><th>配额</th><th>实际</th><th>偏差</th></tr>
                </thead>
                <tbody>
                  {blockMeasure.map((item, index) => {
                    const spec = plan?.blocks.find(
                      (block) => (block.kind === 'paragraph' || block.kind === 'imageText') && block.id === item.id,
                    );
                    const quota = spec && (spec.kind === 'paragraph' || spec.kind === 'imageText') ? spec : null;
                    const delta = quota ? item.chars - quota.targetChars : 0;
                    const off = quota ? (item.chars < quota.minChars || item.chars > quota.maxChars) : false;
                    return (
                      <tr key={`${item.id}-${index}`} className={off ? 'is-danger' : ''}>
                        <td>{item.id || '—'}</td>
                        <td>{item.tag}</td>
                        <td>{quota ? `${quota.minChars}-${quota.maxChars}` : '—'}</td>
                        <td>{item.chars}</td>
                        <td>{quota ? (delta > 0 ? `+${delta}` : String(delta)) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <p className="developer-layout-budget-note">尚未生成正文。</p>
          )}
        </section>
      </div>

      <section className="panel developer-test-panel is-wide">
        <h3>5 · Word 渲染结果</h3>
        <p className="developer-layout-budget-note">
          {realFigures
            ? '生成方式和画框都由模型按内容选，版面只卡高度上界。流程图和信息图按真实比例放进画框、一个像素都不切，只有实景图走居中裁切。'
            : '当前用占位图。画框只是高度上界，图按真实比例放进去，图里画什么不影响分页。'}
        </p>
        {figureResults.length > 0 && (
          <table className="developer-layout-budget-table">
            <thead>
              <tr><th>图</th><th>模型选的方式</th><th>画框</th><th>适配</th><th>实际像素</th><th>用时</th></tr>
            </thead>
            <tbody>
              {figureResults.map((item) => {
                const spec = assembleInfo?.figures.find((figure) => figure.id === item.id);
                const wanted = spec ? spec.aspectWidth / spec.aspectHeight : 0;
                const actual = item.height > 0 ? item.width / item.height : 0;
                // html 图应当严丝合缝，mermaid 和 AI 图靠裁切适配，比例对不上属正常。
                const exact = spec?.generation === 'htmlImage' && actual > 0
                  && Math.abs(actual - wanted) / wanted < 0.02;
                return (
                  <tr key={item.id}>
                    <td>{item.id}</td>
                    <td>{item.generation}</td>
                    <td>
                      {spec ? spec.size : '—'}
                      {spec?.downgraded && ` ←${spec.requestedSize} 超预算`}
                    </td>
                    <td>
                      {spec?.fit === 'contain' ? '按真实比例，不裁切' : '居中裁切'}
                      {spec?.generation === 'htmlImage' && (exact ? ' ✓ 比例精确' : '')}
                    </td>
                    <td>{item.width && item.height ? `${item.width}×${item.height}` : '—'}</td>
                    <td>{(item.elapsedMs / 1000).toFixed(1)}s</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {figureErrors.length > 0 && (
          <ul className="developer-layout-budget-list">
            {figureErrors.map((line, index) => <li key={index} className="is-danger">{line}</li>)}
          </ul>
        )}
        <div className="developer-layout-budget-preview">
          <DocxEditor
            ref={editorRef}
            className="developer-layout-budget-editor"
            mode="edit"
            chrome={false}
            navigation={false}
            rulers={false}
            onReady={() => { editorReadyRef.current = true; applyDocument(); }}
          />
          {!previewBytes && <div className="developer-layout-budget-empty">生成正文后点“渲染 Word 并对照”。</div>}
        </div>
      </section>

      <div className="developer-layout-budget-grid">
        <section className="panel developer-test-panel">
          <h3>运行日志</h3>
          <pre className="developer-layout-budget-pre">{events.join('\n') || '暂无日志'}</pre>
        </section>
        <section className="panel developer-test-panel">
          <h3>组装后的受限 HTML</h3>
          <pre className="developer-layout-budget-pre">{assembled || rawHtml || '暂无输出'}</pre>
        </section>
      </div>
    </div>
  );
}

export default ContentLayoutBudgetTestPage;
