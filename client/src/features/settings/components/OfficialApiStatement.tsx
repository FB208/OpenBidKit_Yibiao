// 展示文本和生图共用的官方 API 声明。
export default function OfficialApiStatement() {
  return (
    <div className="settings-row">
      <div className="settings-row-copy official-api-statement" style={{ gridColumn: '1 / -1' }}>
        <strong>充值即代表您认可以下协议</strong>
        <ul>
          <li>为简化操作流程，允许无账号充值（最多100元），但该模式一旦您的电脑出现故障，换设备、重装软件、清理缓存等，会导致余额无法找回，<strong>长期使用一定要绑定邮箱</strong>！</li>
          <li>官方API特色：为保证高可用，<strong>彻底解决模型报错、标书生成一半就失败的问题</strong>。官方API采用多供应商、多模型路由的模式，故成本不确定，具体费用取决于您当时被路由到的模型服务商。</li>
          <li>关于计费：我们会在您被路由到的模型<strong>成本上额外增加30%</strong>，用作服务器运维、税费、利润等。易标会甄选优质服务商，并大批量采购以拿到更优惠的成本价，可以确定的是即使增加了30%，性价比优先模式下，也<strong>比DeepSeek官网的价格更低。</strong></li>
          <li>
            模型类型：
            <ul>
              <li>性价比优先：会优选价格最低的模型，当低价模型不可用时按价格由低到高排序逐个重试</li>
              <li>高质量优先：会优选质量更高的模型，当高质量模型不可用时，按性能从高到低逐个重试</li>
            </ul>
          </li>
        </ul>
      </div>
    </div>
  );
}
