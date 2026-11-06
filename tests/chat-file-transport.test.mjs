import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { uploadChatFile, fetchChatFile } from '../web/src/chat-file-transport.ts';
import { maxFileBytes } from '../server/files.mjs';

test('browser attachment transport accepts 16/50 MiB and uses the member session for uploads and downloads', async (t) => {
  const calls = [],
    files = new Map();
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, authorization: req.headers.authorization });
    assert.equal(req.headers.authorization, 'Bearer synthetic-member-session');
    if (req.method === 'POST') {
      const parts = [];
      for await (const part of req) parts.push(part);
      const bytes = Buffer.concat(parts);
      const file = {
        id: randomUUID(),
        name: new URL(req.url, 'http://local').searchParams.get('name'),
        bytes: bytes.length,
      };
      files.set(file.id, bytes);
      res.end(JSON.stringify({ file }));
    } else {
      const bytes = files.get(req.url.split('/').at(-1));
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(bytes);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const settings = {
    url: `http://127.0.0.1:${server.address().port}`,
    model: 'deepseek-flash',
    sessionToken: 'synthetic-member-session',
    token: 'never-use-administrator-token',
  };
  for (const size of [16 * 1024 * 1024, maxFileBytes]) {
    const source = new File([new Uint8Array(size)], '中文附件.txt');
    const file = await uploadChatFile(settings, randomUUID(), source);
    assert.equal(file.bytes, size);
    const result = await fetchChatFile(settings, randomUUID(), file);
    assert.equal(result.size, size);
    files.clear();
  }
  const before = calls.length;
  await assert.rejects(
    uploadChatFile(
      settings,
      randomUUID(),
      new File([new Uint8Array(maxFileBytes + 1)], 'too-large.txt'),
    ),
    /50 MiB/,
  );
  assert.equal(calls.length, before, 'oversized files must fail before any request');
  assert.equal(calls.length, 4);
});

test('attachment failures distinguish timeout, cancellation and bad responses without replaying uploads', async (t) => {
  const requests = new Map(),
    timers = new Set();
  const server = createServer((req, res) => {
    const name = new URL(req.url, 'http://local').searchParams.get('name');
    requests.set(name, (requests.get(name) || 0) + 1);
    req.resume();
    if (name === 'denied.txt') {
      res.writeHead(403);
      res.end(JSON.stringify({ error: '此账号尚未获准上传。' }));
      return;
    }
    if (name === 'invalid.txt') {
      res.end('not-json');
      return;
    }
    if (name === 'missing-file.txt') {
      res.end('{}');
      return;
    }
    if (name === 'html-error.txt') {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
      return;
    }
    if (name === 'body.txt' || name === 'cancel.txt') {
      res.writeHead(200);
      res.flushHeaders();
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end('{}');
    }, 800);
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
    model: 'deepseek-flash',
    sessionToken: 'synthetic-member-session',
  };
  for (const name of ['headers.txt', 'body.txt'])
    await assert.rejects(
      uploadChatFile(settings, randomUUID(), new File(['x'], name), { timeout: 200 }),
      /附件上传超时/,
    );
  const controller = new AbortController();
  const pending = uploadChatFile(settings, randomUUID(), new File(['x'], 'cancel.txt'), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  for (const [name, pattern] of [
    ['denied.txt', /此账号/],
    ['invalid.txt', /响应格式不正确/],
    ['missing-file.txt', /响应格式不正确/],
    ['html-error.txt', /HTTP 502/],
  ])
    await assert.rejects(uploadChatFile(settings, randomUUID(), new File(['x'], name)), pattern);
  for (const [name, count] of requests) assert.equal(count, 1, `${name} must not be replayed`);
});
