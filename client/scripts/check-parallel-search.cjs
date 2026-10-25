const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');
const { PARALLEL_MCP_URL, PARALLEL_USER_AGENT, PARALLEL_TOOL_NAMES } = require('../electron/services/pi/piParallelSearchTools.cjs');

// 用确定性本地模型响应驱动真实 Pi 循环；MCP 调用和原生文件写入均真实执行。
async function main() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), '易标-Parallel-'));
  const observed = [];
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(PARALLEL_MCP_URL)) {
      assert.equal(String(url), PARALLEL_MCP_URL);
      const headers = new Headers(options.headers);
      assert.equal(headers.get('User-Agent'), PARALLEL_USER_AGENT);
      assert.equal(headers.get('Authorization'), null);
      assert.equal(headers.get('x-api-key'), null);
      const body = options.body ? JSON.parse(options.body) : {};
      observed.push(body.method || options.method);
      const response = await fetchImpl(url, options);
      if (response.status === 429) {
        console.error(JSON.stringify({ status: 429, at: new Date().toISOString(), retry_after: response.headers.get('Retry-After') }));
      }
      return response;
    }
    return fetchImpl(url, options);
  };
  let turn = 0;
  const results = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.ok(PARALLEL_TOOL_NAMES.every(name => request.tools.some(t => t.function.name === name)));
      const last = request.messages.at(-1);
      if (last.role === 'tool' && results.length < turn) results.push(last.content);
      let call;
      if (turn === 0) call = { name: 'parallel-web-search', arguments: { objective: 'Find the official Node.js documentation', search_queries: ['Node.js official documentation'] } };
      if (turn === 1) call = { name: 'parallel-web-fetch', arguments: { urls: ['https://nodejs.org/en/about'], objective: 'What is Node.js?' } };
      if (turn === 2) {
        assert.equal(results.length, 2);
        assert.ok(results.every(r => r.length > 100 && /https?:\/\//.test(r)), `MCP results must contain useful text and source URLs: ${JSON.stringify(results.map(r => r.slice(0, 500)))}`);
        call = { name: 'write', arguments: { path: 'agent-result.md', content: results.join('\n\n') } };
      }
      const delta = call
        ? { tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
        : { content: '已保存公开来源和摘要。' };
      turn += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'fixture', model: 'default', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', model: 'default', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let session;
  try {
    const baseOptions = {
      workspaceDir,
      environment: { layout: { agentDir: path.join(workspaceDir, '.pi') }, shellPath: '/bin/sh', env: {}, instructions: '仅处理公开资料。' },
      proxyInfo: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'local-fixture', port: server.address().port },
      config: { context_length_limit: 400000 },
      timeoutMs: 60000,
    };
    const defaults = await createPiSession(baseOptions);
    assert.ok(PARALLEL_TOOL_NAMES.every(name => !defaults.session.getActiveToolNames().includes(name)));
    defaults.session.dispose();
    ({ session } = await createPiSession({ ...baseOptions, parallelSearch: true }));
    await session.prompt('搜索 Node.js 公开资料，读取官方网站简介，把来源与摘要保存为 agent-result.md。');
    assert.equal(turn, 4, `Pi 工具循环未完成：${JSON.stringify(session.messages.at(-1))}`);
    const output = fs.readFileSync(path.join(workspaceDir, 'agent-result.md'), 'utf8');
    assert.ok(output.length > 200 && /nodejs/i.test(output));
    assert.equal(observed.filter(method => method === 'tools/call').length, 2);
    assert.equal(observed.filter(method => method === 'initialize').length, 2);
    assert.equal(observed.filter(method => method === 'tools/list').length, 2);
    console.log(JSON.stringify({ success: true, output_chars: output.length, sample: output.slice(0, 800), agent_turns: turn, methods: observed, anonymous: true, user_agent: PARALLEL_USER_AGENT }));
  } finally {
    session?.dispose();
    globalThis.fetch = fetchImpl;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
