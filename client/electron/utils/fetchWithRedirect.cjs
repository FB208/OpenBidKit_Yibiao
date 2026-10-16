const MAX_REDIRECTS = 5;

// 手动跟随重定向并保留全部请求头；fetch 自动跟随跨域跳转会丢弃 Authorization。
// 307/308 原样重发方法和请求体；303 及 POST 的 301/302 按规范改为不带请求体的 GET。
async function fetchWithRedirect(url, init = {}, fetchImpl = fetch) {
  let currentUrl = String(url);
  let currentInit = { ...init, redirect: 'manual' };
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(currentUrl, currentInit);
    const location = response.headers.get('location');
    if (response.status < 301 || response.status > 308 || response.status === 304 || !location || redirects >= MAX_REDIRECTS) {
      return response;
    }
    const method = String(currentInit.method || 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      const { body, ...rest } = currentInit;
      currentInit = { ...rest, method: 'GET' };
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = new URL(location, currentUrl).href;
  }
}

module.exports = { fetchWithRedirect };
