const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';
const PI_RUNTIME_ID = 'pi';

function normalizeEndpointHost(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const candidates = text.includes('://') ? [text] : [`https://${text}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {}
  }
  return text.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

// 上报最终 Agent 执行状态，不包含任务内容、路径或错误详情。
function trackAgentRuntime(app, configStore, status, meta = {}) {
  const runtimeStatus = status === 'success' ? 'success' : 'failed';
  const modelRetryCount = Math.max(0, Math.floor(Number(meta.modelRetryCount || 0) || 0));
  void Promise.resolve()
    .then(() => {
      const config = configStore.load();
      return fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: ANALYTICS_PROJECT_NAME,
          event: 'agent_runtime',
          version: typeof app?.getVersion === 'function' ? app.getVersion() : '',
          platform: process.platform,
          arch: process.arch,
          client_id: config.analytics_client_id || '',
          client_created_at: config.analytics_created_at || '',
          agent_runtime_kind: PI_RUNTIME_ID,
          agent_runtime_status: runtimeStatus,
          agent_runtime_model_retry_count: modelRetryCount,
          ai_model_provider: config.text_model_provider || '',
          ai_model_base_url: normalizeEndpointHost(config.base_url || ''),
          ai_model_name: config.model_name || '',
        }),
      });
    })
    .catch(() => undefined);
}

module.exports = {
  trackAgentRuntime,
};
