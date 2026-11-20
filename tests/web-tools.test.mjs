import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPublicWebTools } from '../deploy/pi/web-tools.mjs';

test('public web tools can continue beyond eight calls without widening their access', async () => {
  const tools = new Map(),
    calls = [];
  await registerPublicWebTools(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    async (pi) => {
      for (const name of ['web_search', 'fetch_content', 'get_search_content', 'private_auth_tool'])
        pi.registerTool({
          name,
          execute: async (...args) => {
            calls.push({ name, args });
            return { ok: true };
          },
        });
    },
  );
  assert.deepEqual([...tools.keys()], ['web_search', 'fetch_content', 'get_search_content']);
  const signal = new AbortController().signal;
  for (let i = 0; i < 25; i++) {
    const result = await tools
      .get('web_search')
      .execute(String(i), { query: '合成测试', provider: 'other' }, signal);
    assert.deepEqual(result, { ok: true });
  }
  assert.equal(calls.length, 25);
  assert.equal(calls[24].args[1].provider, 'deepseek');
  assert.equal(calls[24].args[1].includeContent, false);
  assert.equal(calls[24].args[2], signal);
  for (const params of [
    { proxy: 'http://proxy' },
    { auth: 'secret' },
    { forceClone: true },
    { url: 'file:///etc/passwd' },
    { url: 'https://user:pass@example.com/' },
    { urls: ['https://example.com/', '/private'] },
  ])
    await assert.rejects(tools.get('fetch_content').execute('blocked', params), /仅支持|不支持/);
  assert.equal(calls.length, 25, 'blocked operations must never reach upstream');
  await tools.get('fetch_content').execute('next', { url: 'https://example.com/' }, signal);
  await tools.get('get_search_content').execute('page2', { id: 'cached-result', page: 2 }, signal);
  assert.equal(calls.length, 27);
});
