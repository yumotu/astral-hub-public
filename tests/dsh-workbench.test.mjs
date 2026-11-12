import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDshSessionChannel } from '../server/dsh-session-channel.mjs';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { dshModelCatalog } from '../shared/dsh-controls.mjs';
import { applyDshFrame, emptyDshSession, dshSessionView } from '../shared/dsh-session.mjs';

function queue(first, signal) {
  const values = [first];
  let done = false,
    wake;
  const source = {
    async close() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!done) {
        if (values.length) yield values.shift();
        else
          await new Promise((r) => {
            wake = r;
          });
      }
    },
  };
  signal.addEventListener('abort', () => void source.close(), { once: true });
  return source;
}
async function fixture(t, { cold = false } = {}) {
  const db = new DatabaseSync(':memory:'),
    connectionId = randomUUID(),
    id = randomUUID(),
    calls = [],
    natives = new Map(),
    listeners = new Map();
  const actor = { id: 'alice', sessionHash: 'login-a' };
  let live = true,
    online = true,
    uncertain = '',
    contradiction = false;
  const options = ['read-only', 'workspace-write', 'danger-full-access'].map((value) => ({
    value,
    name: value,
  }));
  let selection = { provider: 'synthetic', model: 'model', reasoningEffort: 'off' },
    permission = 'workspace-write';
  const modelCatalog = {
    default: selection,
    privateKey: 'never-visible',
    groups: [
      {
        id: 'synthetic',
        name: 'Synthetic',
        models: [
          {
            id: 'model',
            name: 'Model',
            reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })) },
          },
        ],
      },
    ],
  };
  const gateway = {
    async dispatch(endpoint, { args }) {
      calls.push({ endpoint, args });
      if (uncertain === endpoint) throw Error('lost receipt');
      let value;
      if (endpoint === 'session/create') value = { sessionId: args.request.sessionId };
      else if (endpoint === 'session/modelCatalog') value = modelCatalog;
      else if (endpoint === 'permissionPresets/catalog') value = { options };
      else if (endpoint === 'skills/list')
        value = {
          skills: [
            {
              name: 'test-skill',
              description: 'A native skill',
              modelInvocable: false,
              path: '/private/secret',
            },
          ],
        };
      else if (endpoint === 'terminal/environment')
        value = { cwd: '/private/secret', maxInputBytes: 16384, maxCols: 300, maxRows: 100 };
      else if (endpoint === 'session/selectModel') {
        selection = { ...args.request };
        delete selection.sessionId;
        for (const listener of listeners.values())
          listener({
            type: 'projections',
            seq: 0,
            values: { modelSelection: { next: selection } },
          });
        value = { selected: contradiction ? { ...selection, reasoningEffort: 'off' } : selection };
      } else if (endpoint === 'commands/execute') {
        assert.match(args.line, /^\/permission (read-only|workspace-write|danger-full-access)$/);
        if (!contradiction) permission = args.line.split(' ')[1];
        value = { result: { kind: 'success' } };
      } else if (endpoint === 'session/list')
        value = {
          items: [
            {
              sessionId: id,
              projections: { values: { permissions: { currentValue: permission } } },
            },
          ],
        };
      else if (endpoint === 'terminal/create') {
        value = {
          id: args.request.id,
          title: 'Terminal',
          state: 'running',
          exitCode: null,
          cols: 80,
          rows: 15,
          cwd: '/private/secret',
        };
        natives.set(value.id, value);
      } else if (endpoint === 'terminal/write' || endpoint === 'terminal/resize') value = undefined;
      else if (endpoint === 'terminal/close') {
        natives.delete(args.id);
        value = undefined;
      } else throw Error('Unexpected ' + endpoint);
      return { ok: true, value };
    },
    async open(endpoint, { args }, signal) {
      const first =
        endpoint === '$events'
          ? { type: 'ready', clientId: 'fixture' }
          : endpoint === 'session/control'
            ? { type: 'baseline', value: { projections: {} } }
            : endpoint === 'terminal/follow'
              ? {
                  type: 'snapshot',
                  sequence: 0,
                  screen: 'native-screen',
                  info: { ...natives.get(args.id), controllerId: args.attachmentId },
                }
              : {
                  type: 'snapshot',
                  header: { id: args.request.address.sessionId },
                  cursor: -1,
                  records: [],
                  projections: {
                    asOfSeq: 0,
                    values: {
                      modelSelection: cold ? { next: null, lastUsed: null } : { next: selection },
                      permissions: { currentValue: permission },
                    },
                  },
                };
      return queue(first, signal);
    },
  };
  const channel = createDshSessionChannel(gateway, { v3: true });
  const client = { chat: () => channel };
  const config = {
    body: (req) => req.input,
    rate() {},
    live(owner, c) {
      if (!online || owner !== actor.id || c !== connectionId)
        throw Object.assign(Error('offline'), { status: 404 });
      return { state: 'ready' };
    },
    connection: async () => ({ client, peer: { deviceId: randomUUID(), location: 'computer' } }),
    catalogue: async () => ({
      host: { deviceId: 'device', location: 'computer' },
      workspaces: [{ id: 'project' }],
      sessions: [],
    }),
    appTools: {
      sessionActive: (owner, hash) =>
        live && owner === actor.id && ['login-a', 'login-b'].includes(hash),
    },
  };
  const service = createDshConversations(db, config);
  // Observe the same authenticated projection path used by the real channel.
  const watch = channel.watch.bind(channel);
  channel.watch = async (sid, listener) => {
    listeners.set(sid, listener);
    return watch(sid, listener);
  };
  const request = async (path, input, selectedActor = actor, method = input ? 'POST' : 'GET') => {
    let result;
    await service.handle(
      { method, input },
      new URL('https://hub.test/api/agent/remote/conversations' + path),
      (_, value) => {
        result = value;
      },
      selectedActor,
    );
    return result;
  };
  await request('', { id, connectionId, workspaceId: 'project' });
  t.after(async () => {
    service.close();
    await channel.close();
    db.close();
  });
  return {
    id,
    db,
    calls,
    natives,
    request,
    service,
    actor,
    gateway,
    channel,
    uncertain: (value) => {
      uncertain = value;
    },
    contradiction: () => {
      contradiction = true;
    },
    logout: () => {
      live = false;
      service.revokeAccount(actor.id);
    },
    disconnect: () => {
      online = false;
      service.disconnect(actor.id, connectionId);
    },
  };
}

