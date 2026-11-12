import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyDshFrame, emptyDshSession, dshSessionView } from '../shared/dsh-session.mjs';
import { createDshSessionChannel } from '../server/dsh-session-channel.mjs';
import { createDshConversations } from '../server/dsh-conversations.mjs';

const record = (seq, type, data) => ({
  type: 'event',
  event: {
    seq,
    type,
    time: 1000 + seq,
    data,
    ...(/message|result/.test(type) ? { surfaceOp: 'append' } : {}),
  },
});
const snapshot = (id, records = [], extra = {}) => ({
  type: 'snapshot',
  header: { id, version: 3 },
  cursor: records.at(-1)?.event.seq ?? -1,
  records,
  hasMore: false,
  projections: { asOfSeq: records.at(-1)?.event.seq ?? 0, values: {} },
  ...extra,
});
test('DSH v3 history replaces live fragments on commit and reconnect, preserving append-origin messages without configuration leaks', () => {
  let state = applyDshFrame(
    emptyDshSession(),
    snapshot(
      's',
      [
        record(0, 'turn/start', { turn: 1 }),
        record(1, 'user/message', {
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user', rpcId: 'request1' },
        }),
        record(2, 'request/header', { header: { system: 'private', token: 'not visible' } }),
      ],
      {
        assistantStream: {
          revision: 3,
          activeAttempt: {
            attemptId: 'attempt',
            turn: 1,
            step: 1,
            startedAfterSeq: 2,
            nextIndex: 2,
            stream: [
              { type: 'text-chunks', index: 0, time0: 1000, dt: [], texts: ['hel'] },
              { type: 'reasoning-chunks', index: 1, time0: 1001, dt: [], texts: ['think'] },
            ],
          },
        },
      },
    ),
    's',
  );
  assert.equal(JSON.stringify(state).includes('private'), false);
  assert.equal(dshSessionView(state).messages.at(-1).text, 'hel');
  const frame = {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'attempt',
      index: 2,
      time: 1004,
      chunk: { type: 'text-delta', index: 0, text: 'lo' },
    },
  };
  state = applyDshFrame(state, frame, 's');
  assert.equal(dshSessionView(state).messages.at(-1).text, 'hello');
  assert.deepEqual(applyDshFrame(state, frame, 's'), state);
  assert.throws(
    () => applyDshFrame(state, { ...frame, frame: { ...frame.frame, index: 4 } }, 's'),
    /间隙/,
  );
  state = applyDshFrame(
    state,
    record(3, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'reasoning', text: 'think' },
        ],
      },
    }),
    's',
  );
  assert.equal(state.assistant, null);
  assert.equal(dshSessionView(state).messages.filter((m) => m.role === 'assistant').length, 1);
  state = applyDshFrame(
    state,
    record(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    's',
  );
  assert.equal(dshSessionView(state).status, 'done');
  assert.throws(() => applyDshFrame(state, record(6, 'turn/start', { turn: 2 }), 's'), /间隙/);
  const old = state;
  state = applyDshFrame(
    state,
    snapshot('s', [
      record(0, 'turn/start', { turn: 1 }),
      record(1, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
      record(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } }),
      record(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]),
    's',
  );
  assert.equal(state.events.length, 4);
  assert.equal(dshSessionView(state).messages.length, 2);
  assert.throws(() => applyDshFrame(old, snapshot('other'), 's'), /身份/);
  const replacement = record(4, 'assistant/message', {
    message: { content: [{ type: 'text', text: 'context copy' }] },
  });
  replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 2 };
  assert.equal(dshSessionView(applyDshFrame(state, replacement, 's')).messages.length, 2);
});

