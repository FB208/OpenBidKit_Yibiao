const test = require('node:test');
const assert = require('node:assert/strict');
const { createPiParallelSearchTools, PARALLEL_MCP_URL, PARALLEL_USER_AGENT } = require('./piParallelSearchTools.cjs');

async function tools(fetchImpl, timeoutMs) {
  const { Type } = await import('typebox');
  return createPiParallelSearchTools({ Type, fetchImpl, timeoutMs });
}

function fixture({ error = false, stall = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), PARALLEL_MCP_URL);
    assert.equal(options.headers.get('User-Agent'), PARALLEL_USER_AGENT);
    assert.equal(options.headers.get('Authorization'), null);
    assert.equal(options.headers.get('x-api-key'), null);
    if (options.method === 'GET') return new Response('', { status: 405 });
    const body = JSON.parse(options.body);
    requests.push(body);
    let result;
    if (body.method === 'initialize') {
      result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    } else if (body.method === 'tools/list') {
      result = { tools: ['web_search', 'web_fetch'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    } else if (body.method === 'tools/call') {
      if (stall) return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      result = { content: [{ type: 'text', text: error ? 'fixture search failure' : 'Public source https://example.com: useful excerpt' }], isError: error };
    } else if (!body.id) {
      return new Response(null, { status: 202 });
    } else throw new Error(`Unexpected method ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { requests, fetchImpl };
}

test('search and fetch use anonymous MCP, project User-Agent and one session identity', async () => {
  const f = fixture();
  const [search, fetchTool] = await tools(f.fetchImpl);
  const args = { objective: 'Public technical reference', search_queries: ['smart campus maintenance'] };
  const searched = await search.execute('search', args);
  const fetched = await fetchTool.execute('fetch', { urls: ['https://example.com'], objective: 'maintenance guidance' });
  assert.match(searched.content[0].text, /useful excerpt/);
  assert.match(fetched.content[0].text, /https:\/\/example.com/);
  const calls = f.requests.filter(r => r.method === 'tools/call');
  assert.deepEqual(calls.map(r => r.params.name), ['web_search', 'web_fetch']);
  assert.equal(calls[0].params.arguments.session_id, calls[1].params.arguments.session_id);
  assert.deepEqual(calls[0].params.arguments.search_queries, args.search_queries);
  assert.deepEqual(calls[1].params.arguments.urls, ['https://example.com']);
  assert.equal(f.requests.filter(r => r.method === 'tools/list').length, 2);
});

test('MCP tool errors are failures, not successful text', async () => {
  const [search] = await tools(fixture({ error: true }).fetchImpl);
  await assert.rejects(search.execute('search', { objective: 'test', search_queries: ['test'] }), /fixture search failure/);
});

test('pre-cancelled calls make no request', async () => {
  const f = fixture();
  const [search] = await tools(f.fetchImpl);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(search.execute('search', {}, controller.signal), /cancelled/);
  assert.equal(f.requests.length, 0);
});

test('in-flight cancellation reaches MCP fetch', async () => {
  const [search] = await tools(fixture({ stall: true }).fetchImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancelled while searching')), 30);
  try {
    await assert.rejects(search.execute('search', { objective: 'test', search_queries: ['test'] }, controller.signal), /cancelled|abort/i);
  } finally { clearTimeout(timer); }
});

test('bounded timeout reaches MCP fetch', async () => {
  const [search] = await tools(fixture({ stall: true }).fetchImpl, 30);
  // AbortSignal.timeout does not keep Node alive on its own.
  const timer = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(search.execute('search', { objective: 'test', search_queries: ['test'] }), /timeout|timed out/i);
  } finally { clearTimeout(timer); }
});
