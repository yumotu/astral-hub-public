import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api } from '../web/src/data.ts';
test('file reads distinguish deadline, user cancellation and invalid responses even after receiving headers, without retry', async (t) => {
  const requests = new Map();
  const timers = new Set();
  const server = createServer((req, res) => {
    requests.set(req.url, (requests.get(req.url) || 0) + 1);
    if (req.url.endsWith('/invalid')) {
      res.end('not-json');
      return;
    }
    if (req.url.endsWith('/body')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end('{"ok":true}');
    }, 600);
    timers.add(timer);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const settings = {
    url: `http://127.0.0.1:${server.address().port}`,
    token: 'synthetic-token',
    model: 'deepseek-flash',
  };
  for (const path of ['/headers', '/body'])
    await assert.rejects(
      api(settings, path, undefined, undefined, false, { timeout: 200 }),
      /请求超时/,
    );
  const controller = new AbortController();
  const pending = api(settings, '/cancel/body', undefined, undefined, false, {
    signal: controller.signal,
    timeout: 1000,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(api(settings, '/invalid'), /响应格式不正确/);
  // Under CPU load a cancellation can win before the request reaches the server.
  // Each individual operation must still issue at most one request, never a retry.
  for (const path of ['/api/headers', '/api/body', '/api/cancel/body', '/api/invalid'])
    assert.ok((requests.get(path) || 0) <= 1, `${path} was retried`);
  assert.equal(requests.get('/api/invalid'), 1);
});