test('Harness injected workspace/runtime/time context is never presented as a human message or a user-memory quote', () => {
  const state = applyDshFrame(
    emptyDshSession(),
    snapshot('s', [
      record(0, 'user/message', {
        content: [{ type: 'text', text: 'human request' }],
        source: { kind: 'user', rpcId: 'request' },
      }),
      record(1, 'user/message', {
        content: [{ type: 'text', text: 'private workspace instructions' }],
        source: { kind: 'agent-instructions', form: 'instructions' },
      }),
      record(2, 'user/message', {
        content: [{ type: 'text', text: 'runtime metadata' }],
        source: { kind: 'runtime-context', form: 'snapshot' },
      }),
      record(3, 'user/message', {
        content: [{ type: 'text', text: 'late answer data' }],
        source: { kind: 'user-question-reply' },
      }),
    ]),
    's',
  );
  assert.deepEqual(
    dshSessionView(state).messages.map((m) => m.text),
    ['human request'],
  );
  assert.equal(JSON.stringify(state).includes('private workspace'), false);
});

function queue(first) {
  const values = first ? [first] : [];
  let wake,
    done = false;
  return {
    push(frame) {
      values.push(frame);
      wake?.();
      wake = null;
    },
    async close() {
      done = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (!done) {
        if (values.length) yield values.shift();
        else
          await new Promise((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
function gatewayFixture() {
  const sources = new Map(),
    calls = [];
  let rejection, uncertain;
  const gateway = {
    async dispatch(endpoint, payload) {
      calls.push({ endpoint, args: payload.args });
      if (uncertain === endpoint) throw Error('transport lost');
      if (rejection === endpoint) return { ok: false, error: { code: 'rejected' } };
      return { ok: true, value: endpoint === 'userQuestions/answer' ? true : { accepted: true } };
    },
    async open(endpoint, payload, signal) {
      const name =
        endpoint === 'session/follow' ? payload.args.request.address.sessionId : endpoint;
      const first =
        endpoint === '$events'
          ? { type: 'ready', clientId: 'client' }
          : endpoint === 'session/control'
            ? { type: 'baseline', value: { projections: {} } }
            : endpoint === 'userQuestions/attachWait'
              ? { remainingMs: 30000 }
              : snapshot(name);
      const source = queue(first);
      sources.set(name, source);
      signal.addEventListener(
        'abort',
        () => {
          void source.close();
        },
        { once: true },
      );
      return source;
    },
  };
  return {
    gateway,
    calls,
    sources,
    reject: (endpoint) => {
      rejection = endpoint;
    },
    uncertain: (endpoint) => {
      uncertain = endpoint;
    },
  };
}
test('Remote channel shares control carriers, handles batched projections and answers exact questions/one-use approvals only once', async () => {
  const f = gatewayFixture(),
    channel = createDshSessionChannel(f.gateway, { v3: true }),
    a = [],
    b = [];
  try {
    await Promise.all([channel.watch('a', (v) => a.push(v)), channel.watch('b', (v) => b.push(v))]);
    assert.equal(f.sources.size, 4);
    f.sources.get('session/control').push({
      type: 'projection',
      sessionId: 'a',
      seq: 5,
      changes: [
        { key: 'title', val: 'new title' },
        {
          key: 'userQuestions',
          val: {
            active: [
              {
                callId: 'c1',
                state: 'continued',
                questions: [
                  { id: 'q', question: 'pick', options: [{ label: 'yes' }, { label: 'no' }] },
                ],
              },
            ],
            settled: [],
          },
        },
      ],
    });
    await tick();
    assert.equal(a.findLast((v) => v.type === 'projections').values.title, 'new title');
    const question = a.findLast((v) => v.type === 'interaction').interaction;
    assert.equal(question.answerable, true);
    await assert.rejects(
      channel.respond('b', question.id, { answers: [{ id: 'q', selected: ['yes'] }] }),
      { status: 409 },
    );
    await assert.rejects(
      channel.respond('a', question.id, { answers: [{ id: 'q', selected: ['invented'] }] }),
      { status: 400 },
    );
    await channel.respond('a', question.id, { answers: [{ id: 'q', selected: ['yes'] }] });
    await assert.rejects(
      channel.respond('a', question.id, { answers: [{ id: 'q', selected: ['yes'] }] }),
      { status: 409 },
    );
    assert.deepEqual(f.calls.find((c) => c.endpoint === 'userQuestions/answer').args, {
      agentId: 'a',
      callId: 'c1',
      answer: { answers: [{ id: 'q', selected: ['yes'] }] },
    });
    assert.equal(
      b.some((v) => v.type === 'interaction'),
      false,
    );
    f.sources.get('$events').push({
      type: 'waterfall',
      agentId: 'b',
      eventId: 'approve',
      event: 'approval/request',
      request: { toolName: 'bash', reason: 'read files' },
    });
    await tick();
    const approval = b.findLast((v) => v.type === 'interaction').interaction;
    f.uncertain('$events/result');
    await assert.rejects(channel.respond('b', approval.id, { allowed: true }), /transport/);
    await assert.rejects(channel.respond('b', approval.id, { allowed: true }), { status: 409 });
    assert.equal(f.calls.filter((c) => c.endpoint === '$events/result').length, 1);
    await channel.prompt('a', randomUUID(), 'follow up', 'steer');
    assert.equal(f.calls.at(-1).args.request.mode, 'steer');
  } finally {
    await channel.close();
  }
});

test('timed questions require a live claim, then can recover as continued without replaying the expired event', async () => {
  const f = gatewayFixture(),
    channel = createDshSessionChannel(f.gateway, { v3: true }),
    frames = [];
  try {
    await channel.watch('s', (frame) => frames.push(frame));
    f.sources.get('session/control').push({
      type: 'projection',
      sessionId: 's',
      seq: 1,
      key: 'userQuestions',
      value: {
        active: [{ callId: 'call', state: 'open', questions: [{ id: 'q', question: 'answer?' }] }],
        settled: [],
      },
    });
    await tick();
    let question = frames.findLast((v) => v.type === 'interaction').interaction;
    assert.equal(question.answerable, false);
    await assert.rejects(
      channel.respond('s', question.id, { answers: [{ id: 'q', selected: [], custom: 'yes' }] }),
      { status: 409 },
    );
    f.sources.get('$events').push({
      type: 'waterfall',
      agentId: 's',
      eventId: 'foreground',
      event: 'user-questions/request',
      request: {
        questions: [{ id: 'q', question: 'answer?' }],
        wait: { timed: true, callId: 'call' },
      },
    });
    await tick();
    question = frames.findLast((v) => v.type === 'interaction').interaction;
    assert.equal(question.answerable, true);
    await channel.respond('s', question.id, {
      answers: [{ id: 'q', selected: [], custom: 'yes' }],
    });
    assert.equal(f.calls.at(-1).endpoint, '$events/result');
  } finally {
    await channel.close();
  }
});

test('Remote mutation errors never fall back to transferred replay even when the upstream response is oversized', async () => {
  const f = gatewayFixture(),
    sent = [];
  const channel = createDshSessionChannel(f.gateway, {
    v3: true,
    dispatchMutation: async (endpoint) => {
      sent.push(endpoint);
      throw Object.assign(Error('too large after remote execution'), {
        code: 'RESPONSE_TOO_LARGE',
      });
    },
  });
  try {
    await channel.watch('s', () => {});
    await assert.rejects(channel.prompt('s', randomUUID(), 'send once'), /too large/);
    await assert.rejects(channel.cancel('s'), /too large/);
    assert.deepEqual(sent, ['session/prompt', 'session/cancel']);
    assert.deepEqual(f.calls, []);
  } finally {
    await channel.close();
  }
});

function conversationsFixture(t) {
  const db = new DatabaseSync(':memory:'),
    connectionId = randomUUID(),
    watchers = new Map(),
    actions = [],
    deviceId = randomUUID();
  let closed = false,
    uncertain = false,
    reconnectGate = null,
    stops = 0,
    creates = 0;
  const chat = {
    async watch(sessionId, listener) {
      watchers.set(sessionId, listener);
      const current = db
        .prepare('SELECT snapshot FROM dsh_conversations WHERE session_id=?')
        .get(sessionId);
      const prior = current && JSON.parse(current.snapshot);
      const records = (prior?.events || []).map((event) => ({ type: 'event', event }));
      listener(snapshot(sessionId, records));
    },
    async create(workspaceId, sessionId) {
      creates++;
      return { sessionId };
    },
    async prompt(sessionId, requestId, text, mode) {
      actions.push({ sessionId, requestId, text, mode });
      if (uncertain) throw Error('lost receipt');
      return { accepted: true };
    },
    async cancel() {
      stops++;
      return { accepted: true };
    },
    async respond() {
      return { accepted: true };
    },
  };
  const connection = async () => ({
    client: { chat: () => chat },
    peer: { deviceId, location: 'computer' },
  });
  // Reuse one client identity just as a real established connection does.
  const client = { chat: () => chat };
  const options = {
    body: async (r) => r.input,
    rate() {},
    live(owner, id) {
      if (owner !== 'alice' || id !== connectionId || closed)
        throw Object.assign(Error('revoked'), { status: 404 });
      return { state: 'ready' };
    },
    connection: async () => {
      if (reconnectGate) await reconnectGate;
      return { ...(await connection()), client };
    },
    catalogue: async () => ({
      host: { deviceId, location: 'computer' },
      workspaces: [{ id: 'project' }],
      sessions: [{ id: 'native', workspaceIds: ['project'] }],
    }),
  };
  let service = createDshConversations(db, options);
  t.after(() => {
    service.close();
    db.close();
  });
  const call = async (path = '', input, owner = 'alice', method) => {
    let result;
    await service.handle(
      { method: method || (input ? 'POST' : 'GET'), input },
      new URL('https://hub.test/api/agent/remote/conversations' + path),
      (status, body) => {
        result = { status, ...body };
      },
      { id: owner },
    );
    return result;
  };
  return {
    db,
    call,
    watchers,
    connectionId,
    actions,
    pauseReconnect() {
      let release;
      reconnectGate = new Promise((r) => {
        release = r;
      });
      return () => {
        reconnectGate = null;
        release();
      };
    },
    restart() {
      service.close();
      watchers.clear();
      service = createDshConversations(db, options);
    },
    uncertain: () => {
      uncertain = true;
    },
    revoked: () => {
      closed = true;
      service.disconnect('alice', connectionId);
    },
    counts: () => ({ stops, creates }),
  };
}
test('DSH conversations isolate native bindings, journal exact submissions and never replay unknown acceptance, including after restart', async (t) => {
  const f = conversationsFixture(t),
    id = randomUUID();
  const creation = { id, connectionId: f.connectionId, workspaceId: 'project' };
  assert.equal((await f.call('', creation)).conversation.runtime.backend, 'dsh');
  await f.call('', creation);
  assert.equal(f.counts().creates, 1);
  await assert.rejects(f.call('/' + id, null, 'bob'), { status: 404 });
  await assert.rejects(f.call('', { ...creation, workspaceId: 'other' }), { status: 409 });
  const prompt = { id: randomUUID(), text: 'hello', mode: 'steer' };
  assert.equal((await f.call('/' + id + '/prompt', prompt)).operation.state, 'accepted');
  await f.call('/' + id + '/prompt', prompt);
  assert.equal(f.actions.length, 1);
  await assert.rejects(f.call('/' + id + '/prompt', { ...prompt, text: 'different' }), {
    status: 409,
  });
  const native = (await f.call('/' + id)).conversation.sessionId;
  f.watchers.get(native)(
    record(0, 'user/message', {
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user', rpcId: prompt.id },
    }),
  );
  assert.equal((await f.call('/' + id)).conversation.actions[0].state, 'observed');
  f.uncertain();
  const unknown = { id: randomUUID(), text: 'do not retry' };
  await assert.rejects(f.call('/' + id + '/prompt', unknown), /lost receipt/);
  assert.equal((await f.call('/' + id + '/prompt', unknown)).operation.state, 'unknown');
  assert.equal(f.actions.length, 2);
  f.restart();
  assert.equal((await f.call('/' + id + '/prompt', unknown)).operation.state, 'unknown');
  assert.equal(f.actions.length, 2);
  f.revoked();
  const cached = await f.call('/' + id);
  assert.equal(cached.conversation.messages[0].text, 'hello');
  assert.equal(cached.conversation.connection, 'reconnecting');
  await assert.rejects(f.call('/' + id + '/prompt', { id: randomUUID(), text: 'unauthorized' }), {
    status: 404,
  });
  assert.equal(f.actions.length, 2);
});
test('DSH cached history returns during a stalled reconnect and resumes without replaying messages', async (t) => {
  const f = conversationsFixture(t),
    id = randomUUID();
  await f.call('', {
    id,
    connectionId: f.connectionId,
    workspaceId: 'project',
    sessionId: 'native',
  });
  f.watchers.get('native')(
    record(0, 'user/message', {
      content: [{ type: 'text', text: 'preserved message' }],
      source: { kind: 'user' },
    }),
  );
  f.restart();
  const resume = f.pauseReconnect();
  t.after(resume);
  let timer;
  const cached = await Promise.race([
    f.call('/' + id),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('History blocked on reconnect')), 1500);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(cached.conversation.messages[0].text, 'preserved message');
  assert.equal(cached.conversation.connection, 'reconnecting');
  resume();
  const recovered = await f.call('/' + id);
  assert.equal(recovered.conversation.connection, 'connected');
  assert.equal(recovered.conversation.messages[0].text, 'preserved message');
  assert.equal(f.actions.length, 0);
  assert.equal(f.counts().creates, 0);
});
test('DSH local conversation metadata persists without modifying host paths, handles or native messages', async (t) => {
  const f = conversationsFixture(t),
    id = randomUUID();
  await f.call('', {
    id,
    connectionId: f.connectionId,
    workspaceId: 'project',
    sessionId: 'native',
  });
  let result = await f.call(
    '/' + id,
    { title: '本地别名', pinned: true, archived: true },
    'alice',
    'PATCH',
  );
  assert.equal(result.conversation.title, '本地别名');
  assert.ok(result.conversation.pinnedAt);
  assert.ok(result.conversation.archivedAt);
  assert.equal(result.conversation.sessionId, 'native');
  assert.equal(f.actions.length, 0);
  await assert.rejects(f.call('/' + id, { title: 'other' }, 'bob', 'PATCH'), { status: 404 });
  f.restart();
  result = await f.call('/' + id);
  assert.equal(result.conversation.title, '本地别名');
  assert.equal(f.counts().creates, 0);
});
test('DSH cancellation remains stopping until a newer durable host terminal event; old completed turns never confirm it', async (t) => {
  const f = conversationsFixture(t),
    id = randomUUID();
  await f.call('', {
    id,
    connectionId: f.connectionId,
    workspaceId: 'project',
    sessionId: 'native',
  });
  const emit = f.watchers.get('native');
  emit(record(0, 'turn/start', { turn: 1 }));
  emit(record(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  emit(record(2, 'turn/start', { turn: 2 }));
  emit({
    type: 'assistant-stream',
    frame: {
      type: 'start',
      attemptId: 'partial',
      turn: 2,
      step: 1,
      startedAfterSeq: 2,
    },
  });
  emit({
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'partial',
      index: 0,
      chunk: { type: 'text-delta', index: 0, text: 'partial before stop' },
    },
  });
  const request = { id: randomUUID() };
  let result = await f.call('/' + id + '/stop', request);
  assert.equal(result.conversation.runState.state, 'stopping');
  await f.call('/' + id + '/stop', request);
  assert.equal(f.counts().stops, 1);
  assert.equal((await f.call('/' + id)).conversation.stopPending, true);
  emit(record(3, 'turn/end', { turn: 2, reason: { kind: 'aborted' } }));
  result = await f.call('/' + id);
  assert.equal(result.conversation.stopPending, false);
  assert.equal(result.conversation.runState.state, 'stopped');
});
