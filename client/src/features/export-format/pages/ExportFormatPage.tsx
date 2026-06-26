import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  BodyTextStyleConfig,
  ExportFormatConfig,
  HeadingBorderConfig,
  HeadingNumberingFormat,
  HeadingStyleConfig,
  ImageStyleConfig,
  ListStyle,
  PageSetupConfig,
  PaperSize,
  TableCellStyleConfig,
  TableStyleConfig,
} from '../../../shared/types/exportFormat';
import {
  ALIGNMENT_OPTIONS,
  DEFAULT_EXPORT_FORMAT,
  FONT_OPTIONS,
  HEADING_LEVEL_LABELS,
  HEADING_NUMBERING_FORMAT_OPTIONS,
  LIST_STYLE_OPTIONS,
  PAPER_DIMENSIONS,
  PAPER_SIZES,
  SIZE_OPTIONS,
} from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { formatOutlineNumber } from '../../../shared/utils/outlineNumbering';
import type { OutlineItem, WordExportProgressEvent } from '../../../shared/types';

type TemplateTab = 'layout' | 'cover' | 'heading' | 'body' | 'table' | 'image';
type TableCellStyleKey = 'header_row' | 'first_column' | 'body_cell';

interface ExportFormatPageProps {
  mode?: 'create' | 'edit';
  templateId?: string | null;
  onBack?: () => void;
}

const templateTabs: Array<{ id: TemplateTab; label: string }> = [
  { id: 'layout', label: '布局设置' },
  { id: 'cover', label: '封皮' },
  { id: 'heading', label: '标题样式' },
  { id: 'body', label: '正文样式' },
  { id: 'table', label: '表格样式' },
  { id: 'image', label: '图片设置' },
];

interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  error?: string;
}

const initialExportProgress: ExportProgressState = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [],
  mermaidCount: 0,
};

interface PreviewViewportSize {
  width: number;
  height: number;
}

const CSS_MM_TO_PX = 96 / 25.4;

function getPreviewPaperSize(config: ExportFormatConfig) {
  const dims = PAPER_DIMENSIONS[config.page.paper_size as PaperSize] || PAPER_DIMENSIONS.a4;
  const landscape = config.page.orientation === 'landscape';

  return {
    widthPx: (landscape ? dims.height : dims.width) * CSS_MM_TO_PX,
    heightPx: (landscape ? dims.width : dims.height) * CSS_MM_TO_PX,
  };
}

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function countMermaidDiagrams(content: string) {
  const mermaidBlocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const mermaidInkImages = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return mermaidBlocks + mermaidInkImages;
}

function countOutlineMermaidDiagrams(items: OutlineItem[]) {
  return collectLeafItems(items).reduce((sum, item) => sum + countMermaidDiagrams(item.content || ''), 0);
}

function hasGeneratedContent(items: OutlineItem[]) {
  return collectLeafItems(items).some((item) => String(item.content || '').trim());
}

