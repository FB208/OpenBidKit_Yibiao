import type { DocumentFormatConfig, HeadingFormatRule, PageFormatConfig } from '../../../shared/types';

interface DocumentFormatTabProps {
  documentFormat: DocumentFormatConfig;
  onChange: (value: DocumentFormatConfig) => void;
}

const headingNumberingLabels = ['第一章', '第一节', '一、', '（一）', '1、', '(1)'];

function DocumentFormatTab({ documentFormat, onChange }: DocumentFormatTabProps) {
  const { headingRules, pageFormat } = documentFormat;

  const updateHeadingRule = (level: number, partial: Partial<HeadingFormatRule>) => {
    onChange({
      ...documentFormat,
      headingRules: headingRules.map((rule) =>
        rule.level === level ? { ...rule, ...partial } : rule
      ),
    });
  };

  const updatePageFormat = (partial: Partial<PageFormatConfig>) => {
    onChange({
      ...documentFormat,
      pageFormat: { ...pageFormat, ...partial },
    });
  };

  const fontOptions = ['黑体', '宋体', '仿宋', '楷体', '微软雅黑'];
  const fontSizeOptions = [
    { label: '小二 (18pt)', value: 36 },
    { label: '三号 (16pt)', value: 32 },
    { label: '四号 (14pt)', value: 28 },
    { label: '小四 (12pt)', value: 24 },
    { label: '五号 (10.5pt)', value: 21 },
    { label: '小五 (9pt)', value: 18 },
  ];
  const alignmentOptions = [
    { label: '居中对齐', value: 'center' },
    { label: '两端对齐', value: 'justify' },
  ] as const;

  return (
    <div className="settings-tab-body document-format-tab">
      {/* 三、文档目录层级规则 */}
      <section className="settings-page-section">
        <div className="settings-section-title">
          <span />
          <strong>文档目录层级规则（标题编号规范）</strong>
        </div>
        <div className="format-section-desc">
          采用国标公文中文层级编号，编号规则如下：
        </div>
        <div className="format-numbering-table-wrap">
          <table className="format-numbering-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>编号格式</th>
                <th>示例</th>
              </tr>
            </thead>
            <tbody>
              {headingNumberingLabels.map((label, index) => (
                <tr key={index}>
                  <td>{index + 1} 级</td>
                  <td><code>{label}</code></td>
                  <td>
                    {index === 0 ? '第一章 项目概述' :
                     index === 1 ? '第一节 项目背景' :
                     index === 2 ? '一、技术方案' :
                     index === 3 ? '（一）系统架构' :
                     index === 4 ? '1、服务器选型' :
                     '(1) 详细参数说明'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 四、全文档排版参数 */}
      <section className="settings-page-section">
        <div className="settings-section-title">
          <span />
          <strong>全文档排版参数（Word 格式配置）</strong>
        </div>

        {/* 1. 页面全局设置 */}
        <div className="format-subsection">
          <h4>1. 页面全局设置</h4>
          <div className="format-grid">
            <div className="format-field">
              <label>纸张</label>
              <span className="format-value">A4 · 纵向</span>
            </div>
            <div className="format-field">
              <label>页边距（上/下/左/右）</label>
              <div className="format-row">
                <label className="format-mini-label">上</label>
                <input type="number" className="format-number" step={0.1} min={0.5} max={5}
                  value={pageFormat.marginTop} onChange={(e) => updatePageFormat({ marginTop: Number(e.target.value) })} />
                <span className="format-unit">cm</span>
                <label className="format-mini-label">下</label>
                <input type="number" className="format-number" step={0.1} min={0.5} max={5}
                  value={pageFormat.marginBottom} onChange={(e) => updatePageFormat({ marginBottom: Number(e.target.value) })} />
                <span className="format-unit">cm</span>
                <label className="format-mini-label">左</label>
                <input type="number" className="format-number" step={0.1} min={0.5} max={5}
                  value={pageFormat.marginLeft} onChange={(e) => updatePageFormat({ marginLeft: Number(e.target.value) })} />
                <span className="format-unit">cm</span>
                <label className="format-mini-label">右</label>
                <input type="number" className="format-number" step={0.1} min={0.5} max={5}
                  value={pageFormat.marginRight} onChange={(e) => updatePageFormat({ marginRight: Number(e.target.value) })} />
                <span className="format-unit">cm</span>
              </div>
            </div>
            <div className="format-field">
              <label>页眉</label>
              <span className="format-value">{pageFormat.headerEnabled ? '启用' : '关闭'}</span>
            </div>
            <div className="format-field">
              <label>页脚</label>
              <div className="format-row">
                <select className="format-select" value={pageFormat.footerEnabled ? 'on' : 'off'}
                  onChange={(e) => updatePageFormat({ footerEnabled: e.target.value === 'on' })}>
                  <option value="on">启用</option>
                  <option value="off">关闭</option>
                </select>
                {pageFormat.footerEnabled && (
                  <>
                    <label className="format-mini-label">距底边</label>
                    <input type="number" className="format-number" step={0.05} min={0.5} max={5}
                      value={pageFormat.footerMargin} onChange={(e) => updatePageFormat({ footerMargin: Number(e.target.value) })} />
                    <span className="format-unit">cm</span>
                  </>
                )}
              </div>
              {pageFormat.footerEnabled && (
                <div className="format-detail">字体：{pageFormat.footerFont} 小五 · 左对齐</div>
              )}
            </div>
            <div className="format-field">
              <label>页码</label>
              <div className="format-row">
                <select className="format-select" value={pageFormat.pageNumberEnabled ? 'on' : 'off'}
                  onChange={(e) => updatePageFormat({ pageNumberEnabled: e.target.value === 'on' })}>
                  <option value="on">启用</option>
                  <option value="off">关闭</option>
                </select>
                {pageFormat.pageNumberEnabled && (
                  <span className="format-detail-inline">页面居中 · 格式：{pageFormat.pageNumberFormat}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 2. 各级标题格式 */}
        <div className="format-subsection">
          <h4>2. 各级标题格式</h4>
          <div className="format-heading-table-wrap">
            <table className="format-heading-table">
              <thead>
                <tr>
                  <th>标题等级</th>
                  <th>字体</th>
                  <th>字号</th>
                  <th>对齐</th>
                  <th>段前 / 段后</th>
                  <th>首行缩进</th>
                  <th>行距</th>
                  <th>序号</th>
                </tr>
              </thead>
              <tbody>
                {headingRules.map((rule) => (
                  <tr key={rule.level}>
                    <td className="format-cell-label">{rule.label}</td>
                    <td>
                      <select className="format-table-select" value={rule.font}
                        onChange={(e) => updateHeadingRule(rule.level, { font: e.target.value })}>
                        {fontOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="format-table-select" value={rule.fontSize}
                        onChange={(e) => updateHeadingRule(rule.level, { fontSize: Number(e.target.value) })}>
                        {fontSizeOptions.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="format-table-select" value={rule.alignment}
                        onChange={(e) => updateHeadingRule(rule.level, { alignment: e.target.value as 'center' | 'justify' })}>
                        {alignmentOptions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                    </td>
                    <td className="format-cell-numbers">
                      <input type="number" className="format-table-num" min={0} max={60}
                        value={rule.spaceBefore} onChange={(e) => updateHeadingRule(rule.level, { spaceBefore: Number(e.target.value) })} />
                      {' / '}
                      <input type="number" className="format-table-num" min={0} max={60}
                        value={rule.spaceAfter} onChange={(e) => updateHeadingRule(rule.level, { spaceAfter: Number(e.target.value) })} />
                      <span className="format-unit">磅</span>
                    </td>
                    <td className="format-cell-numbers">
                      <input type="number" className="format-table-num" step={0.5} min={0} max={8}
                        value={rule.indent} onChange={(e) => updateHeadingRule(rule.level, { indent: Number(e.target.value) })} />
                      <span className="format-unit">字符</span>
                    </td>
                    <td className="format-cell-numbers">
                      <select className="format-table-select" value={rule.lineSpacing}
                        onChange={(e) => updateHeadingRule(rule.level, { lineSpacing: Number(e.target.value) })}>
                        <option value={1}>单倍 1 倍</option>
                        <option value={1.2}>多倍 1.2 倍</option>
                        <option value={1.5}>多倍 1.5 倍</option>
                        <option value={2}>多倍 2 倍</option>
                      </select>
                    </td>
                    <td>
                      <select className="format-table-select" value={rule.numberingEnabled ? 'on' : 'off'}
                        onChange={(e) => updateHeadingRule(rule.level, { numberingEnabled: e.target.value === 'on' })}>
                        <option value="on">开启</option>
                        <option value="off">关闭</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

export default DocumentFormatTab;
