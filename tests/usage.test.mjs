import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAccounts } from '../server/accounts.mjs';
import { createUsage } from '../server/usage.mjs';
import { completion } from '../shared/ai.mjs';
import { createApp } from '../server/index.mjs';
import { createAuxiliaryUsage } from '../deploy/pi/usage-telemetry.mjs';
import {
  priceFor,
  tokenCost,
  providerTokenUsage,
  piTokenUsage,
  formatCny,
} from '../shared/deepseek-pricing.mjs';
const off = '2026-11-05T13:00:00+08:00',
  peak = '2026-11-05T15:00:00+08:00';
const raw = {
  prompt_tokens: 1000,
  prompt_cache_hit_tokens: 900,
  prompt_cache_miss_tokens: 100,
  completion_tokens: 40,
};
const usage = { cacheHit: 1e6, cacheMiss: 1e6, output: 1e6 };
test('official CNY prices use exact cache/input/output arithmetic and Beijing peak boundaries', () => {
  assert.equal(
    formatCny(tokenCost(usage, priceFor('deepseek-flash', off)).costNanos),
    '5.020000000',
  );
  assert.equal(
    formatCny(tokenCost(usage, priceFor('deepseek-v4-pro', peak)).costNanos),
    '36.300000000',
  );
  assert.equal(
    formatCny(
      tokenCost({ cacheHit: 1, cacheMiss: 0, output: 0 }, priceFor('deepseek-flash', off))
        .costNanos,
    ),
    '0.000000020',
  );
  for (const [time, band] of [
    ['08:59', 'offPeak'],
    ['09:00', 'peak'],
    ['11:59', 'peak'],
    ['12:00', 'offPeak'],
    ['14:00', 'peak'],
    ['18:00', 'offPeak'],
  ])
    assert.equal(priceFor('deepseek-flash', `2026-11-05T${time}:00+08:00`).band, band);
  assert.equal(priceFor('deepseek-flash', '2026-11-07T10:00:00+08:00').band, 'offPeak');
  assert.equal(priceFor('deepseek-v4-flash', peak).model, 'deepseek-flash');
  assert.equal(priceFor('deepseek-chat', peak).reason, 'model_not_priced');
  assert.equal(
    priceFor('deepseek-flash', '2026-11-04T10:00:00+08:00').reason,
    'price_not_verified_for_date',
  );
  assert.equal(
    priceFor('deepseek-flash', '2027-01-01T10:00:00+08:00').reason,
    'holiday_calendar_missing',
  );
});
test('usage normalization does not count reasoning twice or infer missing cache splits as free', () => {
  assert.deepEqual(
    providerTokenUsage({ ...raw, completion_tokens_details: { reasoning_tokens: 20 } }),
    { input: 1000, output: 40, cacheHit: 900, cacheMiss: 100, total: 1040 },
  );
  assert.deepEqual(
    piTokenUsage({ input: 100, output: 40, cacheRead: 900, cacheWrite: 0 }),
    providerTokenUsage(raw),
  );
  assert.equal(
    tokenCost(
      providerTokenUsage({ prompt_tokens: 1000, completion_tokens: 40 }),
      priceFor('deepseek-flash', peak),
    ).reason,
    'usage_incomplete',
  );
  assert.equal(providerTokenUsage({ ...raw, prompt_cache_hit_tokens: 999 }).cacheHit, null);
  assert.equal(providerTokenUsage({ ...raw, completion_tokens: -1 }).output, null);
});
test('account ledger isolates concurrent calls, preserves exact costs across restart and ignores replay', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-usage-')),
    path = join(dir, 'usage.sqlite'),
    db = new DatabaseSync(path);
  createAccounts(db);
  for (const [id, space] of [
    ['alice', 'legacy'],
    ['bob', 'bobspace'],
  ])
    db.prepare(
      'INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, id, id, 'synthetic', 'member', space, off);
  let meter = createUsage(db, { now: () => Date.parse(off) });
  const config = {
    apiKey: 'synthetic',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    usageMeter: meter,
    fetch: async (_url, p) => {
      await new Promise((r) =>
        setTimeout(r, JSON.parse(p.body).messages[0].content === 'alice' ? 20 : 1),
      );
      return Response.json({
        usage: raw,
        choices: [{ finish_reason: 'stop', message: { content: 'synthetic' } }],
      });
    },
  };
  await Promise.all(
    ['alice', 'bob'].map((owner) =>
      meter.scopes.run({ owner, source: 'test' }, () =>
        completion(config, [{ role: 'user', content: owner }]),
      ),
    ),
  );
  let report = meter.report({ id: 'alice', role: 'member' });
  assert.equal(report.total.requests, 1);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].id, 'alice');
  assert.equal(report.total.input, 1000);
  assert.equal(report.total.costCny, '0.000278000');
  assert.throws(() => meter.report({ id: 'bob', role: 'member' }, { account: 'alice' }), /自己/);
  assert.equal(meter.report({ id: 'alice', role: 'owner' }).total.requests, 2);
  const event = {
    type: 'usage',
    requestId: 'synthetic-call',
    model: 'deepseek-flash',
    startedAt: peak,
    usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 40 },
  };
  meter.pi('alice', { id: 'task-a' }, event);
  meter.pi('alice', { id: 'task-a' }, event);
  assert.equal(meter.report({ id: 'alice', role: 'member' }).total.requests, 2);
  const unknown = meter.start({ owner: 'bob', source: 'test', model: 'deepseek-flash' });
  meter.finish(unknown, null);
  const rejected = {
    ...config,
    fetch: async () =>
      Response.json({
        usage: raw,
        choices: [{ finish_reason: 'length', message: { content: 'truncated' } }],
      }),
  };
  await assert.rejects(
    () => meter.scopes.run({ owner: 'alice' }, () => completion(rejected, [])),
    /完整返回/,
  );
  const before = meter.report({ id: 'alice', role: 'owner' });
  db.close();
  const reopened = new DatabaseSync(path);
  meter = createUsage(reopened, { now: () => Date.parse(peak) });
  const after = meter.report({ id: 'alice', role: 'owner' });
  assert.deepEqual(after.total, before.total);
  assert.equal(after.total.unknownUsage, 1);
  assert.equal(after.total.unpriced, 1);
  assert.equal(after.requests.find((r) => r.id === unknown).costCny, null);
  reopened.prepare('UPDATE ai_price_cards SET data=?').run('{}');
  assert.throws(() => createUsage(reopened), /不得改写原价卡/);
  reopened.close();
  t.after(() => rm(dir, { recursive: true, force: true }));
});

