const responseItems = [
  { label: '付款条件', status: '已响应', detail: '月度计量，验收后 30 日内支付' },
  { label: '履约保证金', status: '待确认', detail: '建议补充银行保函开具周期' },
  { label: '报价有效期', status: '已响应', detail: '90 日历天，满足招标文件要求' },
  { label: '偏离说明', status: '需复核', detail: '合同条款第 12.3 项存在轻微偏离' },
];

const workflowSteps = [
  { title: '导入招标文件', text: '识别商务条款、报价口径和合同约束。' },
  { title: '生成响应矩阵', text: '按条款输出响应、偏离和待补充材料。' },
  { title: '编制报价附件', text: '整理分项报价、付款节点和保函资料。' },
];

function BusinessBidPage() {
  return (
    <div className="demo-coming-page business-bid-demo">
      <div className="feature-under-development-overlay" role="status" aria-live="polite">
        <strong>正在开发中，敬请期待</strong>
        <span>此功能尚未完成，请先不要使用。</span>
      </div>
      <section className="demo-hero-card">
        <div className="demo-hero-copy">
          <span className="section-kicker">商务标</span>
          <h2>把商务响应、报价口径和合同偏离放在同一张工作台里</h2>
          <p>这里会用于梳理付款、质保、履约、报价有效期等商务条款，辅助生成响应矩阵和报价材料清单。</p>
          <div className="demo-hero-actions">
            <button type="button" className="primary-action" disabled>导入招标文件</button>
          </div>
        </div>
        <div className="demo-metric-stack" aria-label="商务标示例指标">
          <article>
            <span>条款识别</span>
            <strong>126</strong>
            <small>商务与合同条款</small>
          </article>
          <article>
            <span>待复核</span>
            <strong>8</strong>
            <small>付款、保函、偏离项</small>
          </article>
          <article>
            <span>材料包</span>
            <strong>12</strong>
            <small>报价与资信附件</small>
          </article>
        </div>
      </section>

      <div className="demo-content-grid">
        <section className="demo-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">响应流程</span>
              <h3>计划中的商务标编制路径</h3>
            </div>
            <span className="demo-soft-pill">Demo 预览</span>
          </div>
          <div className="demo-step-list">
            {workflowSteps.map((step, index) => (
              <article key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="demo-panel demo-table-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">条款矩阵</span>
              <h3>商务响应示例</h3>
            </div>
          </div>
          <div className="demo-table-list">
            {responseItems.map((item) => (
              <article key={item.label}>
                <strong>{item.label}</strong>
                <span className={`demo-status-pill ${item.status === '已响应' ? 'is-ok' : item.status === '待确认' ? 'is-warn' : 'is-danger'}`}>{item.status}</span>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <aside className="demo-preview-card">
          <span className="section-kicker">输出预览</span>
          <h3>商务标材料包</h3>
          <div className="demo-document-preview">
            <strong>商务响应表.docx</strong>
            <span>报价汇总表.xlsx</span>
            <span>合同条款偏离表.docx</span>
            <span>资信证明附件清单.pdf</span>
          </div>
          <p>功能上线后会把识别结果、人工确认项和导出材料集中管理。</p>
        </aside>
      </div>
    </div>
  );
}

export default BusinessBidPage;
