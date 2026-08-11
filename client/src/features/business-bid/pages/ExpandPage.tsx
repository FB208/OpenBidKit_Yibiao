import { useMemo } from 'react';
import { ToolbarDocumentIcon, useToast } from '../../../shared/ui';
import type { OutlineData } from '../../../shared/types';
import type { BusinessBidClauseItem, ContentGenerationSectionState, GlobalFactGroupState } from '../types';

interface ExpandPageProps {
  outlineData: OutlineData | null;
  clauseItems: BusinessBidClauseItem[];
  globalFacts: GlobalFactGroupState[];
  sections: Record<string, ContentGenerationSectionState>;
  onExport: () => void;
}

function collectLeafItems(items: OutlineData['outline']): typeof items {
  return items.flatMap((item) => (item.children?.length ? collectLeafItems(item.children) : [item]));
}

export default function ExpandPage({ outlineData, clauseItems, globalFacts, sections, onExport }: ExpandPageProps) {
  const { showToast } = useToast();
  const leaves = outlineData?.outline ? collectLeafItems(outlineData.outline) : [];
  const generatedCount = leaves.filter((item) => sections[item.id]?.status === 'success' || item.content?.trim()).length;
  const totalWords = leaves.reduce((sum, item) => sum + (sections[item.id]?.content?.length || item.content?.length || 0), 0);

  const clauseStatus = useMemo(() => {
    const counts: Record<string, number> = { 已响应: 0, 待确认: 0, 需复核: 0, 不满足: 0 };
    clauseItems.forEach((item) => { counts[item.response_status] = (counts[item.response_status] || 0) + 1; });
    return counts;
  }, [clauseItems]);

  const deviations = clauseItems.filter((item) => item.deviation && item.deviation !== '无' && item.deviation !== '无偏离' && item.deviation !== '无偏离，完全响应。');
  const needsReview = clauseItems.filter((item) => item.response_status === '需复核' || item.response_status === '不满足');
  const allGenerated = leaves.length > 0 && generatedCount === leaves.length;

  const reviewItems = [
    { label: '商务条款已解析', ok: clauseItems.length > 0, detail: `${clauseItems.length} 项条款` },
    { label: '目录已生成', ok: leaves.length > 0, detail: `${leaves.length} 个叶子小节` },
    { label: '全局事实已设定', ok: globalFacts.length > 0, detail: `${globalFacts.length} 个大项` },
    { label: '正文已生成', ok: allGenerated, detail: `${generatedCount}/${leaves.length} 章 · ${totalWords} 字` },
    { label: '无待复核/不满足条款', ok: needsReview.length === 0, detail: needsReview.length ? `${needsReview.length} 项需处理` : '全部已响应或待确认' },
  ];

  const handleExport = () => {
    if (!leaves.length) {
      showToast('请先生成目录与正文', 'info');
      return;
    }
    onExport();
  };

  return (
    <div className="plan-step-body business-review-page">
      <section className="business-review-command-bar">
        <div>
          <span className="section-kicker">STEP 06</span>
          <strong>复核与导出</strong>
          <p>导出前完成响应完整性检查，确认条款、偏离与正文均已落实，再导出商务标 Word 文档。</p>
        </div>
        <button type="button" className="primary-action" onClick={handleExport}>
          <ToolbarDocumentIcon />
          导出 Word
        </button>
      </section>

      <section className="business-review-workspace">
        <article className="business-review-checklist">
          <div className="analysis-result-head">
            <strong>导出前检查</strong>
            <span>{reviewItems.filter((item) => item.ok).length}/{reviewItems.length} 通过</span>
          </div>
          <div className="business-review-list">
            {reviewItems.map((item) => (
              <div className={`business-review-item${item.ok ? ' is-ok' : ' is-warn'}`} key={item.label}>
                <span className="business-review-dot" />
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>
        </article>

        <aside className="business-review-panels">
          <section className="business-review-clause">
            <div className="business-reference-block-head">
              <strong>响应状态概览</strong>
              <span>{clauseItems.length} 项</span>
            </div>
            <div className="business-status-chips">
              <span className="bid-clause-status is-已响应">已响应 {clauseStatus.已响应}</span>
              <span className="bid-clause-status is-待确认">待确认 {clauseStatus.待确认}</span>
              <span className="bid-clause-status is-需复核">需复核 {clauseStatus.需复核}</span>
              <span className="bid-clause-status is-不满足">不满足 {clauseStatus.不满足}</span>
            </div>
            {deviations.length > 0 && (
              <div className="business-deviation-block">
                <strong>存在偏离说明的条款（{deviations.length}）</strong>
                <ul>
                  {deviations.slice(0, 8).map((item) => (
                    <li key={item.id}><strong>{item.title}</strong><span>{item.deviation}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="business-review-export">
            <div className="business-reference-block-head">
              <strong>导出材料</strong>
              <span>Word 文档</span>
            </div>
            <p>导出将基于目录叶子小节正文（<code>outlineData.outline[*].content</code>）生成商务标 Word 文档，复用现有导出链路，并在本地将 Mermaid 图转换为图片。</p>
            <button type="button" className="primary-action business-export-cta" onClick={handleExport} disabled={!leaves.length}>
              <ToolbarDocumentIcon />
              导出商务标 Word
            </button>
          </section>
        </aside>
      </section>
    </div>
  );
}
