import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { emptyDshSession, dshSessionView } from '../shared/dsh-session.mjs';

function fixture(t) {
  const raw = new DatabaseSync(':memory:');
  const queries = [];
  const db = {
    exec: raw.exec.bind(raw),
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return new Proxy(stmt, {
        get(target, name) {
          const value = target[name];
          return typeof value !== 'function'
            ? value
            : (...args) => {
                if (['get', 'all', 'run'].includes(name)) queries.push(sql);
                return value.apply(target, args);
              };
        },
      });
    },
  };
  const service = createDshConversations(db, {
    body: async () => ({}),
    rate() {},
    appTools: { engine: () => ({ pending: () => [{ id: 'confirmation' }] }) },
    live() {
      throw Error('offline');
    },
  });
  t.after(() => {
    service.close();
    raw.close();
  });
  const seed = (
    state,
    {
      owner = 'alice',
      title = null,
      stop = null,
      updated = '2026-01-01',
      pinned = null,
      archived = null,
    } = {},
  ) => {
    const id = randomUUID();
    raw
      .prepare(
        'INSERT INTO dsh_conversations(owner,id,connection_id,workspace_id,session_id,state,snapshot,stop_cursor,created_at,updated_at,title,pinned_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        owner,
        id,
        randomUUID(),
        'project',
        id,
        'unknown',
        JSON.stringify(state),
        stop,
        'created',
        updated,
        title,
        pinned,
        archived,
      );
    return id;
  };
  const list = async (owner = 'alice') => {
    let result;
    await service.handle(
      { method: 'GET' },
      new URL('https://synthetic.test/api/agent/remote/conversations'),
      (_, value) => {
        result = value.conversations;
      },
      { id: owner },
    );
    return result;
  };
  return { raw, service, queries, seed, list };
}
const user = (seq, text = 'human', rpcId = randomUUID()) => ({
  type: 'user/message',
  seq,
  time: 0,
  data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId } },
});
const fields = [
  'id',
  'title',
  'connectionId',
  'projectId',
  'sessionId',
  'state',
  'updatedAt',
  'runState',
  'pinnedAt',
  'archivedAt',
];

test('summary list matches detailed view fields across titles, roles and run states', async (t) => {
  const f = fixture(t);
  const states = [];
  for (const kind of ['completed', 'aborted', 'error', 'blocked', 'interrupted']) {
    const state = emptyDshSession();
    state.events = [
      user(0),
      { type: 'turn/start', seq: 1, data: {} },
      { type: 'turn/end', seq: 2, data: { reason: { kind } } },
    ];
    states.push(state);
  }
  states.push(emptyDshSession());
  const waiting = emptyDshSession();
  waiting.interactions = [{ id: 'question', answerable: true }];
  states.push(waiting);
  const queued = emptyDshSession();
  queued.projections.inbox = [{ id: 'queued' }];
  states.push(queued);
  const live = emptyDshSession();
  live.assistant = { attemptId: 'live', blocks: { 0: { type: 'text', text: 'stream' } } };
  states.push(live);
  const roles = emptyDshSession();
  roles.events = [
    { type: 'assistant/message', seq: 0, data: { content: [{ type: 'text', text: 'assistant' }] } },
    user(1, ' '),
    user(2, 'native'),
  ];
  states.push(roles);
  const reasoning = emptyDshSession();
  reasoning.events = [user(0)];
  reasoning.events[0].data.content = [{ type: 'reasoning', text: 'reason only' }];
  states.push(reasoning);
  for (const [i, state] of states.entries()) {
    if (i % 2) state.connection = 'connected';
    if (i % 3 === 0) state.projections.title = 'projected';
    const id = f.seed(state, {
      title: i % 4 === 0 ? 'explicit' : null,
      stop: i === 1 ? 0 : null,
      updated: String(i),
      pinned: 'pin',
      archived: 'archive',
    });
    for (const e of state.events.filter((e) => e.type === 'user/message' && e.data.source?.rpcId))
      f.raw
        .prepare('INSERT INTO assistant_dsh_inputs VALUES(?,?,?,?)')
        .run('alice', e.data.source.rpcId, id, 'original-' + i);
  }
  const result = await f.list();
  for (const item of result) {
    const detail = f.service.read('alice', item.id).conversation;
    assert.deepEqual(item, Object.fromEntries(fields.map((key) => [key, detail[key]])));
    assert.deepEqual(Object.keys(item).sort(), [...fields].sort());
  }
  assert.deepEqual(
    result.map((i) => i.updatedAt),
    result
      .map((i) => i.updatedAt)
      .sort()
      .reverse(),
  );
});