test('DSH workbench catalogs expose only native model efforts, user skills and permission state, with no paths or credentials', async (t) => {
  const f = await fixture(t),
    r = await f.request('/' + f.id + '/controls');
  assert.equal(r.controls.model.reasoningEffort, 'off');
  assert.deepEqual(
    r.controls.models.groups[0].models[0].reasoning.efforts.map((e) => e.id),
    ['off', 'low', 'high', 'max'],
  );
  assert.equal(r.controls.skills[0].modelInvocable, false);
  assert.equal(r.controls.permissions.currentValue, 'workspace-write');
  assert.ok(!JSON.stringify(r).includes('/private/secret'));
  assert.ok(!JSON.stringify(r).includes('privateKey'));
  await assert.rejects(f.request('/' + f.id + '/controls', null, { ...f.actor, id: 'bob' }), {
    status: 404,
  });
  await assert.rejects(f.request('/' + f.id + '/controls', null, { id: 'alice' }), { status: 403 });
});
test('DSH native thinking and permission mutations use exact whitelisted payloads and journal once', async (t) => {
  const f = await fixture(t);
  for (const [kind, value] of [
    ['thinking', 'max'],
    ['permission', 'read-only'],
    ['permission', 'danger-full-access'],
  ]) {
    const p = { id: randomUUID(), kind, value };
    const result = await f.request('/' + f.id + '/controls', p);
    assert.equal(result.operation.state, 'accepted');
    assert.equal(
      kind === 'thinking'
        ? result.controls.model.reasoningEffort
        : result.controls.permissions.currentValue,
      value,
    );
    const count = f.calls.length;
    await f.request('/' + f.id + '/controls', p);
    assert.equal(
      f.calls
        .slice(count)
        .filter((c) => ['commands/execute', 'session/selectModel'].includes(c.endpoint)).length,
      0,
    );
    await assert.rejects(f.request('/' + f.id + '/controls', { ...p, value: 'other' }), {
      status: 409,
    });
  }
  await assert.rejects(
    f.request('/' + f.id + '/controls', { id: randomUUID(), kind: 'thinking', value: 'invented' }),
    { status: 400 },
  );
  await assert.rejects(
    f.request('/' + f.id + '/controls', {
      id: randomUUID(),
      kind: 'permission',
      value: 'danger-full-access; bash',
    }),
    { status: 400 },
  );
});
test('DSH new native sessions without a logged model selection use the actual catalog default', async (t) => {
  const f = await fixture(t, { cold: true });
  const response = await f.request('/' + f.id + '/controls', {
    id: randomUUID(),
    kind: 'thinking',
    value: 'high',
  });
  assert.equal(response.controls.model.reasoningEffort, 'high');
});

