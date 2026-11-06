import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createAppFunctions } from '../server/app-functions.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  let active = true,
    clock = 1000,
    sent = 0;
  const engine = createAppFunctions(db, {
    token: 'test-private-app-functions-key'.repeat(2),
    profile: (id) => ({ id, space: 'space-' + id }),
    isActive: () => active,
    now: () => clock,
    body: async (req) => req.input,
  });
  engine.register({
    name: 'example.read',
    description: 'Read current account',
    schema: z.object({}).strict(),
    execute: async (ctx) => ({ owner: ctx.owner }),
  });
  engine.register({
    name: 'example.send',
    description: 'Send a frozen message',
    schema: z.object({ text: z.string().min(1) }).strict(),
    prepare: async (_, p) => ({
      preview: { title: 'Send', text: p.text },
      private: { secret: 'private-send-token', text: p.text },
    }),
    commit: async (_, p) => ({ sent: ++sent, text: p.text }),
  });
  const context = { owner: 'alice', task: 'task-a', conversation: 'chat-a', origin: 'pi' };
  t.after(() => {
    engine.close();
    db.close();
  });
  return {
    db,
    engine,
    context,
    sent: () => sent,
    deactivate: () => {
      active = false;
    },
    expire: () => {
      clock += 20 * 60000;
    },
  };
}
test('new registered features appear in the catalog without a new tool schema; arguments and account are enforced', async (t) => {
  const f = fixture(t),
    e = f.engine;
  assert.equal((await e.execute(f.context, { action: 'catalog' })).functions.length, 2);
  e.register({
    name: 'future.feature',
    description: 'Future module',
    schema: z.object({ value: z.number().int().max(10) }).strict(),
    execute: async (_, p) => p,
  });
  const catalog = await e.execute(f.context, { action: 'catalog' });
  assert.equal(
    catalog.functions.find((x) => x.name === 'future.feature').parameters.properties.value.maximum,
    10,
  );
  assert.equal(
    (
      await e.execute(f.context, {
        action: 'invoke',
        name: 'future.feature',
        input: { value: 4 },
        callId: '1',
      })
    ).result.value,
    4,
  );
  await assert.rejects(
    e.execute(f.context, {
      action: 'invoke',
      name: 'example.read',
      input: { owner: 'bob' },
      callId: '2',
    }),
  );
  await assert.rejects(
    e.execute(f.context, { action: 'invoke', name: 'unknown.feature', input: {}, callId: '3' }),
    /不存在/,
  );
});
test('sends require an authenticated frozen preview, persist encrypted, and execute once across repeated confirmations', async (t) => {
  const f = fixture(t),
    input = {
      action: 'invoke',
      name: 'example.send',
      input: { text: 'exact private content' },
      callId: 'send-1',
    };
  const p = await f.engine.execute(f.context, input);
  assert.equal(p.state, 'prepared');
  assert.equal(f.sent(), 0);
  assert.ok(!JSON.stringify(p).includes('private-send-token'));
  assert.ok(
    !JSON.stringify(f.db.prepare('SELECT * FROM app_function_calls').all()).includes(
      'exact private content',
    ),
  );
  assert.equal((await f.engine.execute(f.context, input)).id, p.id);
  assert.equal(
    (await f.engine.execute(f.context, { action: 'status', callId: 'send-1' })).id,
    p.id,
  );
  await assert.rejects(
    f.engine.execute(f.context, { ...input, input: { text: 'different' } }),
    /编号/,
  );
  await assert.rejects(f.engine.respond('bob', p.id, true), /不存在/);
  await assert.rejects(
    f.engine.execute({ ...f.context, task: 'task-b' }, { action: 'status', id: p.id }),
    /不存在/,
  );
  const results = await Promise.all([
    f.engine.respond('alice', p.id, true),
    f.engine.respond('alice', p.id, true),
  ]);
  assert.ok(results.some((x) => x.state === 'done'));
  assert.equal(f.sent(), 1);
  assert.equal((await f.engine.respond('alice', p.id, true)).state, 'done');
  assert.equal(f.sent(), 1);
});
test('cancelled, expired and rejected requests do not send; preparation cancelled during I/O cannot publish a fresh approval', async (t) => {
  const f = fixture(t);
  const p = await f.engine.execute(f.context, {
    action: 'invoke',
    name: 'example.send',
    input: { text: 'x' },
    callId: 'a',
  });
  f.deactivate();
  await assert.rejects(f.engine.respond('alice', p.id, true), /结束/);
  assert.equal(f.sent(), 0);
  const g = fixture(t),
    q = await g.engine.execute(g.context, {
      action: 'invoke',
      name: 'example.send',
      input: { text: 'y' },
      callId: 'b',
    });
  g.expire();
  await assert.rejects(g.engine.respond('alice', q.id, true), /过期/);
  assert.equal(g.sent(), 0);
  const h = fixture(t);
  h.engine.register({
    name: 'cancel.prepare',
    description: 'Cancel during preparation',
    schema: z.object({}).strict(),
    prepare: async () => {
      h.deactivate();
      return { preview: { title: 'Never publish' }, private: {} };
    },
    commit: async () => assert.fail('must not send'),
  });
  await assert.rejects(
    h.engine.execute(h.context, {
      action: 'invoke',
      name: 'cancel.prepare',
      input: {},
      callId: 'c',
    }),
    /结束/,
  );
  assert.equal(h.engine.pending('alice', 'task-a').length, 0);
});
test('uncertain send results are never replayed by retry or restart', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.engine.register({
    name: 'uncertain.send',
    description: 'Timeout',
    schema: z.object({}).strict(),
    prepare: async () => ({ preview: { title: 'Send' }, private: {} }),
    commit: async () => {
      calls++;
      throw Error('transport lost');
    },
  });
  const p = await f.engine.execute(f.context, {
    action: 'invoke',
    name: 'uncertain.send',
    input: {},
    callId: 'u',
  });
  assert.equal((await f.engine.respond('alice', p.id, true)).state, 'unknown');
  assert.equal((await f.engine.respond('alice', p.id, true)).state, 'unknown');
  assert.equal(calls, 1);
  f.engine.close();
  const restarted = createAppFunctions(f.db, {
    token: 'test-private-app-functions-key'.repeat(2),
    profile: (id) => ({ id, space: 'space-' + id }),
    isActive: () => true,
    body: async (req) => req.input,
    now: () => 1000,
  });
  assert.equal((await restarted.respond('alice', p.id, true)).state, 'unknown');
  assert.equal(
    (await restarted.execute(f.context, { action: 'status', callId: 'u' })).state,
    'unknown',
  );
  assert.equal(calls, 1);
  restarted.close();
});