test('Pi summaries and warming retain auxiliary tokens without double counting ordinary replies or inventing request timing', () => {
  const db = new DatabaseSync(':memory:');
  createAccounts(db);
  db.prepare(
    'INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run('alice', 'alice', 'Alice', 'synthetic', 'member', 'legacy', off);
  const meter = createUsage(db, { now: () => Date.parse(off) }),
    track = createAuxiliaryUsage({
      model: 'deepseek-flash',
      now: () => Date.parse(off),
      id: () => 'compaction-fixture',
    }),
    record = (e) => {
      for (const v of track(e)) meter.pi('alice', { id: 'task-a' }, v);
    };
  record({ type: 'compaction_start' });
  record({ type: 'auto_compaction_start' });
  record({
    type: 'compaction_end',
    result: { usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 40 } },
  });
  record({
    type: 'compaction_end',
    result: { usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 40 } },
  });
  const warm = {
    type: 'entry_appended',
    entry: {
      id: 'warm-fixture',
      type: 'usage',
      provider: 'astral-deepseek',
      model: 'deepseek-flash',
      timestamp: off,
      usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 1 },
    },
  };
  record(warm);
  record(warm);
  record({ type: 'message_end', message: { role: 'assistant', usage: { input: 100 } } });
  const r = meter.report({ id: 'alice', role: 'member' });
  assert.equal(r.total.requests, 2);
  assert.equal(r.total.input, 1100);
  assert.equal(r.total.output, 41);
  assert.equal(r.total.unpriced, 1);
  assert.equal(r.total.costCny, '0.000278000');
  assert.equal(
    r.requests.find((r) => r.source === 'assistant-auxiliary').reason,
    'request_time_missing',
  );
  db.close();
});
test('usage API attributes app requests, restricts member reports and meters split SSE on the computer proxy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-usage-api-')),
    token = 'synthetic-usage-test-admin-token-1234567890';
  let streamed = '';
  const app = await createApp({
    token,
    dataDir: dir,
    now: () => Date.parse(off),
    generateTitle: async () => 'Synthetic usage title',
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-private',
      fetch: async (url) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: true });
        if (url.endsWith('/projects')) return Response.json({ projects: [] });
        const meta = { requestId: 'synthetic-pi-meter', model: 'deepseek-flash', startedAt: off };
        const usage = {
          type: 'usage',
          ...meta,
          usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 0 },
        };
        return new Response(
          [
            { type: 'response_start', ...meta },
            usage,
            usage,
            { type: 'done', output: 'Synthetic Pi reply', tools: [] },
          ]
            .map((e) => JSON.stringify(e) + '\n')
            .join(''),
          { headers: { 'Content-Type': 'application/x-ndjson' } },
        );
      },
    },
    aiConfig: {
      apiKey: 'synthetic',
      model: 'deepseek-flash',
      fetch: async () =>
        Response.json({
          usage: raw,
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
    },
    relayFetch: async (_url, p) => {
      const input = JSON.parse(p.body);
      assert.equal(input.stream_options.include_usage, true);
      assert.equal(input.thinking.type, 'enabled');
      assert.equal(input.reasoning_effort, 'high');
      const content =
        'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: 'stream-sentinel' }, finish_reason: null }],
        }) +
        '\n\ndata: ' +
        JSON.stringify({ choices: [], usage: raw }) +
        '\n\ndata: [DONE]\n\n';
      streamed = content;
      return new Response(
        new ReadableStream({
          start(c) {
            for (const s of [content.slice(0, 13), content.slice(13, 49), content.slice(49)])
              c.enqueue(new TextEncoder().encode(s));
            c.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const req = async (path, data, auth) => {
    const r = await fetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'usageowner',
      displayName: 'Usage Owner',
      password: 'synthetic-usage-password',
      adminToken: token,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const member = (
    await req('/auth/register', {
      username: 'usagemember',
      displayName: 'Usage Member',
      password: 'synthetic-usage-password',
      invite: invite.code,
    })
  ).body;
  assert.equal((await req('/usage')).status, 401);
  assert.equal((await req('/usage', undefined, token)).status, 403);
  // A real app text-plugin route goes through shared completion and the HTTP actor scope.
  await req(
    '/plugins',
    {
      id: 'usage-test',
      name: 'Usage test',
      version: '1.0.0',
      description: 'Synthetic usage fixture',
      icon: 'book',
      prompt: 'Return a synthetic response to the supplied input.',
      inputLabel: 'Input',
      inputPlaceholder: '',
      capabilities: ['ai.text'],
    },
    member.token,
  );
  const call = await req(
    '/plugins/run',
    { pluginId: 'usage-test', input: 'synthetic' },
    member.token,
  );
  assert.equal(call.status, 200);
  let report = (await req('/usage', undefined, member.token)).body;
  assert.equal(report.total.requests, 1);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].id, member.user.id);
  assert.equal((await req('/usage?account=' + owner.user.id, undefined, member.token)).status, 403);
  const code = (await req('/relay/pairing', {}, owner.token)).body.code,
    device = (
      await req('/relay/device/enroll', {
        code,
        name: 'Synthetic',
        platform: 'darwin',
        rootLabel: 'test',
        allowWrite: false,
      })
    ).body,
    project = randomUUID();
  await req(
    '/relay/device/workspace/announce',
    {
      version: 2,
      projects: [{ id: project, name: 'Synthetic', allowWrite: false, allowExecute: false }],
      capabilities: ['thinking_levels'],
    },
    device.token,
  );
  const job = {
    id: randomUUID(),
    conversationId: randomUUID(),
    deviceId: device.deviceId,
    projectId: project,
    input: 'synthetic',
    access: 'read',
    execute: false,
    thinkingLevel: 'high',
    deliveryPreference: 'queue',
  };
  assert.equal((await req('/relay/submissions', job, owner.token)).status, 202);
  await req('/relay/device/workspace/jobs/poll?capacity=2', undefined, device.token);
  const response = await fetch(base + '/relay/provider/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + device.token,
      'X-Astral-Job': job.id,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'malicious-override',
      stream: true,
      messages: [{ role: 'user', content: 'synthetic' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), streamed);
  report = (await req('/usage', undefined, owner.token)).body;
  assert.equal(report.total.requests, 2);
  assert.equal(report.accounts.find((a) => a.id === owner.user.id).requests, 1);
  assert.equal(report.accounts.find((a) => a.id === member.user.id).requests, 1);
  assert.equal(report.total.input, 2000);
  const piId = randomUUID();
  assert.equal(
    (
      await req(
        '/pi/tasks',
        {
          id: piId,
          conversationId: randomUUID(),
          input: 'synthetic meter',
          access: 'read',
          attachments: [],
          thinkingLevel: 'off',
          mode: 'queue',
        },
        member.token,
      )
    ).status,
    202,
  );
  for (let i = 0; i < 100; i++) {
    report = (await req('/usage', undefined, member.token)).body;
    if (report.total.requests === 2 && report.total.unknownUsage === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 2000);
  assert.equal(report.total.unknownUsage, 0);
});