test('DSH never displays an unconfirmed native permission/model reply as a successful mutation', async (t) => {
  const f = await fixture(t);
  f.contradiction();
  for (const [kind, value] of [
    ['permission', 'danger-full-access'],
    ['thinking', 'max'],
  ]) {
    const p = { id: randomUUID(), kind, value };
    await assert.rejects(f.request('/' + f.id + '/controls', p), { status: 502 });
    assert.equal(
      f.db.prepare('SELECT state FROM dsh_actions WHERE id=?').get(p.id).state,
      'unknown',
    );
    const count = f.calls.length;
    await f.request('/' + f.id + '/controls', p);
    assert.equal(
      f.calls
        .slice(count)
        .filter((c) => ['commands/execute', 'session/selectModel'].includes(c.endpoint)).length,
      0,
    );
  }
});
test('DSH terminal creation/input belong to the exact login and terminal, and no arbitrary cwd or shell reaches the host', async (t) => {
  const f = await fixture(t),
    terminalId = randomUUID(),
    p = { id: randomUUID(), terminalId, cols: 80, rows: 15 },
    base = '/' + f.id + '/terminals';
  const created = await f.request(base, p);
  assert.equal(created.terminal.writable, true);
  assert.equal(created.terminal.chunks[0].data, 'native-screen');
  assert.ok(!JSON.stringify(created).includes('/private'));
  await f.request(base, p);
  assert.equal(f.calls.filter((c) => c.endpoint === 'terminal/create').length, 1);
  await assert.rejects(f.request(base, { ...p, id: randomUUID(), cwd: '/' }), { name: 'ZodError' });
  await assert.rejects(
    f.request(base + '/' + terminalId, null, { ...f.actor, sessionHash: 'login-b' }),
    { status: 404 },
  );
  const input = { id: randomUUID(), data: 'echo once\n' };
  await f.request(base + '/' + terminalId + '/input', input);
  await f.request(base + '/' + terminalId + '/input', input);
  assert.equal(f.calls.filter((c) => c.endpoint === 'terminal/write').length, 1);
  await assert.rejects(
    f.request(base + '/' + terminalId + '/input', { ...input, data: 'different\n' }),
    { status: 409 },
  );
  await f.request(base + '/' + terminalId + '/close', { id: randomUUID() });
  assert.equal(f.natives.size, 0);
  await assert.rejects(f.request(base + '/' + terminalId), { status: 404 });
});
test('DSH parallel terminal allocation reserves the account quota after host discovery', async (t) => {
  const f = await fixture(t),
    base = '/' + f.id + '/terminals';
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      f.request(base, { id: randomUUID(), terminalId: randomUUID(), cols: 80, rows: 15 }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
  assert.equal(f.natives.size, 8);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
});

test('DSH unknown terminal input is never replayed and disables further input on the uncertain attachment', async (t) => {
  const f = await fixture(t),
    terminalId = randomUUID(),
    base = '/' + f.id + '/terminals';
  await f.request(base, { id: randomUUID(), terminalId, cols: 80, rows: 15 });
  f.uncertain('terminal/write');
  const p = { id: randomUUID(), data: 'once\n' },
    route = base + '/' + terminalId + '/input';
  await assert.rejects(f.request(route, p), /lost receipt/);
  assert.equal((await f.request(route, p)).operation.state, 'unknown');
  await assert.rejects(f.request(route, { ...p, id: randomUUID() }), { status: 409 });
  assert.equal(f.calls.filter((c) => c.endpoint === 'terminal/write').length, 1);
  assert.equal((await f.request(base + '/' + terminalId)).terminal.writable, false);
});
for (const reason of ['logout', 'disconnect'])
  test(
    'DSH terminals revoke on ' + reason + ' without changing native Agent permission',
    async (t) => {
      const f = await fixture(t),
        terminalId = randomUUID(),
        base = '/' + f.id + '/terminals';
      await f.request(base, { id: randomUUID(), terminalId, cols: 80, rows: 15 });
      f[reason]();
      await new Promise((r) => setImmediate(r));
      assert.equal(f.natives.size, 0);
      await assert.rejects(
        f.request(base + '/' + terminalId + '/input', { id: randomUUID(), data: 'no\n' }),
      );
      assert.equal(f.calls.filter((c) => c.endpoint === 'commands/execute').length, 0);
    },
  );
test('DSH added mutations never use the retrying transfer gateway even after a too-large reply', async (t) => {
  const dispatched = [],
    gateway = {
      dispatch() {
        throw Error('retry path must not run');
      },
      open() {},
    };
  const channel = createDshSessionChannel(gateway, {
    dispatchMutation: async (endpoint) => {
      dispatched.push(endpoint);
      throw Error('unknown after execution');
    },
  });
  t.after(() => channel.close());
  await assert.rejects(
    channel.terminalCreate('s', { id: randomUUID(), cols: 80, rows: 15 }),
    /unknown/,
  );
  await assert.rejects(channel.terminalWrite('s', randomUUID(), randomUUID(), 'x'), /unknown/);
  await assert.rejects(channel.terminalResize('s', randomUUID(), randomUUID(), 80, 15), /unknown/);
  await assert.rejects(channel.terminalClose('s', randomUUID()), /unknown/);
  assert.deepEqual(dispatched, [
    'terminal/create',
    'terminal/write',
    'terminal/resize',
    'terminal/close',
  ]);
});
test('DSH model catalogs preserve provider-owned namespaced model identifiers without accepting control characters', () => {
  const catalog = {
    default: { provider: 'openrouter', model: 'vendor/model-v1' },
    groups: [
      {
        id: 'openrouter',
        name: 'Router',
        models: [{ id: 'vendor/model-v1', name: 'Model', apiKey: 'hidden' }],
      },
    ],
  };
  const parsed = dshModelCatalog.parse(catalog);
  assert.equal(parsed.groups[0].models[0].id, 'vendor/model-v1');
  assert.ok(!JSON.stringify(parsed).includes('apiKey'));
  assert.throws(() =>
    dshModelCatalog.parse({ ...catalog, default: { ...catalog.default, model: 'bad\nmodel' } }),
  );
});

test('DSH permission projections persist across a read/reconnect, reject malformed selections and omit unrelated config', () => {
  const frame = {
    type: 'snapshot',
    header: { id: 's' },
    cursor: -1,
    records: [],
    projections: {
      asOfSeq: 0,
      values: { permissions: { currentValue: 'danger-full-access', privateConfig: 'hidden' } },
    },
  };
  const state = applyDshFrame(emptyDshSession(), frame, 's');
  assert.equal(
    dshSessionView(JSON.parse(JSON.stringify(state))).permissions.currentValue,
    'danger-full-access',
  );
  assert.ok(!JSON.stringify(state).includes('privateConfig'));
  const damaged = applyDshFrame(
    state,
    { type: 'projections', seq: 1, values: { permissions: { currentValue: { allow: true } } } },
    's',
  );
  assert.equal(dshSessionView(damaged).permissions, null);
});
