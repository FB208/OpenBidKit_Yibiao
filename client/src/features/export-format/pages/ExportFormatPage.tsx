import { useCallback, useEffect, useMemo, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { ClientConfig } from '../../../shared/types';
import type {
  ExportFormatConfig,
  NumberingFormat,
  PaperSize,
  HeadingStyleConfig,
  BodyTextStyleConfig,
  PageSetupConfig,
} from '../../../shared/types/exportFormat';
import {
  FONT_OPTIONS,
  SIZE_OPTIONS,
  ALIGNMENT_OPTIONS,
  NUMBERING_FORMATS,
  PAPER_SIZES,
  DEFAULT_EXPORT_FORMAT,
  HEADING_LEVEL_LABELS,
} from '../../../shared/types/exportFormat';
import { formatOutlineNumber } from '../../../shared/utils/outlineNumbering';

// ── 根据当前配置生成每级的编号示例 ──
function headingNumberExample(index: number, fmt: NumberingFormat): string {
  const sampleIds = ['1', '1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1', '1.1.1.1.1.1'];
  return formatOutlineNumber(sampleIds[index] || '1', fmt);
}

// ── 组件 ──────────────────────────────────────────

function ExportFormatPage() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [savedConfig, setSavedConfig] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [expandedHeadings, setExpandedHeadings] = useState<Set<number>>(new Set([0, 1]));
  const [loaded, setLoaded] = useState(false);

  // 加载配置
  useEffect(() => {
    trackPageView('export-format');
    let cancelled = false;
    (async () => {
      try {
        const clientConfig = await window.yibiao?.config.load();
        if (cancelled) return;
        const fmt = clientConfig?.export_format || DEFAULT_EXPORT_FORMAT;
        setConfig(fmt);
        setSavedConfig(fmt);
      } catch (error) {
        showToast(`加载配置失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  // 脏检测
  const isDirty = useMemo(() => {
    return JSON.stringify(config) !== JSON.stringify(savedConfig);
  }, [config, savedConfig]);

  // 页面设置更新
  const updatePage = useCallback((updates: Partial<PageSetupConfig>) => {
    setConfig(prev => ({ ...prev, page: { ...prev.page, ...updates } }));
  }, []);

  // 标题样式更新
  const updateHeading = useCallback((index: number, updates: Partial<HeadingStyleConfig>) => {
    setConfig(prev => ({
      ...prev,
      headings: prev.headings.map((h, i) => i === index ? { ...h, ...updates } : h),
    }));
  }, []);

  // 正文样式更新
  const updateBodyText = useCallback((updates: Partial<BodyTextStyleConfig>) => {
    setConfig(prev => ({ ...prev, body_text: { ...prev.body_text, ...updates } }));
  }, []);

  // 保存
  const handleSave = useCallback(async () => {
    try {
      const clientConfig: Partial<ClientConfig> = { export_format: config };
      await window.yibiao?.config.save(clientConfig as ClientConfig);
      setSavedConfig(config);
      showToast('导出格式配置已保存', 'success');
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  }, [config, showToast]);

  // 折叠控制
  const toggleHeading = useCallback((index: number) => {
    setExpandedHeadings(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // 工具条
  const toolbarGroups: FloatingToolbarGroup[] = isDirty
    ? [
        {
          id: 'export-format-save-state',
          actions: [
            { id: 'save-indicator', label: '未保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
        {
          id: 'export-format-save',
          actions: [
            { id: 'save', label: '保存配置', variant: 'primary', onClick: handleSave },
          ],
        },
      ]
    : [
        {
          id: 'export-format-saved',
          actions: [
            { id: 'saved-indicator', label: '已保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
      ];

  if (!loaded) {
    return <div className="export-format-page"><div className="export-format-loading">加载中…</div></div>;
  }

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <header className="export-format-header">
          <span className="section-kicker">导出格式</span>
          <h2>Word 文档排版与编号格式</h2>
          <p>配置导出文档的页面布局、各级标题排版参数和编号规则，配置会实时应用到标书正文预览中</p>
        </header>

        {/* ── 页面设置 ── */}
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>页面设置</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy"><strong>纸张</strong></div>
              <select value={config.page.paper_size} onChange={e => updatePage({ paper_size: e.target.value as PaperSize })}>
                {PAPER_SIZES.map(p => <option key={p.value} value={p.value}>{p.label} — {p.detail}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>方向</strong></div>
              <select value={config.page.orientation} onChange={e => updatePage({ orientation: e.target.value as 'portrait' | 'landscape' })}>
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
            </label>
            <div className="settings-row">
              <div className="settings-row-copy"><strong>页边距</strong><span>上 / 下 / 左 / 右（厘米）</span></div>
              <div className="export-format-margin-grid">
                <input type="number" min={0} max={10} step={0.1} value={config.page.margin_top_cm} onChange={e => updatePage({ margin_top_cm: Number(e.target.value) })} placeholder="上" />
                <input type="number" min={0} max={10} step={0.1} value={config.page.margin_bottom_cm} onChange={e => updatePage({ margin_bottom_cm: Number(e.target.value) })} placeholder="下" />
                <input type="number" min={0} max={10} step={0.1} value={config.page.margin_left_cm} onChange={e => updatePage({ margin_left_cm: Number(e.target.value) })} placeholder="左" />
                <input type="number" min={0} max={10} step={0.1} value={config.page.margin_right_cm} onChange={e => updatePage({ margin_right_cm: Number(e.target.value) })} placeholder="右" />
              </div>
            </div>
              <label className="settings-row">
                <div className="settings-row-copy"><strong>页脚</strong><span>距底边距离（厘米）</span></div>
                <div className="export-format-switch-row">
                  <label className="settings-switch-control">
                    <input type="checkbox" checked={config.page.footer_enabled} onChange={e => updatePage({ footer_enabled: e.target.checked })} />
                    <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
                  </label>
                  <input type="number" min={0} max={5} step={0.1} value={config.page.footer_distance_cm} disabled={!config.page.footer_enabled} onChange={e => updatePage({ footer_distance_cm: Number(e.target.value) })} style={{ width: 80 }} />
                </div>
              </label>
              <label className="settings-row">
                <div className="settings-row-copy"><strong>页码格式</strong></div>
                <div className="export-format-switch-row">
                  <label className="settings-switch-control">
                    <input type="checkbox" checked={config.page.page_number_enabled} onChange={e => updatePage({ page_number_enabled: e.target.checked })} />
                    <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
                  </label>
                  <input type="text" value={config.page.page_number_format} disabled={!config.page.page_number_enabled} onChange={e => updatePage({ page_number_format: e.target.value })} style={{ width: 140 }} />
                </div>
              </label>
              <label className="settings-row">
                <div className="settings-row-copy"><strong>页眉</strong></div>
                <label className="settings-switch-control">
                  <input type="checkbox" checked={config.page.header_enabled} onChange={e => updatePage({ header_enabled: e.target.checked })} />
                  <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
                </label>
              </label>
            </div>
          </section>

          {/* ── 各级标题格式 ── */}
          <section className="settings-page-section">
            <div className="settings-section-title">
              <span />
              <strong>各级标题格式</strong>
            </div>
            <div className="export-format-heading-list">
              {config.headings.map((heading, index) => {
                const isExpanded = expandedHeadings.has(index);
                const numExample = headingNumberExample(index, heading.numbering_format);
                return (
                  <div key={index} className={`export-format-heading-card${isExpanded ? ' is-expanded' : ''}`}>
                    <button
                      type="button"
                      className="export-format-heading-header"
                      onClick={() => toggleHeading(index)}
                    >
                      <span className="export-format-heading-label">{HEADING_LEVEL_LABELS[index]}</span>
                      <span className="export-format-heading-example">{numExample || '无编号'}</span>
                      <span className={`export-format-heading-chevron${isExpanded ? ' is-open' : ''}`}>▸</span>
                    </button>
                    {isExpanded && (
                      <div className="export-format-heading-body">
                        <div className="export-format-heading-grid">
                          <label>
                            <span>编号格式</span>
                            <select value={heading.numbering_format} onChange={e => updateHeading(index, { numbering_format: e.target.value as NumberingFormat })}>
                              {NUMBERING_FORMATS.map(nf => <option key={nf.value} value={nf.value}>{nf.label}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>字体</span>
                            <select value={heading.font} onChange={e => updateHeading(index, { font: e.target.value })}>
                              {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>字号</span>
                            <select value={heading.size} onChange={e => updateHeading(index, { size: e.target.value })}>
                              {SIZE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>对齐</span>
                            <select value={heading.alignment} onChange={e => updateHeading(index, { alignment: e.target.value })}>
                              {ALIGNMENT_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>段前（磅）</span>
                            <input type="number" min={0} max={100} step={1} value={heading.spacing_before_pt} onChange={e => updateHeading(index, { spacing_before_pt: Number(e.target.value) })} />
                          </label>
                          <label>
                            <span>段后（磅）</span>
                            <input type="number" min={0} max={100} step={1} value={heading.spacing_after_pt} onChange={e => updateHeading(index, { spacing_after_pt: Number(e.target.value) })} />
                          </label>
                          <label>
                            <span>首行缩进（字符）</span>
                            <input type="number" min={0} max={10} step={0.5} value={heading.first_line_indent_chars} onChange={e => updateHeading(index, { first_line_indent_chars: Number(e.target.value) })} />
                          </label>
                          <label>
                            <span>行距（倍）</span>
                            <input type="number" min={0.5} max={5} step={0.1} value={heading.line_spacing} onChange={e => updateHeading(index, { line_spacing: Number(e.target.value) })} />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── 正文格式 ── */}
          <section className="settings-page-section">
            <div className="settings-section-title">
              <span />
              <strong>正文格式</strong>
            </div>
            <div className="export-format-heading-grid">
              <label>
                <span>字体</span>
                <select value={config.body_text.font} onChange={e => updateBodyText({ font: e.target.value })}>
                  {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label>
                <span>字号</span>
                <select value={config.body_text.size} onChange={e => updateBodyText({ size: e.target.value })}>
                  {SIZE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label>
                <span>对齐</span>
                <select value={config.body_text.alignment} onChange={e => updateBodyText({ alignment: e.target.value })}>
                  {ALIGNMENT_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label>
                <span>段前（磅）</span>
                <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_before_pt} onChange={e => updateBodyText({ spacing_before_pt: Number(e.target.value) })} />
              </label>
              <label>
                <span>段后（磅）</span>
                <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_after_pt} onChange={e => updateBodyText({ spacing_after_pt: Number(e.target.value) })} />
              </label>
              <label>
                <span>首行缩进（字符）</span>
                <input type="number" min={0} max={10} step={0.5} value={config.body_text.first_line_indent_chars} onChange={e => updateBodyText({ first_line_indent_chars: Number(e.target.value) })} />
              </label>
              <label>
                <span>行距（倍）</span>
                <input type="number" min={0.5} max={5} step={0.1} value={config.body_text.line_spacing_multiple} onChange={e => updateBodyText({ line_spacing_multiple: Number(e.target.value) })} />
              </label>
            </div>
          </section>
        </div>
      <FloatingToolbar groups={toolbarGroups} label="导出格式保存工具条" />
    </div>
  );
}

export default ExportFormatPage;
