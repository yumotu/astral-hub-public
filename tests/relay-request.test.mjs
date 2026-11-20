import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';

const MiB = 1024 * 1024;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-relay-request-'));
  const adminToken = 'synthetic-relay-request-admin-123456789';
  let time = Date.now();
  const calls = [];
  const app = await createApp({
    token: adminToken,
    dataDir: dir,
    now: () => time,
    aiConfig: { apiKey: 'synthetic-server-only-key', model: 'deepseek-flash' },
    relayFetch: async (url, init) => {
      calls.push({ url, init, payload: JSON.parse(init.body) });
      return options.provider
        ? options.provider(url, init)
        : Response.json({
            choices: [{ message: { content: 'synthetic response' } }],
            usage: {
              prompt_tokens: 100,
              prompt_cache_hit_tokens: 90,
              prompt_cache_miss_tokens: 10,
              completion_tokens: 5,
            },
          });
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function req(path, data, token, method) {
    const r = await fetch(base + path, {
      method: method || (data === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: r.status, body: await r.json() };
  }
  const owner = (
    await req('/auth/bootstrap', {
      username: 'relayowner',
      displayName: 'Synthetic owner',
      password: 'Synthetic-only-password!',
      adminToken,
    })
  ).body;
  async function enroll() {
    const pair = (await req('/relay/pairing', {}, owner.token)).body;
    return (
      await req('/relay/device/enroll', {
        code: pair.code,
        name: 'Synthetic computer',
        platform: 'darwin',
        rootLabel: 'fixture',
        allowWrite: true,
      })
    ).body;
  }
  const device = await enroll(),
    projectId = randomUUID();
  await req(
    '/relay/device/workspace/announce',
    {
      version: 2,
      projects: [{ id: projectId, name: 'fixture', allowWrite: true, allowExecute: false }],
    },
    device.token,
  );
  const job = {
    id: randomUUID(),
    deviceId: device.deviceId,
    projectId,
    conversationId: randomUUID(),
    input: 'synthetic',
    access: 'read',
    execute: false,
  };
  assert.equal((await req('/relay/submissions', job, owner.token)).status, 202);
  assert.equal(
    (await req('/relay/device/workspace/jobs/poll', undefined, device.token)).body.job.id,
    job.id,
  );
  const headers = (id = job.id, token = device.token) => ({
    Authorization: `Bearer ${token}`,
    'X-Astral-Job': id,
    'Content-Type': 'application/json',
  });
  const model = (payload, extra = {}) =>
    fetch(base + '/relay/provider/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      ...extra,
    });
  return {
    ...app,
    base,
    req,
    owner,
    device,
    job,
    projectId,
    calls,
    model,
    headers,
    enroll,
    tick: (ms) => (time += ms),
  };
}

test('remote native context above former 1 MB and 2 MiB limits reaches the model intact and meters the owner', async (t) => {
  const f = await fixture(t);
  const payload = {
    model: 'untrusted-model',
    max_tokens: 999999,
    messages: [
      { role: 'system', content: 'synthetic instructions' },
      { role: 'user', content: '中文长上下文'.repeat(180000) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"fixture.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'synthetic tool result' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
  };
  assert.ok(JSON.stringify(payload).length > 1000000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 2 * MiB);
  const r = await f.model(payload);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).choices[0].message.content, 'synthetic response');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].payload.messages, payload.messages);
  assert.deepEqual(f.calls[0].payload.tools, payload.tools);
  assert.equal(f.calls[0].payload.model, 'deepseek-flash');
  assert.equal(f.calls[0].payload.max_tokens, 16384);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer synthetic-server-only-key');
  const report = (await f.req('/usage', undefined, f.owner.token)).body;
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 100);
  assert.equal(report.total.output, 5);
  assert.equal(report.accounts[0].id, f.owner.user.id);
});