test('10x100 history summary uses 11 queries and no per-message input reads', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    const state = emptyDshSession();
    state.events = Array.from({ length: 100 }, (_, j) => user(j));
    f.seed(state, { title: 'explicit' });
  }
  f.queries.length = 0;
  assert.equal((await f.list()).length, 10);
  assert.equal(f.queries.length, 11);
  assert.equal(f.queries.filter((sql) => sql.includes('assistant_dsh_inputs')).length, 0);
  f.raw.prepare('UPDATE dsh_conversations SET title=NULL').run();
  f.queries.length = 0;
  const untitled = await f.list();
  assert.equal(untitled.length, 10);
  assert.ok(untitled.every((item) => item.title === 'human'));
  assert.equal(f.queries.length, 31);
  assert.equal(f.queries.filter((sql) => sql.includes('assistant_dsh_inputs')).length, 10);
});

test('owner-scoped title lookup and fresh lists preserve deletion and offline history', async (t) => {
  const f = fixture(t);
  const state = emptyDshSession();
  state.events = [user(0, 'native', 'shared-rpc')];
  const id = f.seed(state);
  f.seed(state, { owner: 'bob', title: 'private' });
  f.raw
    .prepare('INSERT INTO assistant_dsh_inputs VALUES(?,?,?,?)')
    .run('bob', 'shared-rpc', id, 'private-input');
  assert.equal((await f.list())[0].title, 'native');
  assert.equal((await f.list('bob'))[0].title, 'private');
  assert.throws(() => f.service.read('bob', id), { status: 404 });
  f.raw.prepare('DELETE FROM dsh_conversations WHERE owner=? AND id=?').run('alice', id);
  assert.deepEqual(await f.list(), []);
});

test('software confirmations and scoped task titles match detailed views', async (t) => {
  const f = fixture(t);
  const state = emptyDshSession();
  state.connection = 'connected';
  state.events = [user(0, 'injected wrapper', 'task'), { type: 'turn/start', data: {} }];
  const id = f.seed(state);
  f.raw
    .prepare('INSERT INTO dsh_app_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'alice',
      'task',
      id,
      'connection',
      id,
      'hash',
      'request',
      'original task input',
      'binding',
      null,
      Date.now() + 10000,
      0,
    );
  const item = (await f.list())[0];
  assert.equal(item.title, 'original task input');
  assert.equal(item.runState.state, 'waiting');
  const detail = f.service.read('alice', id).conversation;
  assert.deepEqual(item, Object.fromEntries(fields.map((key) => [key, detail[key]])));
  f.raw.prepare('UPDATE dsh_app_tasks SET conversation_id=?').run('other');
  assert.equal((await f.list())[0].title, 'injected wrapper');
});

test('summary projection does not access message or tool bodies while preserving run state', () => {
  const state = emptyDshSession();
  state.events = [
    user(0),
    { type: 'tool/call', data: {} },
    { type: 'tool/result', data: {} },
    { type: 'turn/start', data: {} },
  ];
  Object.defineProperty(state.events[0].data, 'content', {
    get() {
      throw Error('message body read');
    },
  });
  const value = dshSessionView(state, { summary: true });
  assert.equal(value.status, 'running');
  assert.deepEqual(value.messages, []);
  assert.deepEqual(value.tools, []);
});
