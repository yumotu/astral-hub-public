import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { deck, readingSchema, pluginSchema } from '../shared/deck.mjs';
import { createApp } from '../server/index.mjs';
import { interpret, completion } from '../shared/ai.mjs';
import { interpretOnDevice, runPluginOnDevice } from '../web/src/ai.ts';
import * as clientAI from '../web/src/ai.ts';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import example from '../server/plugins/journal.example.json' with { type: 'json' };
import {
  localDraw,
  mergeEntries,
  syncSettings,
  persistSettings,
  loadSettings,
} from '../web/src/data.ts';
const token = 'test-device-token-123456789012345678901234567890';
const analysis = {
  summary: '试着关注你能影响的小事。',
  cards: [{ title: '此刻的指引', text: '先安排一段安静的时间。' }],
  advice: ['写下今天可以推进的一件小事。'],
};
test('PDF preview workers are served with JavaScript MIME under nosniff and worker CSP', async (t) => {
  const root = new URL('../dist/', import.meta.url);
  await mkdir(root, { recursive: true });
  const name = 'mime-check-' + randomUUID() + '.mjs';
  await writeFile(new URL(name, root), 'export const worker = true;');
  t.after(() => unlink(new URL(name, root)));
  const { url } = await fixture(t);
  const response = await fetch(url + '/' + name);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/javascript');
  assert.match(response.headers.get('content-security-policy'), /worker-src 'self' blob:/);
});
test('malformed HTTP request targets return 400 and leave the server healthy', async (t) => {
  const { url } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { path: '//', method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(url + '/api/health')).status, 200);
});
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-test-'));
  const app = await createApp({ token, dataDir: dir, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, body, extra = {}) {
    const r = await fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extra.headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...extra,
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  }
  return { ...app, url, request, dir };
}
test('78 unique cards and local draws preserve spread and uniqueness', () => {
  assert.equal(deck.length, 78);
  assert.equal(new Set(deck.map((c) => c.id)).size, 78);
  for (let i = 0; i < 150; i++) {
    const r = localDraw('今天适合关注什么？', 'three');
    assert.equal(r.cards.length, 3);
    assert.equal(new Set(r.cards.map((c) => c.id)).size, 3);
    assert.equal(readingSchema.safeParse(r).success, true);
  }
});
test('sync server requires a token and provides no draw, inference, or plugin execution routes', async (t) => {
  const { url, request } = await fixture(t);
  assert.equal((await fetch(url + '/api/health')).status, 200);
  assert.equal((await fetch(url + '/api/status')).status, 401);
  const state = (await request('/api/status')).body;
  assert.equal(state.syncReady, true);
  assert.equal(state.aiRequests, 'client-direct');
  assert.equal(state.chatSync, true);
  assert.equal('model' in state, false);
  assert.equal('apiKey' in state, false);
  for (const path of ['/api/tarot/draw', '/api/tarot/interpret', '/api/plugins/run'])
    assert.equal((await request(path, {})).status, 404);
});
test('device DeepSeek requests go directly to the provider, with no sync server request', async (t) => {
  const calls = [];
  const settings = {
    url: 'https://sync.example.com',
    token: 'sync-token',
    autoSync: false,
    remember: false,
    apiKey: 'mock-device-api-key',
    model: 'deepseek-flash',
    rememberKey: false,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer mock-device-api-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.thinking.type, 'disabled');
    assert.equal(JSON.stringify(payload).includes('sync-token'), false);
    if (payload.response_format)
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }],
      });
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '把今天的一件小事写下来。' } }],
    });
  });
  const r = localDraw('如何整理工作？', 'single');
  const result = await interpretOnDevice(settings, r);
  assert.equal(result.source, 'deepseek');
  assert.deepEqual(result.cards, r.cards);
  assert.deepEqual(result.analysis, analysis);
  assert.equal(result.model, settings.model);
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
  assert.match(await runPluginOnDevice(settings, example, '我今天有点紧张'), /小事/);
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((url) => url.includes('sync.example')),
    false,
  );
});
test('configured server performs authenticated inference without exposing the provider key', async (t) => {
  let calls = 0;
  const { request, url } = await fixture(t, {
    aiConfig: {
      apiKey: 'mock-server-secret',
      model: 'deepseek-flash',
      fetch: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer mock-server-secret');
        const payload = JSON.parse(options.body);
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: payload.response_format
                  ? JSON.stringify(analysis)
                  : '先记录今天的一件小事。',
              },
            },
          ],
        });
      },
    },
  });
  const state = (await request('/api/status')).body;
  assert.equal(state.aiConfigured, true);
  assert.equal(state.aiRequests, 'server');
  assert.equal(JSON.stringify(state).includes('mock-server-secret'), false);
  const reading = localDraw('今天关注什么？', 'single');
  const result = await request('/api/tarot/interpret', reading);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.analysis, analysis);
  assert.equal(result.body.source, 'deepseek');
  assert.equal(JSON.stringify(result.body).includes('mock-server-secret'), false);
  assert.equal((await fetch(url + '/api/tarot/interpret', { method: 'POST' })).status, 401);
  assert.equal(
    (await request('/api/tarot/interpret', { ...reading, apiKey: 'untrusted' })).status,
    400,
  );
  assert.equal(
    (await request('/api/plugins/run', { plugin: example, input: '今天的想法' })).status,
    200,
  );
  await request('/api/plugins', example);
  assert.equal(
    (await request('/api/plugins/run', { pluginId: example.id, input: '旧版客户端' })).status,
    200,
  );
  assert.equal(calls, 3);
});
test('server AI limits calls and releases capacity after provider errors', async (t) => {
  let calls = 0;
  const { request } = await fixture(t, {
    aiLimits: { perMinute: 2, concurrent: 1 },
    aiConfig: {
      apiKey: 'mock-server-key',
      model: 'deepseek-flash',
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response('', { status: 401 });
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }],
        });
      },
    },
  });
  const reading = localDraw('指引？', 'single');
  assert.equal((await request('/api/tarot/interpret', reading)).status, 502);
  assert.equal((await request('/api/tarot/interpret', reading)).status, 200);
  assert.equal((await request('/api/tarot/interpret', reading)).status, 429);
  assert.equal(calls, 2);
});
test('server mode sends only sync authorization; local mode remains independently available', async (t) => {
  const reading = localDraw('指引？', 'single');
  const settings = {
    url: 'https://sync.example.com',
    token: 'sync-token',
    autoSync: false,
    remember: false,
    apiKey: 'unused-device-secret',
    model: 'deepseek-flash',
    rememberKey: false,
    aiMode: 'server',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://sync.example.com/api/tarot/interpret');
    assert.equal(options.headers.Authorization, 'Bearer sync-token');
    assert.equal(JSON.stringify(options).includes('unused-device-secret'), false);
    return Response.json({ ...reading, source: 'deepseek', model: 'deepseek-flash', analysis });
  });
  assert.equal((await clientAI.interpretReading(settings, reading)).source, 'deepseek');
});
test('local AI handles missing keys, provider errors, truncation, timeout and invalid JSON', async () => {
  await assert.rejects(() => completion({ apiKey: '' }, []), /本机/);
  for (const [mock, expected] of [
    [() => new Response('', { status: 401 }), /本机/],
    [() => new Response('', { status: 429 }), /繁忙/],
    [
      () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
      /完整/,
    ],
    [
      () =>
        Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'invalid' } }] }),
      /格式/,
    ],
    [
      () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ ...analysis, cards: [] }) },
            },
          ],
        }),
      /格式/,
    ],
    [
      () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      /超时/,
    ],
  ]) {
    await assert.rejects(
      () =>
        interpret(
          {
            apiKey: 'mock-key',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            fetch: async () => mock(),
          },
          localDraw('方向？', 'single'),
        ),
      expected,
    );
  }
});
test('local AI keys stay separate from sync settings and persistence is opt-in', (t) => {
  const local = new Map(),
    session = new Map();
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = (map) => ({
    getItem: (key) => map.get(key) || null,
    setItem: (key, value) => map.set(key, String(value)),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(local) });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(session),
  });
  t.after(() => {
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal);
    else delete globalThis.localStorage;
    if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession);
    else delete globalThis.sessionStorage;
  });
  const settings = {
    url: 'https://sync.example.com',
    token: 'sync-token',
    autoSync: false,
    remember: false,
    apiKey: 'mock-device-api-key',
    model: 'deepseek-flash',
    rememberKey: false,
  };
  assert.equal('apiKey' in syncSettings(settings), false);
  persistSettings(settings);
  assert.equal(local.get('astral.settings').includes(settings.apiKey), false);
  assert.equal(local.get('astral.ai').includes(settings.apiKey), false);
  assert.equal(loadSettings().apiKey, settings.apiKey);
  session.clear();
  assert.equal(loadSettings().apiKey, '');
  persistSettings({ ...settings, rememberKey: true });
  session.clear();
  assert.equal(loadSettings().apiKey, settings.apiKey);
});
test('sync: two devices merge records; deletions win over an offline stale upload', async (t) => {
  const { request } = await fixture(t);
  const a = localDraw('设备 A 的问题', 'single'),
    b = localDraw('设备 B 的问题', 'three');
  const A = { id: a.id, deleted: false, data: a },
    B = { id: b.id, deleted: false, data: b };
  assert.equal((await request('/api/sync', { entries: [A] })).body.entries.length, 1);
  const merged = await request('/api/sync', { entries: [B] });
  assert.equal(merged.body.entries.length, 2);
  const tombstone = { id: a.id, deleted: true, data: null };
  await request('/api/sync', { entries: [tombstone] });
  const stale = await request('/api/sync', { entries: [A, B] });
  assert.equal(stale.body.entries.find((e) => e.id === a.id).deleted, true);
  const local = mergeEntries([A, B], stale.body.entries);
  assert.equal(local.filter((e) => !e.deleted).length, 1);
  assert.equal(mergeEntries([tombstone], [A])[0].deleted, true);
});
test('sync collision rolls back atomically; corrupted readings are rejected', async (t) => {
  const { request } = await fixture(t);
  const a = localDraw('原始问题', 'single'),
    b = localDraw('新问题', 'single');
  const entry = (data) => ({ id: data.id, deleted: false, data });
  await request('/api/sync', { entries: [entry(a)] });
  const result = await request('/api/sync', {
    entries: [entry(b), entry({ ...a, question: '冲突内容' })],
  });
  assert.equal(result.status, 409);
  const after = await request('/api/sync', { entries: [] });
  assert.equal(after.body.entries.length, 1);
  assert.equal(
    (await request('/api/sync', { entries: [entry({ ...a, cards: [...a.cards, ...a.cards] })] }))
      .status,
    400,
  );
  assert.equal((await request('/api/sync', { entries: [{ ...entry(a), id: b.id }] })).status, 400);
});
test('server restart preserves records and custom plugins', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await createApp({ token, dataDir: dir });
  const r = localDraw('重启后还在吗？', 'single');
  first.store.sync([{ id: r.id, deleted: false, data: r }]);
  first.store.savePlugin(pluginSchema.parse(example));
  await new Promise((resolve) => first.server.close(resolve));
  const second = await createApp({ token, dataDir: dir });
  assert.equal(second.store.all()[0].id, r.id);
  assert.equal(second.store.plugins()[0].id, example.id);
  await new Promise((resolve) => second.server.close(resolve));
});
test('server stores plugin configuration only; the client executes plugins', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/plugins', example)).status, 201);
  assert.equal((await request('/api/plugins')).body.plugins.length, 1);
  assert.equal(
    (await request('/api/plugins', { ...example, capabilities: ['execute.code'] })).status,
    400,
  );
  assert.equal((await request('/api/plugins', { ...example, id: 'tarot' })).status, 400);
  assert.equal(
    (await request('/api/plugins/run', { pluginId: example.id, input: 'hi' })).status,
    404,
  );
  await request(`/api/plugins/${example.id}`, undefined, { method: 'DELETE' });
  assert.equal((await request('/api/plugins')).body.plugins.length, 0);
});
test('chat message synchronization supports merging, tombstones and rejects credential fields', async (t) => {
  const { request } = await fixture(t);
  const conversationId = randomUUID();
  const data = {
    id: randomUUID(),
    conversationId,
    role: 'user',
    content: '一条本地聊天消息',
    createdAt: new Date().toISOString(),
  };
  const assistant = {
    ...data,
    id: randomUUID(),
    role: 'assistant',
    content: '这是设备直连模型生成的回复',
  };
  const entry = (data) => ({ id: data.id, deleted: false, data });
  assert.equal((await request('/api/chat/sync', { entries: [entry(data)] })).status, 200);
  assert.equal(
    (await request('/api/chat/sync', { entries: [entry(assistant)] })).body.entries.length,
    2,
  );
  await request('/api/chat/sync', { entries: [{ id: data.id, deleted: true, data: null }] });
  const stale = await request('/api/chat/sync', { entries: [entry(data)] });
  assert.equal(stale.body.entries.find((e) => e.id === data.id).deleted, true);
  assert.equal(
    (await request('/api/chat/sync', { entries: [entry({ ...data, apiKey: 'must-not-sync' })] }))
      .status,
    400,
  );
  assert.equal((await request('/api/sync', { entries: [], apiKey: 'must-not-sync' })).status, 400);
});
test('all 78 local card assets have unique drawings, clear names and no external image dependencies', async () => {
  const hashes = new Set();
  for (const c of deck) {
    const svg = await readFile(new URL(`../web/public/cards/${c.id}.svg`, import.meta.url), 'utf8');
    assert.ok(svg.includes(`<title id="title">星屿原创塔罗 · ${c.name}</title>`));
    assert.equal(/(?:href|src)=['"]https?:/.test(svg), false);
    const art = svg.slice(svg.indexOf('<g clip-path='), svg.indexOf('</g></g><text'));
    hashes.add(createHash('sha256').update(art).digest('hex'));
  }
  assert.equal(hashes.size, 78);
});
test('all classic Rider-Waite images match their recorded Commons provenance and checksums', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../web/public/cards/classic/sources.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.cards.length, 78);
  assert.equal(new Set(manifest.cards.map((c) => c.id)).size, 78);
  const hashes = new Set();
  for (const card of manifest.cards) {
    assert.ok(deck.some((c) => c.id === card.id));
    assert.equal(card.license, 'Public domain');
    assert.equal(new URL(card.sourcePage).hostname, 'commons.wikimedia.org');
    const bytes = await readFile(
      new URL(`../web/public/cards/classic/${card.file}`, import.meta.url),
    );
    assert.equal(bytes[0], 255);
    assert.equal(bytes[1], 216);
    assert.equal(bytes.at(-2), 255);
    assert.equal(bytes.at(-1), 217);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), card.sha256);
    hashes.add(card.sha256);
  }
  assert.equal(hashes.size, 78);
});
test('native app origin is explicitly allowed; unknown origins are not granted CORS', async (t) => {
  const { url } = await fixture(t);
  const native = await fetch(url + '/api/status', {
    method: 'OPTIONS',
    headers: { Origin: 'astral://app', 'Access-Control-Request-Method': 'PATCH' },
  });
  assert.equal(native.status, 204);
  assert.equal(native.headers.get('Access-Control-Allow-Origin'), 'astral://app');
  assert.match(native.headers.get('Access-Control-Allow-Methods'), /\bPATCH\b/);
  for (const route of [
    '/api/pi/projects/workspace/display-name',
    '/api/relay/projects/project/display-name',
  ]) {
    const rename = await fetch(url + route, {
      method: 'OPTIONS',
      headers: {
        Origin: 'astral://app',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(rename.status, 204);
    assert.match(rename.headers.get('Access-Control-Allow-Methods'), /\bPUT\b/);
  }
  const unknown = await fetch(url + '/api/status', {
    method: 'OPTIONS',
    headers: { Origin: 'https://unknown.example' },
  });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.headers.get('Access-Control-Allow-Origin'), null);
});
