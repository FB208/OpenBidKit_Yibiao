const { randomUUID } = require('node:crypto');

const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';
const PARALLEL_USER_AGENT = 'OpenBidKit_Yibiao/0.1.0 (Parallel Search MCP)';
const PARALLEL_TOOL_NAMES = ['parallel-web-search', 'parallel-web-fetch'];

// 每个 Session 共用匿名限流标识；不读取用户或环境中的 Parallel 凭据。
function createPiParallelSearchTools({ Type, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  const sessionId = randomUUID();

  async function callTool(name, args, signal) {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    requestSignal.throwIfAborted();
    const client = new Client({ name: 'OpenBidKit_Yibiao', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
      fetch: (url, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set('User-Agent', PARALLEL_USER_AGENT);
        return fetchImpl(url, {
          ...options,
          headers,
          signal: AbortSignal.any([requestSignal, ...(options.signal ? [options.signal] : [])]),
        });
      },
    });
    try {
      await client.connect(transport);
      const options = { signal: requestSignal, timeout: timeoutMs };
      const listed = await client.listTools({}, options);
      if (!listed.tools.some(tool => tool.name === name)) throw new Error(`Parallel 未提供 ${name} 工具`);
      const result = await client.callTool({ name, arguments: { ...args, session_id: sessionId } }, undefined, options);
      const content = result.content.filter(item => item.type === 'text');
      if (result.isError) throw new Error(content.map(item => item.text).join('\n') || 'Parallel 请求失败');
      if (!content.length) throw new Error('Parallel 未返回可读内容');
      return { content, details: result.structuredContent || {} };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return [
    {
      name: PARALLEL_TOOL_NAMES[0],
      label: 'Parallel 网页搜索',
      description: '搜索公开网页，返回来源链接和摘要。先搜索，已有摘要足够时无需抓取网页。不要发送招投标文件、客户资料或其他非公开信息。',
      parameters: Type.Object({
        objective: Type.String({ description: '本次搜索的明确目标' }),
        search_queries: Type.Array(Type.String(), { minItems: 1, description: '简洁搜索词，可包含日期、站点等偏好' }),
      }),
      execute: (_id, args, signal) => callTool('web_search', args, signal),
    },
    {
      name: PARALLEL_TOOL_NAMES[1],
      label: 'Parallel 网页读取',
      description: '读取公开网页的相关摘要。仅在搜索摘要不足或任务明确要求读取指定网页时使用。不要发送非公开网址或客户资料。',
      parameters: Type.Object({
        urls: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: '公开 HTTP/HTTPS 网页地址' }),
        objective: Type.Optional(Type.String({ maxLength: 200, description: '需要从网页中获取的信息' })),
      }),
      execute: (_id, args, signal) => callTool('web_fetch', args, signal),
    },
  ];
}

module.exports = { createPiParallelSearchTools, PARALLEL_MCP_URL, PARALLEL_USER_AGENT, PARALLEL_TOOL_NAMES };
