import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { createDshSessionChannel } from '../server/dsh-session-channel.mjs';

test('unwatch aborts only the independent follow and reopening uses a fresh baseline', async (t) => {
  const signals = new Map(),
    failures = [];
  const gateway = {
    async open(endpoint, payload, signal) {
      const name =
        endpoint === 'session/follow' ? payload.args.request.address.sessionId : endpoint;
      signals.set(name, signal);
      const first =
        endpoint === '$events'
          ? { type: 'ready', clientId: 'client' }
          : endpoint === 'session/control'
            ? { type: 'baseline', value: { projections: {} } }
            : {
                type: 'snapshot',
                header: { id: name, version: 3 },
                records: [],
                projections: { asOfSeq: 0, values: {} },
              };
      let initial = true;
      const ended = Promise.withResolvers();
      signal.addEventListener('abort', () => ended.resolve({ done: true }), { once: true });
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (initial) {
            initial = false;
            return { value: first, done: false };
          }
          return ended.promise;
        },
        async close() {
          ended.resolve({ done: true });
        },
      };
    },
    async dispatch() {
      return { ok: true, value: {} };
    },
  };
  const channel = createDshSessionChannel(gateway, {
    v3: true,
    onFailure: (e) => failures.push(e),
  });
  t.after(() => channel.close());
  const a = [],
    b = [];
  await channel.watch('a', (frame) => a.push(frame));
  await channel.watch('b', (frame) => b.push(frame));
  const old = signals.get('a');
  channel.unwatch('a');
  await new Promise((r) => setImmediate(r));
  assert.equal(old.aborted, true);
  assert.equal(signals.get('b').aborted, false);
  assert.equal(signals.get('$events').aborted, false);
  assert.equal(signals.get('session/control').aborted, false);
  await channel.watch('a', (frame) => a.push(frame));
  assert.notEqual(signals.get('a'), old);
  assert.equal(a.filter((f) => f.type === 'snapshot').length, 2);
  assert.equal(b.filter((f) => f.type === 'snapshot').length, 1);
  assert.equal(failures.length, 0);
});

async function fixture(t, active = false) {
  const db = new DatabaseSync(':memory:');
  const listeners = new Map(),
    opened = [],
    released = [];
  let clock = 1000;
  const connectionId = randomUUID();
  const chat = {
    async watch(id, listener) {
      opened.push(id);
      listeners.set(id, listener);
      listener({
        type: 'snapshot',
        header: { id, version: 3 },
        cursor: active ? 0 : -1,
        records: active
          ? [
              {
                type: 'event',
                event: { seq: 0, type: 'turn/start', time: clock, data: { turn: 1 } },
              },
            ]
          : [],
        projections: { asOfSeq: 0, values: {} },
      });
    },
    unwatch(id) {
      released.push(id);
      listeners.delete(id);
    },
  };
  const client = { chat: () => chat };
  const service = createDshConversations(db, {
    body: async (r) => r.body,
    rate() {},
    now: () => clock,
    live: () => ({ state: 'ready' }),
    connection: async () => ({ client, peer: { location: 'server', deviceId: 'synthetic' } }),
    catalogue: async () => ({
      host: { location: 'server', deviceId: 'synthetic' },
      workspaces: [{ id: 'project' }],
      sessions: Array.from({ length: 100 }, (_, i) => ({
        id: 'session-' + i,
        workspaceIds: ['project'],
      })),
    }),
  });
  t.after(() => {
    service.close();
    db.close();
  });
  async function req(method, path, body) {
    let response;
    await service.handle(
      { method, body },
      new URL('http://localhost/api/agent/remote/conversations' + path),
      (status, value) => {
        response = { status, ...value };
      },
      { id: 'owner' },
    );
    return response;
  }
  async function open(i) {
    const id = randomUUID();
    try {
      const created = await req('POST', '', {
        id,
        connectionId,
        workspaceId: 'project',
        sessionId: 'session-' + i,
      });
      assert.equal(created.status, 201);
    } catch (error) {
      if (!active || error.status !== 429) throw error;
    }
    return id;
  }
  return {
    db,
    req,
    open,
    opened,
    released,
    listeners,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('watch pressure recycles oldest idle follow and rebuilds it without replay', async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 17; i++) {
    ids.push(await f.open(i));
    const r = await f.req('GET', '/' + ids[i]);
    assert.equal(r.degraded, false);
    f.advance(1);
  }
  assert.equal(f.opened.length, 17);
  assert.equal(f.released[0], 'session-0');
  assert.equal((await f.req('GET', '/' + ids[0])).degraded, false);
  assert.equal(f.opened.filter((id) => id === 'session-0').length, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM dsh_actions').get().n, 0);
  f.advance(61000);
  const newId = await f.open(18);
  await f.req('GET', '/' + newId);
  assert.ok(f.released.length >= 17);
});

test('running follows cannot be reclaimed and capacity degradation is explicit', async (t) => {
  const f = await fixture(t, true);
  for (let i = 0; i < 16; i++) {
    const id = await f.open(i);
    await f.req('GET', '/' + id);
  }
  f.advance(120000);
  const id = await f.open(16);
  const result = await f.req('GET', '/' + id);
  assert.equal(result.status, 200);
  assert.equal(result.degraded, true);
  assert.equal(result.syncStale, true);
  assert.match(result.warning, /同步已降级.*容量/);
  assert.equal(f.released.length, 0);
  assert.equal(f.opened.length, 16);
});

test('idle timer reclaims only after sixty seconds without capacity pressure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  const id = await f.open(0);
  f.advance(59999);
  t.mock.timers.tick(30000);
  assert.equal(f.released.length, 0);
  f.advance(1);
  t.mock.timers.tick(30000);
  assert.deepEqual(f.released, ['session-0']);
  await f.req('GET', '/' + id);
  assert.equal(f.opened.length, 2);
});

