const DEFAULT_OFFICIAL_API_ORIGIN = 'https://v3.yibiao.pro';
const ACCOUNT_PATH = '/qhp-yibiao';
const MODEL_PATH = '/qhp-ai/anonymous/openai/v1';
const DEFAULT_OFFICIAL_MODEL_BASE_URL = `${DEFAULT_OFFICIAL_API_ORIGIN}${MODEL_PATH}`;

// 官方账户和模型共用域名，只有未打包的应用接受启动变量覆盖。
function resolveOfficialApiEndpoints(app) {
  const override = app.isPackaged === false ? process.env.YIBIAO_OFFICIAL_API_ORIGIN : undefined;
  let origin = DEFAULT_OFFICIAL_API_ORIGIN;
  if (override !== undefined) {
    const url = URL.parse(override);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('YIBIAO_OFFICIAL_API_ORIGIN 必须是仅包含协议和主机（可带端口）的 HTTP(S) 地址');
    }
    origin = url.origin;
  }
  return {
    accountBaseUrl: `${origin}${ACCOUNT_PATH}`,
    modelBaseUrl: `${origin}${MODEL_PATH}`,
  };
}

module.exports = { DEFAULT_OFFICIAL_MODEL_BASE_URL, resolveOfficialApiEndpoints };
