import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { agentRuntimeSchema, agentCapabilities, agentRunState } from '../shared/agent-runtime.mjs';
import {
  createAgentBindings,
  serverPiRuntime,
  computerPiRuntime,
} from '../server/agent-bindings.mjs';
import { createAgentDrivers } from '../server/agent-drivers.mjs';
import { createPiTasks } from '../server/pi-tasks.mjs';

test('runtime bindings preserve account and native session boundaries across reopen without moving a conversation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createAgentBindings(db),
      id = randomUUID(),
      server = serverPiRuntime('alice', id, 'workspace'),
      computer = computerPiRuntime(randomUUID(), randomUUID(), id);
    assert.deepEqual(store.bind('alice', 'server', id, server), server);
    assert.deepEqual(store.bind('alice', 'computer', id, computer), computer);
    assert.equal(store.get('bob', 'server', id), null);
    const reopened = createAgentBindings(db);
    assert.deepEqual(reopened.get('alice', 'server', id), server);
    assert.deepEqual(reopened.get('alice', 'computer', id), computer);
    for (const changed of [
      { ...server, projectId: 'other' },
      { ...server, backend: 'dsh' },
      { ...server, sessionKey: 'other-session' },
    ])
      assert.throws(() => reopened.bind('alice', 'server', id, changed), { status: 409 });
    assert.notEqual(server.sessionKey, serverPiRuntime('bob', id, 'workspace').sessionKey);
    assert.deepEqual(reopened.bind('alice', 'server', id, server), server);
  } finally {
    db.close();
  }
});

test('runtime schema rejects credentials, malformed targets and unknown routes rather than expanding authority', () => {
  const runtime = serverPiRuntime('alice', randomUUID());
  for (const value of [
    { ...runtime, backend: 'other' },
    { ...runtime, token: 'secret' },
    { ...runtime, deviceId: randomUUID() },
    { ...runtime, transport: 'dsh-remote' },
    { ...runtime, projectId: '../outside' },
    { ...runtime, location: 'computer' },
  ])
    assert.equal(agentRuntimeSchema.safeParse(value).success, false);
});

test('driver routing uses the persisted backend and never replays work in Pi when DSH is disabled or absent', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const bindings = createAgentBindings(db),
      conversationId = randomUUID(),
      runtime = serverPiRuntime('alice', conversationId, 'workspace'),
      task = { conversationId, projectId: 'workspace', runtime };
    bindings.bind('alice', 'server', conversationId, runtime);
    const calls = [];
    const adapter = {
      backend: 'pi',
      transport: 'server',
      available: () => true,
      run: (owner, input, emit) => {
        calls.push([owner, input.conversationId]);
        emit({ type: 'text_delta', delta: 'synthetic' });
        return { output: 'synthetic' };
      },
      cancel: () => 'stopped',
    };
    const drivers = createAgentDrivers({ bindings, adapters: [adapter] }),
      events = [];
    assert.equal(drivers.available('alice', task), true);
    assert.deepEqual(
      drivers.invoke('run', 'alice', task, (e) => events.push(e)),
      {
        output: 'synthetic',
      },
    );
    assert.equal(events[0].delta, 'synthetic');
    assert.equal(drivers.available('bob', task), false);
    assert.throws(() => drivers.invoke('cancel', 'bob', task), { status: 409 });
    assert.throws(() => drivers.invoke('run', 'alice', { ...task, projectId: 'other' }), {
      status: 409,
    });
    assert.throws(() => drivers.invoke('constructor', 'alice', task), { status: 400 });
    assert.throws(() => drivers.invoke('respond', 'alice', task), { status: 503 });
    const dshId = randomUUID(),
      dshRuntime = { ...serverPiRuntime('alice', dshId), backend: 'dsh' };
    bindings.bind('alice', 'server', dshId, dshRuntime);
    const dshTask = { conversationId: dshId, projectId: null, runtime: dshRuntime };
    assert.equal(drivers.available('alice', dshTask), false);
    assert.throws(() => drivers.invoke('run', 'alice', dshTask), { status: 503 });
    const enabledWithoutAdapter = createAgentDrivers({
      bindings,
      adapters: [adapter],
      dshEnabled: true,
    });
    assert.throws(() => enabledWithoutAdapter.invoke('run', 'alice', dshTask), { status: 503 });
    assert.equal(calls.length, 1);
  } finally {
    db.close();
  }
});