function mergeFontOptions(...groups: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  groups.forEach((group) => {
    group.forEach((font) => {
      const name = String(font || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      merged.push(name);
    });
  });

  return merged;
}

function collectConfigFonts(config: ExportFormatConfig): string[] {
  return [
    config.page.header_font,
    config.page.footer_font,
    ...config.headings.map((heading) => heading.font),
    config.body_text.font,
    config.table.header_row.font,
    config.table.first_column.font,
    config.table.body_cell.font,
    config.image.caption_font,
  ].filter(Boolean);
}

interface FontPickerProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

function FontPicker({ value, options, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchDirty, setSearchDirty] = useState(false);
  const filteredOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!searchDirty || !query) return options;
    return options.filter((font) => font.toLowerCase().includes(query));
  }, [options, searchDirty, value]);

  const pickFont = (font: string) => {
    onChange(font);
    setSearchDirty(false);
    setOpen(false);
  };

  return (
    <div className="font-picker" onBlur={(event) => {
      const nextFocus = event.relatedTarget;
      if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
        setOpen(false);
        setSearchDirty(false);
      }
    }}>
      <input
        className="font-picker-input"
        type="text"
        value={value}
        onFocus={() => {
          setOpen(true);
          setSearchDirty(false);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setSearchDirty(true);
        }}
        placeholder="输入或选择字体"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <div className="font-picker-menu" role="listbox">
          <div className="font-picker-summary">
            {searchDirty ? `匹配 ${filteredOptions.length} 个字体` : `共 ${options.length} 个字体，输入可搜索`}
          </div>
          {filteredOptions.length > 0 ? filteredOptions.map((font) => (
            <button
              key={font}
              type="button"
              className={`font-picker-option${font === value ? ' is-selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pickFont(font);
              }}
              role="option"
              aria-selected={font === value}
            >
              {font}
            </button>
          )) : <div className="font-picker-empty">没有匹配字体</div>}
        </div>
      )}
    </div>
  );
}

function headingNumberExample(index: number, heading: HeadingStyleConfig): string {
  const sampleIds = ['1', '1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1', '1.1.1.1.1.1'];
  return formatOutlineNumber(sampleIds[index] || '1', heading);
}

function headingPreviewTitle(config: ExportFormatConfig, level: number, id: string, title: string) {
  const heading = config.headings[level - 1];
  const prefix = formatOutlineNumber(id, heading);
  return prefix ? `${prefix} ${title}` : title;
}

function createDefaultExportFormat(): ExportFormatConfig {
  return {
    template_name: DEFAULT_EXPORT_FORMAT.template_name,
    page: { ...DEFAULT_EXPORT_FORMAT.page },
    heading_level1_page_break_before: DEFAULT_EXPORT_FORMAT.heading_level1_page_break_before,
    heading_border: { ...DEFAULT_EXPORT_FORMAT.heading_border },
    headings: DEFAULT_EXPORT_FORMAT.headings.map((heading) => ({ ...heading })),
    body_text: { ...DEFAULT_EXPORT_FORMAT.body_text },
    table: {
      border_width: DEFAULT_EXPORT_FORMAT.table.border_width,
      border_color: DEFAULT_EXPORT_FORMAT.table.border_color,
      cell_padding_pt: DEFAULT_EXPORT_FORMAT.table.cell_padding_pt,
      full_width: DEFAULT_EXPORT_FORMAT.table.full_width,
      header_row: { ...DEFAULT_EXPORT_FORMAT.table.header_row },
      first_column: { ...DEFAULT_EXPORT_FORMAT.table.first_column },
      body_cell: { ...DEFAULT_EXPORT_FORMAT.table.body_cell },
    },
    image: { ...DEFAULT_EXPORT_FORMAT.image },
  };
}

function withExportFormatDefaults(source: ExportFormatConfig): ExportFormatConfig {
  const defaults = createDefaultExportFormat();
  return {
    ...defaults,
    ...source,
    page: { ...defaults.page, ...source.page },
    heading_border: { ...defaults.heading_border, ...source.heading_border },
    headings: defaults.headings.map((heading, index) => ({ ...heading, ...(source.headings?.[index] || {}) })),
    body_text: { ...defaults.body_text, ...source.body_text },
    table: {
      ...defaults.table,
      ...source.table,
      header_row: { ...defaults.table.header_row, ...source.table?.header_row },
      first_column: { ...defaults.table.first_column, ...source.table?.first_column },
      body_cell: { ...defaults.table.body_cell, ...source.table?.body_cell },
    },
    image: { ...defaults.image, ...source.image },
  };
}

function ExportFormatPage({ mode = 'create', templateId = null, onBack }: ExportFormatPageProps) {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<TemplateTab>('layout');
  const [config, setConfig] = useState<ExportFormatConfig>(() => createDefaultExportFormat());
  const [savedConfig, setSavedConfig] = useState<ExportFormatConfig | null>(null);
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(templateId);
  const [expandedHeadings, setExpandedHeadings] = useState<Set<number>>(new Set([0, 1]));
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [previewFullscreenOpen, setPreviewFullscreenOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fonts = await window.yibiao?.systemFonts?.list?.();
        if (!cancelled && Array.isArray(fonts)) {
          setSystemFonts(fonts);
        }
      } catch (error) {
        console.warn('[export-format] 系统字体读取失败', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    trackPageView(mode === 'edit' ? 'my-templates/edit' : 'new-template');
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setLoadError('');
      try {
        if (mode === 'edit') {
          if (!templateId) {
            throw new Error('缺少要编辑的模板');
          }
          const template = await window.yibiao?.templates.get(templateId);
          if (!template) {
            throw new Error('模板不存在或已被删除');
          }
          if (cancelled) return;
          const nextConfig = withExportFormatDefaults(template.config);
          setCurrentTemplateId(template.template_id);
          setConfig(nextConfig);
          setSavedConfig(nextConfig);
          return;
        }

        const defaultConfig = createDefaultExportFormat();
        if (cancelled) return;
        setCurrentTemplateId(null);
        setConfig(defaultConfig);
        setSavedConfig(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '未知错误';
        setLoadError(message);
        showToast(`加载模板失败：${message}`, 'error');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, showToast, templateId]);

  const isDirty = useMemo(() => !savedConfig || JSON.stringify(config) !== JSON.stringify(savedConfig), [config, savedConfig]);
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(config), [config]);
  const fontOptions = useMemo(() => mergeFontOptions(FONT_OPTIONS, collectConfigFonts(config), systemFonts), [config, systemFonts]);

  const updateTemplate = useCallback((updates: Partial<ExportFormatConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const updatePage = useCallback((updates: Partial<PageSetupConfig>) => {
    setConfig((prev) => ({ ...prev, page: { ...prev.page, ...updates } }));
  }, []);

  const updateHeading = useCallback((index: number, updates: Partial<HeadingStyleConfig>) => {
    setConfig((prev) => ({
      ...prev,
      headings: prev.headings.map((heading, headingIndex) => headingIndex === index ? { ...heading, ...updates } : heading),
    }));
  }, []);

  const updateHeadingBorder = useCallback((updates: Partial<HeadingBorderConfig>) => {
    setConfig((prev) => ({
      ...prev,
      heading_border: { ...prev.heading_border, ...updates },
    }));
  }, []);

  const updateBodyText = useCallback((updates: Partial<BodyTextStyleConfig>) => {
    setConfig((prev) => ({ ...prev, body_text: { ...prev.body_text, ...updates } }));
  }, []);

  const updateTable = useCallback((updates: Partial<TableStyleConfig>) => {
    setConfig((prev) => ({ ...prev, table: { ...prev.table, ...updates } }));
  }, []);

  const updateTableCell = useCallback((cellKey: TableCellStyleKey, updates: Partial<TableCellStyleConfig>) => {
    setConfig((prev) => ({
      ...prev,
      table: {
        ...prev.table,
        [cellKey]: { ...prev.table[cellKey], ...updates },
      },
    }));
  }, []);

  const updateImage = useCallback((updates: Partial<ImageStyleConfig>) => {
    setConfig((prev) => ({ ...prev, image: { ...prev.image, ...updates } }));
  }, []);

  const handleSave = useCallback(async () => {
    const templateName = config.template_name.trim();
    if (!templateName) {
      showToast('请先填写模板名称', 'info');
      return;
    }

    try {
      const nextConfig = templateName === config.template_name ? config : { ...config, template_name: templateName };
      const template = currentTemplateId
        ? await window.yibiao?.templates.update(currentTemplateId, nextConfig)
        : await window.yibiao?.templates.create(nextConfig);
      if (!template) {
        throw new Error('模板保存失败');
      }
      setCurrentTemplateId(template.template_id);
      setConfig(template.config);
      setSavedConfig(template.config);
      showToast(currentTemplateId ? '模板已保存' : '模板已创建', 'success');
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  }, [config, currentTemplateId, showToast]);

  const handleResetDefault = useCallback(() => {
    setConfig(createDefaultExportFormat());
    showToast('已恢复默认模版设置，保存后生效', 'info');
  }, [showToast]);

  const handleExportTest = useCallback(async () => {
    let unsubscribe: (() => void) | undefined;

    try {
      const technicalPlan = await window.yibiao?.technicalPlan.loadState();
      const outlineData = technicalPlan?.outlineData;
      const outline = outlineData?.outline || [];
      if (!hasGeneratedContent(outline)) {
        showToast('无已完成标书', 'info');
        return;
      }

      const requestId = `template-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const mermaidCount = countOutlineMermaidDiagrams(outline);
      setExportProgress({
        open: true,
        running: true,
        progress: 2,
        message: mermaidCount
          ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片，可能需要稍等。`
          : '正在使用当前模板导出测试 Word。',
        warnings: [],
        mermaidCount,
      });

      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) {
          return;
        }

        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : undefined,
        }));
      });

      const result = await window.yibiao?.export.exportWord({
        requestId,
        project_name: outlineData?.project_name,
        outline,
        export_format: config,
      });
      if (result?.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }

      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result?.message || 'Word 已导出，请打开文档核对版式。',
        warnings: result?.warnings || prev.warnings,
      }));
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出测试失败';
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message,
        error: message,
      }));
      showToast(message, 'error');
    } finally {
      unsubscribe?.();
    }
  }, [config, showToast]);

  const toggleHeading = useCallback((index: number) => {
    setExpandedHeadings((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const resetToolbarGroup: FloatingToolbarGroup = {
    id: 'template-reset',
    actions: [
      { id: 'reset-default', label: '重置默认', variant: 'danger', tooltip: '恢复默认模版设置，保存后生效', onClick: handleResetDefault },
    ],
  };
  const exportTestToolbarGroup: FloatingToolbarGroup = {
    id: 'template-export-test',
    actions: [
      { id: 'export-test', label: '导出测试', variant: 'warning', disabled: exportProgress.running, onClick: () => { void handleExportTest(); } },
    ],
  };
  const previewToolbarGroup: FloatingToolbarGroup = {
    id: 'template-preview',
    actions: [
      { id: 'fullscreen-preview', label: '全屏预览', variant: 'success', tooltip: '放大右侧模板预览', onClick: () => setPreviewFullscreenOpen(true) },
    ],
  };
  const saveToolbarGroups: FloatingToolbarGroup[] = isDirty
    ? [
        {
          id: 'template-save-state',
          actions: [
            { id: 'save-indicator', label: '未保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
        {
          id: 'template-save',
          actions: [
            { id: 'save', label: '保存配置', variant: 'primary', onClick: handleSave },
          ],
        },
      ]
    : [
        {
          id: 'template-saved',
          actions: [
            { id: 'saved-indicator', label: '已保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
      ];
  const navigationToolbarGroup: FloatingToolbarGroup | null = onBack
    ? {
        id: 'template-navigation',
        actions: [
          { id: 'back', label: '返回我的模板', variant: 'secondary', onClick: onBack },
        ],
      }
    : null;
  const toolbarGroups: FloatingToolbarGroup[] = [
    ...(navigationToolbarGroup ? [navigationToolbarGroup] : []),
    previewToolbarGroup,
    resetToolbarGroup,
    exportTestToolbarGroup,
    ...saveToolbarGroups,
  ];

  const renderLayoutSettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>布局设置</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>模板名称</strong></div>
          <input type="text" value={config.template_name} onChange={(event) => updateTemplate({ template_name: event.target.value })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>纸张</strong></div>
          <select value={config.page.paper_size} onChange={(event) => updatePage({ paper_size: event.target.value as PaperSize })}>
            {PAPER_SIZES.map((paper) => <option key={paper.value} value={paper.value}>{paper.label} - {paper.detail}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>方向</strong></div>
          <select value={config.page.orientation} onChange={(event) => updatePage({ orientation: event.target.value as 'portrait' | 'landscape' })}>
            <option value="portrait">纵向</option>
            <option value="landscape">横向</option>
          </select>
        </label>
        <div className="settings-row">
          <div className="settings-row-copy"><strong>页边距</strong><span>上 / 右 / 下 / 左（厘米）</span></div>
          <div className="export-format-margin-grid">
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_top_cm} onChange={(event) => updatePage({ margin_top_cm: Number(event.target.value) })} placeholder="上" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_right_cm} onChange={(event) => updatePage({ margin_right_cm: Number(event.target.value) })} placeholder="右" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_bottom_cm} onChange={(event) => updatePage({ margin_bottom_cm: Number(event.target.value) })} placeholder="下" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_left_cm} onChange={(event) => updatePage({ margin_left_cm: Number(event.target.value) })} placeholder="左" />
          </div>
        </div>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页眉</strong></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.page.header_enabled} onChange={(event) => updatePage({ header_enabled: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
        {config.page.header_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉文本</strong></div>
              <input type="text" value={config.page.header_text} onChange={(event) => updatePage({ header_text: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉字体</strong></div>
              <FontPicker value={config.page.header_font} options={fontOptions} onChange={(font) => updatePage({ header_font: font })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉字号</strong></div>
              <select value={config.page.header_size} onChange={(event) => updatePage({ header_size: event.target.value })}>
                {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉对齐方式</strong></div>
              <select value={config.page.header_alignment} onChange={(event) => updatePage({ header_alignment: event.target.value })}>
                {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉颜色</strong></div>
              <input type="color" value={config.page.header_color} onChange={(event) => updatePage({ header_color: event.target.value })} />
            </label>
          </>
        )}
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页脚</strong></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.page.footer_enabled} onChange={(event) => updatePage({ footer_enabled: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
        {config.page.footer_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚文本</strong></div>
              <input type="text" value={config.page.footer_text} onChange={(event) => updatePage({ footer_text: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚字体</strong></div>
              <FontPicker value={config.page.footer_font} options={fontOptions} onChange={(font) => updatePage({ footer_font: font })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚字号</strong></div>
              <select value={config.page.footer_size} onChange={(event) => updatePage({ footer_size: event.target.value })}>
                {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚对齐方式</strong></div>
              <select value={config.page.footer_alignment} onChange={(event) => updatePage({ footer_alignment: event.target.value })}>
                {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚颜色</strong></div>
              <input type="color" value={config.page.footer_color} onChange={(event) => updatePage({ footer_color: event.target.value })} />
            </label>
          </>
        )}
        {(config.page.footer_enabled || config.page.page_number_enabled) && (
          <label className="settings-row">
            <div className="settings-row-copy"><strong>距底边距离</strong><span>页脚或页码距页面底边，单位：厘米</span></div>
            <input type="number" min={0} max={5} step={0.1} value={config.page.footer_distance_cm} onChange={(event) => updatePage({ footer_distance_cm: Number(event.target.value) })} />
          </label>
        )}
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页码</strong><span>是否启用页码显示</span></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.page.page_number_enabled} onChange={(event) => updatePage({ page_number_enabled: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
        {config.page.page_number_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页码格式</strong><span>使用 {'{page}'} 表示当前页码</span></div>
              <input type="text" value={config.page.page_number_format} onChange={(event) => updatePage({ page_number_format: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页码起始值</strong></div>
              <input type="number" min={1} max={9999} step={1} value={config.page.page_number_start} onChange={(event) => updatePage({ page_number_start: Number(event.target.value) })} />
            </label>
          </>
        )}
      </div>
    </>
  );

  const renderHeadingSettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>标题样式</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>一级标题另起页</strong></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.heading_level1_page_break_before} onChange={(event) => updateTemplate({ heading_level1_page_break_before: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>章节页框</strong><span>为页面和章节标题生成统一的框线版式</span></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.heading_border.enabled} onChange={(event) => updateHeadingBorder({ enabled: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
        {config.heading_border.enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页框颜色</strong></div>
              <input type="color" value={config.heading_border.border_color} onChange={(event) => updateHeadingBorder({ border_color: event.target.value })} />
            </label>
          </>
        )}
      </div>
      <div className="export-format-heading-list">
        {config.headings.map((heading, index) => {
          const isExpanded = expandedHeadings.has(index);
          const numExample = headingNumberExample(index, heading);
          return (
            <div key={index} className={`export-format-heading-card${isExpanded ? ' is-expanded' : ''}`}>
              <button type="button" className="export-format-heading-header" onClick={() => toggleHeading(index)}>
                <span className="export-format-heading-label">{HEADING_LEVEL_LABELS[index]}</span>
                <span className="export-format-heading-example">{numExample || '无编号'}</span>
                <span className={`export-format-heading-chevron${isExpanded ? ' is-open' : ''}`}>▸</span>
              </button>
              {isExpanded && (
                <div className="export-format-heading-body">
                  <div className="export-format-heading-grid">
                    <label>
                      <span>编号格式</span>
                      <select value={heading.numbering_format} onChange={(event) => updateHeading(index, { numbering_format: event.target.value as HeadingNumberingFormat })}>
                        {HEADING_NUMBERING_FORMAT_OPTIONS.map((numberingFormat) => <option key={numberingFormat.value} value={numberingFormat.value}>{numberingFormat.label}</option>)}
                      </select>
                    </label>
                    {heading.numbering_format === 'custom' && (
                      <label>
                        <span>自定义格式（{'{zh}'}=中文序号，{'{num}'}=数字序号）</span>
                        <input
                          type="text"
                          value={heading.numbering_template}
                          placeholder="例如：第{zh}章、第{num}章"
                          onChange={(event) => updateHeading(index, { numbering_template: event.target.value })}
                        />
                      </label>
                    )}
                    <label>
                      <span>字体</span>
                      <FontPicker value={heading.font} options={fontOptions} onChange={(font) => updateHeading(index, { font })} />
                    </label>
                    <label>
                      <span>字号</span>
                      <select value={heading.size} onChange={(event) => updateHeading(index, { size: event.target.value })}>
                        {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>对齐</span>
                      <select value={heading.alignment} onChange={(event) => updateHeading(index, { alignment: event.target.value })}>
                        {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
                      </select>
                    </label>
                    <label className="export-format-heading-switch">
                      <span>加粗</span>
                      <label className="settings-switch-control">
                        <input type="checkbox" checked={heading.bold} onChange={(event) => updateHeading(index, { bold: event.target.checked })} />
                        <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
                      </label>
                    </label>
                    <label>
                      <span>文字颜色</span>
                      <input type="color" value={heading.text_color} onChange={(event) => updateHeading(index, { text_color: event.target.value })} />
                    </label>
                    <label>
                      <span>段前（磅）</span>
                      <input type="number" min={0} max={100} step={1} value={heading.spacing_before_pt} onChange={(event) => updateHeading(index, { spacing_before_pt: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>段后（磅）</span>
                      <input type="number" min={0} max={100} step={1} value={heading.spacing_after_pt} onChange={(event) => updateHeading(index, { spacing_after_pt: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>缩进（字符）</span>
                      <input type="number" min={0} max={10} step={0.5} value={heading.first_line_indent_chars} onChange={(event) => updateHeading(index, { first_line_indent_chars: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>行距（倍）</span>
                      <input type="number" min={0.5} max={5} step={0.1} value={heading.line_spacing} onChange={(event) => updateHeading(index, { line_spacing: Number(event.target.value) })} />
                    </label>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  const renderBodySettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>正文样式</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>字体</strong><span>支持输入搜索系统字体，常用字体已置顶。</span></div>
          <FontPicker value={config.body_text.font} options={fontOptions} onChange={(font) => updateBodyText({ font })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>字号</strong></div>
          <select value={config.body_text.size} onChange={(event) => updateBodyText({ size: event.target.value })}>
            {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>对齐</strong></div>
          <select value={config.body_text.alignment} onChange={(event) => updateBodyText({ alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>段前（磅）</strong></div>
          <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_before_pt} onChange={(event) => updateBodyText({ spacing_before_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>段后（磅）</strong></div>
          <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_after_pt} onChange={(event) => updateBodyText({ spacing_after_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>首行缩进（字符）</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.body_text.first_line_indent_chars} onChange={(event) => updateBodyText({ first_line_indent_chars: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>行间距（倍）</strong></div>
          <input type="number" min={0.5} max={5} step={0.1} value={config.body_text.line_spacing_multiple} onChange={(event) => updateBodyText({ line_spacing_multiple: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>列表符号</strong><span>Markdown “- 内容”的无序列表</span></div>
          <select value={config.body_text.list_style} onChange={(event) => updateBodyText({ list_style: event.target.value as ListStyle })}>
            {LIST_STYLE_OPTIONS.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>列表缩进（字符）</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.body_text.list_indent_chars} onChange={(event) => updateBodyText({ list_indent_chars: Number(event.target.value) })} />
        </label>
      </div>
    </>
  );

  const renderTableCellSettings = (title: string, cellKey: TableCellStyleKey) => {
    const cell = config.table[cellKey];
    return (
      <div className="export-template-subsection">
        <strong>{title}</strong>
        <div className="export-format-heading-grid">
          <label>
            <span>字体</span>
            <FontPicker value={cell.font} options={fontOptions} onChange={(font) => updateTableCell(cellKey, { font })} />
          </label>
          <label>
            <span>字号</span>
            <select value={cell.size} onChange={(event) => updateTableCell(cellKey, { size: event.target.value })}>
              {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label>
            <span>对齐方式</span>
            <select value={cell.alignment} onChange={(event) => updateTableCell(cellKey, { alignment: event.target.value })}>
              {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
            </select>
          </label>
          <label>
            <span>文字颜色</span>
            <input type="color" value={cell.text_color} onChange={(event) => updateTableCell(cellKey, { text_color: event.target.value })} />
          </label>
          <label>
            <span>背景色</span>
            <input type="color" value={cell.background_color} onChange={(event) => updateTableCell(cellKey, { background_color: event.target.value })} />
          </label>
        </div>
      </div>
    );
  };

  const renderTableSettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>表格样式</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>线框宽度</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.table.border_width} onChange={(event) => updateTable({ border_width: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>线框颜色</strong></div>
          <input type="color" value={config.table.border_color} onChange={(event) => updateTable({ border_color: event.target.value })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>单元格内边距</strong></div>
          <input type="number" min={0} max={50} step={1} value={config.table.cell_padding_pt} onChange={(event) => updateTable({ cell_padding_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>表格铺满页面</strong></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.table.full_width} onChange={(event) => updateTable({ full_width: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
      </div>
      {renderTableCellSettings('首行', 'header_row')}
      {renderTableCellSettings('首列', 'first_column')}
      {renderTableCellSettings('其余单元格', 'body_cell')}
    </>
  );

  const renderImageSettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>图片设置</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图片最大宽度（%）</strong></div>
          <input type="number" min={10} max={100} step={1} value={config.image.max_width_percent} onChange={(event) => updateImage({ max_width_percent: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图片对齐方式</strong></div>
          <select value={config.image.alignment} onChange={(event) => updateImage({ alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题字体</strong></div>
          <FontPicker value={config.image.caption_font} options={fontOptions} onChange={(font) => updateImage({ caption_font: font })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题字号</strong></div>
          <select value={config.image.caption_size} onChange={(event) => updateImage({ caption_size: event.target.value })}>
            {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题对齐方式</strong></div>
          <select value={config.image.caption_alignment} onChange={(event) => updateImage({ caption_alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
      </div>
    </>
  );

  const renderCoverSettings = () => (
    <>
      <div className="settings-section-title">
        <span />
        <strong>封皮</strong>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>首页不同</strong><span>勾选后首页使用独立页眉页脚，适合封皮不显示页码。</span></div>
          <label className="settings-switch-control">
            <input type="checkbox" checked={config.page.first_page_different} onChange={(event) => updatePage({ first_page_different: event.target.checked })} />
            <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-thumb" /></span>
          </label>
        </label>
      </div>
    </>
  );

  const renderActiveSettings = () => {
    if (activeTab === 'layout') return renderLayoutSettings();
    if (activeTab === 'heading') return renderHeadingSettings();
    if (activeTab === 'body') return renderBodySettings();
    if (activeTab === 'table') return renderTableSettings();
    if (activeTab === 'image') return renderImageSettings();
    if (activeTab === 'cover') return renderCoverSettings();
    return null;
  };

  if (!loaded) {
    return <div className="settings-page export-template-page"><div className="settings-page-scroll"><div className="export-format-loading">加载中...</div></div></div>;
  }

  if (loadError) {
    return (
      <div className="settings-page export-template-page">
        <div className="settings-page-scroll">
          <div className="export-template-error-state">
            <strong>模板加载失败</strong>
            <span>{loadError}</span>
            {onBack ? <button type="button" className="secondary-action" onClick={onBack}>返回我的模板</button> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page export-template-page">
      <div className="settings-page-scroll export-template-scroll">
        <div className="settings-tab-shell" role="tablist" aria-label="模版设置分类">
          {templateTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="export-template-workspace">
          <section className="settings-page-section export-template-editor">
            {renderActiveSettings()}
          </section>
          <TemplatePreview config={config} previewStyle={previewStyle} />
        </div>
      </div>
      <Dialog.Root
        open={exportProgress.open}
        onOpenChange={(open) => {
          if (!open && !exportProgress.running) {
            setExportProgress(initialExportProgress);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">导出测试</span>
              <Dialog.Title>{exportProgress.running ? '正在导出测试' : exportProgress.error ? '导出失败' : '导出完成'}</Dialog.Title>
              <Dialog.Description>
                {exportProgress.mermaidCount > 0
                  ? `本次包含 ${exportProgress.mermaidCount} 张 Mermaid 图，导出时会通过 mermaid.ink 转换成 Word 图片，速度受网络影响。`
                  : '正在使用当前模板导出已生成的技术方案。'}
              </Dialog.Description>
            </div>
            <div className="export-progress-body">
              <div className="content-generation-progress-track" aria-label={`导出测试进度 ${exportProgress.progress}%`}>
                <span style={{ width: `${exportProgress.progress}%` }} />
              </div>
              <p>{exportProgress.message || '正在处理导出任务，请稍候。'}</p>
              {exportProgress.warnings.length > 0 && (
                <div className="export-warning-list">
                  <strong>需要核对</strong>
                  {exportProgress.warnings.slice(0, 4).map((warning) => <small key={warning}>{warning}</small>)}
                  {exportProgress.warnings.length > 4 && <small>还有 {exportProgress.warnings.length - 4} 条图片提示，请打开导出的 Word 核对。</small>}
                </div>
              )}
            </div>
            {!exportProgress.running && (
              <div className="content-regenerate-actions">
                <Dialog.Close className="primary-action" type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={previewFullscreenOpen} onOpenChange={setPreviewFullscreenOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="export-template-fullscreen-overlay" />
          <Dialog.Content className="export-template-fullscreen-dialog">
            <Dialog.Title className="export-template-fullscreen-title">全屏预览</Dialog.Title>
            <Dialog.Description className="export-template-fullscreen-description">当前模板的全屏排版预览。</Dialog.Description>
            <Dialog.Close className="export-template-fullscreen-close" type="button">退出全屏</Dialog.Close>
            <TemplatePreview config={config} previewStyle={previewStyle} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <FloatingToolbar groups={toolbarGroups} label="模版设置保存工具条" />
    </div>
  );
}

export function TemplatePreview({ config, previewStyle }: { config: ExportFormatConfig; previewStyle: CSSProperties }) {
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<PreviewViewportSize>({ width: 0, height: 0 });
  const paperSize = useMemo(() => getPreviewPaperSize(config), [config.page.orientation, config.page.paper_size]);
  const pageNumberText = config.page.page_number_format.replace('{page}', String(config.page.page_number_start || 1));
  const footerText = config.page.footer_enabled ? config.page.footer_text.trim() : '';
  const showFooterArea = Boolean(footerText) || config.page.page_number_enabled;
  const previewScale = useMemo(() => {
    const ratios = [1];
    if (viewportSize.width > 0 && paperSize.widthPx > 0) {
      ratios.push(viewportSize.width / paperSize.widthPx);
    }
    if (viewportSize.height > 0 && paperSize.heightPx > 0) {
      ratios.push(viewportSize.height / paperSize.heightPx);
    }

    return Math.max(0.01, Math.min(...ratios));
  }, [paperSize.heightPx, paperSize.widthPx, viewportSize.height, viewportSize.width]);
  const scaleBoxStyle = useMemo<CSSProperties>(() => ({
    width: `${paperSize.widthPx * previewScale}px`,
    height: `${paperSize.heightPx * previewScale}px`,
  }), [paperSize.heightPx, paperSize.widthPx, previewScale]);
  const paperStyle = useMemo<CSSProperties>(() => ({
    ...previewStyle,
    transform: `scale(${previewScale})`,
  }), [previewScale, previewStyle]);

  useEffect(() => {
    const node = previewStageRef.current;
    if (!node) return;

    const updateSize = (rect: DOMRectReadOnly) => {
      const nextSize = {
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      };
      setViewportSize((prev) => (
        prev.width === nextSize.width && prev.height === nextSize.height ? prev : nextSize
      ));
    };

    updateSize(node.getBoundingClientRect());
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateSize(entry.contentRect);
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  const previewBodyContent = (
    <>
      <p>本节展示模板设置在导出文档中的基础排版效果，包括页面边距、正文样式、标题层级和表格展示。</p>
      <h2>{headingPreviewTitle(config, 2, '1.1', '总体目标')}</h2>
      <p>围绕项目建设目标，结合招标文件要求，形成可执行、可检查、可交付的技术实施方案。</p>
      <h3>{headingPreviewTitle(config, 3, '1.1.1', '实施安排')}</h3>
      <p>项目团队将按阶段推进需求确认、方案设计、系统实施、联调测试和验收交付等工作。</p>
      <h4>{headingPreviewTitle(config, 4, '1.1.1.1', '需求确认')}</h4>
      <p>明确业务边界、交付范围和关键验收指标，形成统一的实施依据。</p>
      <h5>{headingPreviewTitle(config, 5, '1.1.1.1.1', '资料收集')}</h5>
      <p>整理招标文件、现状资料和接口清单，支撑后续方案细化。</p>
      <h6>{headingPreviewTitle(config, 6, '1.1.1.1.1.1', '记录归档')}</h6>
      <p>对确认过程、会议纪要和问题闭环结果进行留痕归档。</p>
      <ul>
        <li>建立项目启动、过程检查和验收交付的闭环机制。</li>
        <li>按周同步风险、进度和资源需求，确保实施节奏可控。</li>
        <li>保留关键过程记录，便于后续审查和复盘。</li>
      </ul>
      <figure className="export-template-image-figure">
        <div className="export-template-image-placeholder">图片预览</div>
        <figcaption>图 1 项目实施流程示意</figcaption>
      </figure>
      <table>
        <thead>
          <tr>
            <th>阶段</th>
            <th>内容</th>
            <th>输出</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>准备</td>
            <td>资料梳理与计划确认</td>
            <td>实施计划</td>
          </tr>
          <tr>
            <td>执行</td>
            <td>方案落地与质量检查</td>
            <td>交付成果</td>
          </tr>
        </tbody>
      </table>
    </>
  );
  const renderPreviewHeadingRow = (level: 1 | 2 | 3 | 4 | 5 | 6, id: string, title: string) => {
    const HeadingTag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    return (
      <div className={`export-template-chapter-heading-row is-level-${level}`}>
        <HeadingTag>{headingPreviewTitle(config, level, id, title)}</HeadingTag>
      </div>
    );
  };
  const previewFrameContent = (
    <section className="export-template-chapter-frame">
      {renderPreviewHeadingRow(1, '1', '项目实施方案')}
      <div className="export-template-chapter-content-row">
        <p>本节展示模板设置在导出文档中的基础排版效果，包括页面边距、正文样式、标题层级和表格展示。</p>
      </div>
      {renderPreviewHeadingRow(2, '1.1', '总体目标')}
      <div className="export-template-chapter-content-row">
        <p>围绕项目建设目标，结合招标文件要求，形成可执行、可检查、可交付的技术实施方案。</p>
      </div>
      {renderPreviewHeadingRow(3, '1.1.1', '实施安排')}
      <div className="export-template-chapter-content-row">
        <p>项目团队将按阶段推进需求确认、方案设计、系统实施、联调测试和验收交付等工作。</p>
      </div>
      {renderPreviewHeadingRow(4, '1.1.1.1', '需求确认')}
      <div className="export-template-chapter-content-row">
        <p>明确业务边界、交付范围和关键验收指标，形成统一的实施依据。</p>
      </div>
      {renderPreviewHeadingRow(5, '1.1.1.1.1', '资料收集')}
      <div className="export-template-chapter-content-row">
        <p>整理招标文件、现状资料和接口清单，支撑后续方案细化。</p>
      </div>
      {renderPreviewHeadingRow(6, '1.1.1.1.1.1', '记录归档')}
      <div className="export-template-chapter-content-row">
        <p>对确认过程、会议纪要和问题闭环结果进行留痕归档。</p>
        <ul>
          <li>建立项目启动、过程检查和验收交付的闭环机制。</li>
          <li>按周同步风险、进度和资源需求，确保实施节奏可控。</li>
          <li>保留关键过程记录，便于后续审查和复盘。</li>
        </ul>
        <figure className="export-template-image-figure">
          <div className="export-template-image-placeholder">图片预览</div>
          <figcaption>图 1 项目实施流程示意</figcaption>
        </figure>
        <table>
          <thead>
            <tr>
              <th>阶段</th>
              <th>内容</th>
              <th>输出</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>准备</td>
              <td>资料梳理与计划确认</td>
              <td>实施计划</td>
            </tr>
            <tr>
              <td>执行</td>
              <td>方案落地与质量检查</td>
              <td>交付成果</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <aside className="settings-page-section export-template-preview-panel" aria-label="模板预览">
      <div className="export-template-preview-scroll" ref={previewStageRef}>
        <div className="export-template-preview-scale-box" style={scaleBoxStyle}>
          <div className="export-format-paper export-format-preview-content export-template-preview-paper" style={paperStyle}>
            {config.page.header_enabled && (
              <div className="export-template-page-header">
                {config.page.header_text || config.template_name || '页眉示例'}
              </div>
            )}
            {config.heading_border.enabled ? previewFrameContent : (
              <>
                <h1>{headingPreviewTitle(config, 1, '1', '项目实施方案')}</h1>
                {previewBodyContent}
              </>
            )}
            {showFooterArea && (
              <div className="export-template-page-footer" style={config.page.footer_enabled ? undefined : { textAlign: 'center' }}>
                {footerText && <span>{footerText}</span>}
                {config.page.page_number_enabled && <span>{pageNumberText}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

export default ExportFormatPage;
