import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { createAgentBindings } from '../server/agent-bindings.mjs';
import { emptyDshSession } from '../shared/dsh-session.mjs';

const tick = () => new Promise(setImmediate);
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  let pages = 0,
    release,
    reject,
    ready = true;
  let gate = new Promise((yes, no) => {
    release = yes;
    reject = no;
  });
  const chat = {
    async watch() {},
    async page() {
      pages++;
      await gate;
      return {
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 0,
              time: 0,
              data: { content: [{ type: 'text', text: 'older' }] },
            },
          },
        ],
        hasMore: false,
      };
    },
  };
  const client = { chat: () => chat };
  const service = createDshConversations(db, {
    body: async (r) => r.input,
    rate() {},
    live() {
      if (!ready) throw Object.assign(Error('revoked'), { status: 403 });
      return { state: 'ready' };
    },
    connection: async () => ({ client }),
    catalogue: async () => ({}),
  });
  const bindings = createAgentBindings(db),
    connectionId = randomUUID();
  function seed(owner = 'alice') {
    const id = randomUUID(),
      state = emptyDshSession();
    state.connection = 'connected';
    state.hasMore = true;
    state.cursor = 11;
    state.events = [
      {
        type: 'user/message',
        seq: 10,
        time: 0,
        data: { content: [{ type: 'text', text: 'recent' }] },
      },
    ];
    db.prepare(
      'INSERT INTO dsh_conversations(owner,id,connection_id,workspace_id,session_id,state,snapshot,created_at,updated_at,title) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      owner,
      id,
      connectionId,
      'project',
      id,
      'ready',
      JSON.stringify(state),
      'now',
      'now',
      'title',
    );
    bindings.bind(owner, 'remote', id, {
      version: 1,
      backend: 'dsh',
      transport: 'dsh-remote',
      location: 'computer',
      deviceId: randomUUID(),
      connectionId,
      projectId: 'project',
      sessionKey: id,
    });
    return id;
  }
  async function call(id, owner = 'alice') {
    let result;
    await service.handle(
      { method: 'POST', input: {} },
      new URL('http://synthetic/api/agent/remote/conversations/' + id + '/history'),
      (status, body) => {
        result = { status, body };
      },
      { id: owner },
    );
    return result;
  }
  t.after(() => {
    service.close();
    db.close();
  });
  return {
    db,
    service,
    connectionId,
    seed,
    call,
    pages: () => pages,
    release: () => release(),
    reject: () => reject(Error('page failed')),
    retry: () => {
      gate = Promise.resolve();
    },
    revoke: () => {
      ready = false;
    },
    rebind(id) {
      db.prepare('UPDATE dsh_conversations SET workspace_id=? WHERE id=?').run('other', id);
      const runtime = bindings.get('alice', 'remote', id);
      db.prepare(
        'UPDATE agent_conversation_bindings SET runtime=? WHERE owner=? AND conversation_id=?',
      ).run(JSON.stringify({ ...runtime, projectId: 'other' }), 'alice', id);
    },
    change(id, cursorOnly = false) {
      const r = db.prepare('SELECT snapshot FROM dsh_conversations WHERE id=?').get(id);
      const s = JSON.parse(r.snapshot);
      if (cursorOnly) s.cursor++;
      else s.events[0].seq = 9;
      db.prepare('UPDATE dsh_conversations SET snapshot=? WHERE id=?').run(JSON.stringify(s), id);
    },
  };
}
test('same history window shares one page and one prepend for two waiters', async (t) => {
  const f = fixture(t),
    id = f.seed();
  const pending = [f.call(id), f.call(id)];
  await tick();
  assert.equal(f.pages(), 1);
  f.release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a.status, 200);
  assert.deepEqual(a, b);
  assert.equal(a.body.conversation.messages.filter((m) => m.text === 'older').length, 1);
});
test('different owners and conversations do not share history work', async (t) => {
  const f = fixture(t),
    a = f.seed(),
    b = f.seed(),
    c = f.seed('bob');
  const pending = [f.call(a), f.call(b), f.call(c, 'bob')];
  await tick();
  assert.equal(f.pages(), 3);
  f.release();
  await Promise.all(pending);
});
test('failed shared page cleans up and can retry', async (t) => {
  const f = fixture(t),
    id = f.seed();
  const pending = [f.call(id), f.call(id)].map((p) => p.catch((e) => e.message));
  await tick();
  f.reject();
  assert.deepEqual(await Promise.all(pending), ['page failed', 'page failed']);
  f.retry();
  assert.equal((await f.call(id)).status, 200);
  assert.equal(f.pages(), 2);
});
test('successful history work is not retained as a completed-result cache', async (t) => {
  const f = fixture(t),
    id = f.seed();
  const first = f.call(id);
  await tick();
  f.release();
  await first;
  f.change(id);
  const state = JSON.parse(
    f.db.prepare('SELECT snapshot FROM dsh_conversations WHERE id=?').get(id).snapshot,
  );
  state.hasMore = true;
  state.events[0].seq = 10;
  f.db.prepare('UPDATE dsh_conversations SET snapshot=? WHERE id=?').run(JSON.stringify(state), id);
  await f.call(id);
  assert.equal(f.pages(), 2);
});
test('different live cursors do not share work and stale windows cannot double commit', async (t) => {
  const f = fixture(t),
    id = f.seed();
  const a = f.call(id).catch((e) => e);
  await tick();
  f.change(id, true);
  const b = f.call(id).catch((e) => e);
  await tick();
  assert.equal(f.pages(), 2);
  f.release();
  const results = await Promise.all([a, b]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
});
for (const boundary of ['revoke', 'disconnect', 'window', 'binding', 'close'])
  test(`pending history cannot commit after ${boundary}`, async (t) => {
    const f = fixture(t),
      id = f.seed();
    const pending = f.call(id).catch((e) => e);
    await tick();
    if (boundary === 'revoke') f.revoke();
    else if (boundary === 'disconnect') f.service.disconnect('alice', f.connectionId);
    else if (boundary === 'binding') f.rebind(id);
    else if (boundary === 'window') f.change(id);
    else f.service.close();
    f.release();
    const error = await pending;
    assert.ok(error instanceof Error);
    assert.ok([403, 409].includes(error.status));
    const state = JSON.parse(
      f.db.prepare('SELECT snapshot FROM dsh_conversations WHERE id=?').get(id).snapshot,
    );
    assert.ok(!state.events.some((e) => e.seq === 0));
  });
