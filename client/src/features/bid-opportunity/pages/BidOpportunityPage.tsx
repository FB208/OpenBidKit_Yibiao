const opportunities = [
  { name: '市政管网改造工程', area: '华东', score: 92, tag: '重点跟进' },
  { name: '产业园智慧运维平台', area: '华南', score: 86, tag: '适配度高' },
  { name: '医院后勤一体化服务', area: '西南', score: 78, tag: '需评估' },
];

const signals = [
  { label: '资质匹配', value: 'A' },
  { label: '预算规模', value: '3200万' },
  { label: '截标时间', value: '12天' },
  { label: '竞争强度', value: '中' },
];

function BidOpportunityPage() {
  return (
    <div className="demo-coming-page opportunity-demo">
      <div className="feature-under-development-overlay" role="status" aria-live="polite">
        <strong>正在开发中，敬请期待</strong>
        <span>此功能尚未完成，请先不要使用。</span>
      </div>
      <section className="demo-hero-card opportunity-hero-card">
        <div className="demo-hero-copy">
          <span className="section-kicker">投标机会</span>
          <h2>从公告线索到投标决策，先把机会筛出来</h2>
          <p>计划用于聚合招标公告、匹配企业资质与历史业绩，并给出是否值得投入标书资源的初步判断。</p>
          <div className="demo-hero-actions">
            <button type="button" className="primary-action" disabled>扫描机会</button>
          </div>
        </div>
        <div className="opportunity-radar-card">
          <span>机会评分</span>
          <strong>88</strong>
          <div className="opportunity-radar-ring" aria-hidden="true">
            <i />
          </div>
          <small>综合资质、业绩、区域和交付能力</small>
        </div>
      </section>

      <div className="demo-content-grid opportunity-grid">
        <section className="demo-panel opportunity-list-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">机会列表</span>
              <h3>近期机会 Demo</h3>
            </div>
            <span className="demo-soft-pill">自动匹配预览</span>
          </div>
          <div className="opportunity-card-list">
            {opportunities.map((item) => (
              <article key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.area} · {item.tag}</span>
                </div>
                <em>{item.score}</em>
              </article>
            ))}
          </div>
        </section>

        <section className="demo-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">决策信号</span>
              <h3>投前判断维度</h3>
            </div>
          </div>
          <div className="demo-signal-grid">
            {signals.map((signal) => (
              <article key={signal.label}>
                <span>{signal.label}</span>
                <strong>{signal.value}</strong>
              </article>
            ))}
          </div>
        </section>

        <aside className="demo-preview-card opportunity-preview-card">
          <span className="section-kicker">跟进节奏</span>
          <h3>线索状态板</h3>
          <div className="demo-timeline">
            <span>公告入库</span>
            <span>资质初筛</span>
            <span>业绩匹配</span>
            <span>投标建议</span>
          </div>
          <p>上线后会把机会来源、关键日期、负责人和决策结论串成可追踪流程。</p>
        </aside>
      </div>
    </div>
  );
}

export default BidOpportunityPage;