for (const protection of ['queued', 'unknown', 'disconnected', 'stop']) {
  test(`${protection} watch survives idle and capacity reclamation`, async (t) => {
    const f = await fixture(t);
    const id = await f.open(0);
    const row = f.db.prepare('SELECT * FROM dsh_conversations WHERE id=?').get(id);
    const snapshot = JSON.parse(row.snapshot);
    if (protection === 'queued') snapshot.projections.inbox = [{ id: 'queued', rpcId: 'q', text: 'pending' }];
    if (protection === 'disconnected') snapshot.connection = 'reconnecting';
    f.db.prepare('UPDATE dsh_conversations SET snapshot=?,state=?,stop_cursor=? WHERE id=?').run(
      JSON.stringify(snapshot), protection === 'unknown' ? 'unknown' : 'ready', protection === 'stop' ? 0 : null, id,
    );
    for (let i = 1; i < 16; i++) await f.open(i);
    f.advance(61000);
    await f.open(16);
    assert.equal(f.released.includes('session-0'), false);
    assert.ok(f.released.includes('session-1'));
  });
}

for (const state of ['sending', 'unknown', 'accepted', 'unrecognized-state']) {
  test(`unreconciled action ${state} protects an otherwise idle watch`, async (t) => {
    const f = await fixture(t);
    const first = await f.open(0);
    f.db.prepare('INSERT INTO dsh_actions VALUES(?,?,?,?,?,?,NULL,?,NULL)').run(
      'owner', randomUUID(), first, 'prompt', 'digest', state, new Date().toISOString(),
    );
    for (let i = 1; i < 16; i++) await f.open(i);
    f.advance(61000);
    await f.open(16);
    assert.equal(f.released.includes('session-0'), false);
    assert.equal(f.db.prepare('SELECT state FROM dsh_actions WHERE conversation_id=?').get(first).state, state);
    assert.equal(f.db.prepare('SELECT count(*) n FROM dsh_actions').get().n, 1);
    assert.ok(f.released.includes('session-1'));
  });
}

test('DshRemote consumes warning and degradation flags and renders the actual status text', () => {
  const source = readFileSync(new URL('../web/src/DshRemote.tsx', import.meta.url), 'utf8');
  const match = source.match(/setSyncError\(\s*(r\.warning\s*\|\|\s*\(r\.degraded\s*\|\|\s*r\.syncStale\s*\?\s*'[^']*'\s*:\s*''\)),?\s*\)/);
  assert.ok(match, 'successful sync must consume warning and degradation flags');
  const consume = new Function('r', 'return ' + match[1]);
  assert.equal(consume({ warning: 'capacity reason', degraded: true }), 'capacity reason');
  assert.match(consume({ degraded: true }), /同步已降级/);
  assert.match(consume({ syncStale: true }), /不是最新/);
  assert.equal(consume({}), '');
  assert.match(source, /syncError && <small role="status">\{syncError\}<\/small>/);
});