test('unified run states distinguish stale questions, lost transport, unconfirmed stop and true terminal results', () => {
  assert.equal(agentRunState({ status: 'running', phase: '已完成' }).state, 'executing');
  const waiting = { status: 'running', uiRequests: [{ status: 'pending' }] };
  assert.equal(agentRunState(waiting).state, 'waiting');
  assert.equal(agentRunState(waiting).spinning, false);
  assert.equal(
    agentRunState({ status: 'running', phase: '等待你的回复', uiRequests: [] }).label,
    '正在执行',
  );
  assert.equal(agentRunState({ ...waiting, connection: 'reconnecting' }).state, 'disconnected');
  assert.equal(agentRunState({ status: 'cancelled', stopPending: true }).state, 'stopping');
  assert.equal(agentRunState({ status: 'cancelled', stopPending: false }).state, 'stopped');
  assert.equal(agentRunState({ status: 'interrupted' }).state, 'unknown');
  assert.equal(agentRunState({ status: 'future-status' }).state, 'unknown');
  assert.equal(agentRunState({ status: 'done', connection: 'reconnecting' }).state, 'complete');
  assert.equal(agentRunState({ status: 'error', phase: '已完成' }).state, 'failed');
});

test('capabilities default to unavailable with explanations and never use truthy unknown flags', () => {
  const capabilities = agentCapabilities({ streaming: true, thinking: 'true', shell: true });
  assert.equal(capabilities.streaming.supported, true);
  assert.equal(capabilities.thinking.supported, false);
  assert.ok(capabilities.attachments.reason);
  assert.equal(capabilities.shell, undefined);
  const offline = agentCapabilities({ attachments: true }, '目标电脑离线。');
  assert.equal(offline.attachments.supported, false);
  assert.equal(offline.attachments.reason, '目标电脑离线。');
});

test('DSH Remote server hosts retain their connection identity and cannot reuse a computer or Pi binding', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const bindings = createAgentBindings(db),
      id = randomUUID(),
      runtime = {
        version: 1,
        backend: 'dsh',
        transport: 'dsh-remote',
        location: 'server',
        deviceId: randomUUID(),
        connectionId: randomUUID(),
        projectId: 'remote-project',
        sessionKey: randomUUID(),
      },
      task = { conversationId: id, projectId: runtime.projectId, runtime };
    bindings.bind('alice', 'remote', id, runtime);
    assert.throws(() => bindings.bind('alice', 'server', id, runtime), { status: 409 });
    const drivers = createAgentDrivers({
      bindings,
      dshEnabled: true,
      adapters: [
        {
          backend: 'dsh',
          transport: 'dsh-remote',
          available: () => true,
          run: () => ({ output: 'synthetic remote result' }),
        },
      ],
    });
    assert.equal(drivers.available('alice', task), true);
    assert.equal(drivers.invoke('run', 'alice', task).output, 'synthetic remote result');
    assert.throws(
      () =>
        drivers.invoke('run', 'alice', {
          ...task,
          runtime: { ...runtime, connectionId: randomUUID() },
        }),
      { status: 409 },
    );
  } finally {
    db.close();
  }
});

test('Pi task snapshots and event replay retain their bound runtime while incompatible stored overrides cannot run', async () => {
  const db = new DatabaseSync(':memory:');
  const tasks = createPiTasks(db, { available: () => false, completed: () => false });
  try {
    const id = randomUUID(),
      conversationId = randomUUID(),
      task = tasks.add('alice', { id, conversationId, input: 'synthetic', mode: 'queue' });
    const replay = await tasks.changes('alice', 0, {}, { destroyed: false });
    assert.deepEqual(replay.events[0].event.task.runtime, task.runtime);
    assert.deepEqual(replay.events[0].event.task.runState, task.runState);
    const stored = JSON.parse(
      db.prepare('SELECT payload FROM pi_tasks WHERE id=?').get(id).payload,
    );
    db.prepare('UPDATE pi_tasks SET payload=? WHERE id=?').run(
      JSON.stringify({ ...stored, runtime: { ...stored.runtime, backend: 'dsh' } }),
      id,
    );
    assert.throws(() => tasks.get('alice', id), { status: 409 });
  } finally {
    tasks.close();
    db.close();
  }
});