test('native tool history is bounded by request bytes rather than the former 1000-message limit', async (t) => {
  const f = await fixture(t);
  const messages = [{ role: 'user', content: 'synthetic' }];
  for (let i = 0; i < 501; i++)
    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: `call-${i}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `call-${i}`, content: 'synthetic' },
    );
  const r = await f.model({ messages });
  assert.equal(r.status, 200, await r.clone().text());
  await r.text();
  assert.deepEqual(f.calls[0].payload.messages, messages);
});

test('relay reports malformed JSON shape separately from the 16 MiB byte ceiling and leaves other routes unchanged', async (t) => {
  const f = await fixture(t);
  for (const payload of [null, [], {}, { messages: [] }, { messages: 'invalid' }]) {
    const r = await f.model(payload);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /格式/);
  }
  const malformed = await f.model({}, { body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  // Character count is below the ceiling; UTF-8 bytes are above it.
  const large = JSON.stringify({ messages: [{ role: 'user', content: '中'.repeat(6 * MiB) }] });
  assert.ok(large.length < 16 * MiB);
  const over = await f.model({}, { body: large });
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /16 MiB/);
  // Chunked bodies must receive the same useful 413, not a reset socket.
  async function* chunks() {
    for (let i = 0; i < large.length; i += 65536) yield large.slice(i, i + 65536);
  }
  const chunked = await f.model({}, { body: chunks(), duplex: 'half' });
  assert.equal(chunked.status, 413);
  assert.match((await chunked.json()).error, /16 MiB/);
  const ordinary = await f.req(
    '/relay/submissions',
    { padding: 'x'.repeat(2 * MiB) },
    f.owner.token,
  );
  assert.equal(ordinary.status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.req('/usage', undefined, f.owner.token)).body.total.requests, 0);
});

test('an upload cannot use a cancelled, expired, revoked or withdrawn project lease after body parsing', async (t) => {
  for (const action of ['cancel', 'expire', 'revoke', 'withdraw'])
    await t.test(action, async (t) => {
      const f = await fixture(t);
      const entered = new Promise((resolve) =>
        f.server.once('request', () => setImmediate(resolve)),
      );
      let resolveResponse, rejectResponse;
      const finished = new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const upload = httpRequest(
        f.base + '/relay/provider/chat/completions',
        {
          method: 'POST',
          headers: f.headers(),
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolveResponse({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
          );
        },
      );
      upload.on('error', rejectResponse);
      upload.flushHeaders();
      await entered;
      upload.write('{"messages":[{"role":"user","content":"');
      await new Promise(setImmediate);
      if (action === 'cancel') await f.req(`/relay/jobs/${f.job.id}/cancel`, {}, f.owner.token);
      if (action === 'expire') f.tick(46000);
      if (action === 'revoke')
        await f.req(`/relay/devices/${f.device.deviceId}`, undefined, f.owner.token, 'DELETE');
      if (action === 'withdraw')
        await f.req(
          '/relay/device/workspace/announce',
          { version: 2, projects: [] },
          f.device.token,
        );
      upload.end('synthetic"}]}');
      const result = await finished;
      assert.ok([401, 403].includes(result.status), JSON.stringify(result));
      assert.equal(f.calls.length, 0);
    });
});

test('relay keeps device isolation, legacy limits and stream usage on the same gateway', async (t) => {
  const streamed =
    'data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\n' +
    'data: {"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":90,"prompt_cache_miss_tokens":10,"completion_tokens":5}}\n\n' +
    'data: [DONE]\n\n';
  const f = await fixture(t, { provider: () => new Response(streamed) });
  const other = await f.enroll();
  const denied = await f.model(
    { messages: [{ role: 'user', content: 'synthetic' }] },
    { headers: f.headers(f.job.id, other.token) },
  );
  assert.equal(denied.status, 404);
  await denied.text();
  const r = await f.model({
    stream: true,
    messages: [{ role: 'user', content: 'x'.repeat(3 * MiB) }],
  });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), streamed);
  assert.deepEqual(f.calls[0].payload.stream_options, { include_usage: true });
  assert.equal((await f.req('/usage', undefined, f.owner.token)).body.total.input, 100);
  const legacy = {
    id: randomUUID(),
    deviceId: other.deviceId,
    input: 'synthetic legacy',
    access: 'read',
  };
  assert.equal((await f.req('/relay/jobs', legacy, f.owner.token)).status, 201);
  await f.req('/relay/device/poll', undefined, other.token);
  const tooLarge = await f.model(
    { messages: [{ role: 'user', content: 'x'.repeat(300001) }] },
    { headers: f.headers(legacy.id, other.token) },
  );
  assert.equal(tooLarge.status, 413);
  await tooLarge.text();
  assert.equal(f.calls.length, 1);
});

test('large streamed relay requests retain single-flight, cancellation and unknown-usage accounting', async (t) => {
  let aborted = false;
  const f = await fixture(t, {
    provider: (_url, init) =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\n'),
            );
            init.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                stream.error(new Error('synthetic cancellation'));
              },
              { once: true },
            );
          },
        }),
      ),
  });
  const response = await f.model({
    stream: true,
    messages: [{ role: 'user', content: 'x'.repeat(3 * MiB) }],
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  const duplicate = await f.model({ messages: [{ role: 'user', content: 'synthetic' }] });
  assert.equal(duplicate.status, 429);
  await duplicate.text();
  await f.req(`/relay/jobs/${f.job.id}/cancel`, {}, f.owner.token);
  await assert.rejects(reader.read());
  assert.equal(aborted, true);
  assert.equal(f.calls.length, 1);
  const report = (await f.req('/usage', undefined, f.owner.token)).body;
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.unknownUsage, 1);
  const stopped = await f.model({ messages: [{ role: 'user', content: 'synthetic' }] });
  assert.equal(stopped.status, 403);
  await stopped.text();
});
