import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDshExtensions } from '../server/dsh-extensions.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE dsh_actions(owner TEXT,id TEXT,conversation_id TEXT,kind TEXT,result TEXT,state TEXT,created_at TEXT)',
  );
  const owner = { id: 'alice', role: 'owner', sessionHash: 'login-a' },
    id = randomUUID();
  let live = true,
    online = true,
    commits = 0,
    unknown = false,
    held = false,
    clock = 1000;
  const started = Promise.withResolvers();
  const actions = new Map(),
    calls = [];
  const service = createDshExtensions({
    db,
    body: (req) => req.input,
    rate() {},
    now: () => clock,
    active: (actor) =>
      live && actor.id === owner.id && ['login-a', 'login-b'].includes(actor.sessionHash),
    row(account, cid) {
      if (account !== owner.id || cid !== id)
        throw Object.assign(Error('missing'), { status: 404 });
      return { id, connection_id: 'connection-a', session_id: 'native-a' };
    },
    target() {
      if (!online) throw Object.assign(Error('offline'), { status: 403 });
    },
    ensure: async () => ({
      chat: {
        async extensions(session, input, signal) {
          calls.push(input);
          assert.equal(session, 'native-a');
          if (input.action === 'prepare')
            return { plan: input.id, title: '固定预览', target: 'skill', expiresAt: clock + 10000 };
          if (input.action === 'commit') {
            commits++;
            if (held) {
              started.resolve();
              await new Promise((resolve, reject) => {
                if (signal.aborted) reject(Error('aborted'));
                else
                  signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
              });
            }
            if (unknown) throw Error('lost response');
            return { state: 'applied' };
          }
          return { version: 1, skills: [], mcps: [], plugins: [], nativePlugins: [] };
        },
      },
    }),
    async action(account, cid, op, kind, input, run) {
      const prior = actions.get(op);
      if (prior) return prior;
      actions.set(op, { id: op, state: 'unknown' });
      const result = await run();
      db.prepare(
        'INSERT INTO dsh_actions(owner,id,conversation_id,kind,result) VALUES(?,?,?,?,?)',
      ).run(account, op, cid, kind, JSON.stringify(result));
      const state = { id: op, state: 'accepted' };
      actions.set(op, state);
      return state;
    },
  });
  t.after(() => {
    service.close();
    db.close();
  });
  return {
    service,
    owner,
    id,
    calls,
    commits: () => commits,
    hold: () => {
      held = true;
    },
    started: started.promise,
    unknown: () => {
      unknown = true;
    },
    logout: () => {
      live = false;
    },
    disconnect: () => {
      online = false;
    },
    expire: () => {
      clock += 300000;
    },
  };
}
const change = {
  kind: 'skill-save',
  name: 'qa',
  markdown: '---\nname: qa\ndescription: QA\n---\nBody',
};
test('extension preview requires current admin login and exact account/conversation; no mutation until explicit confirmation', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.prepare({ ...f.owner, role: 'member' }, f.id, change), /管理员/);
  await assert.rejects(f.service.prepare({ ...f.owner, id: 'bob' }, f.id, change));
  const p = await f.service.prepare(f.owner, f.id, change);
  assert.equal(f.commits(), 0);
  assert.equal((await f.service.catalog(f.owner, f.id)).pending.length, 1);
  await assert.rejects(
    f.service.commit({ ...f.owner, sessionHash: 'login-b' }, f.id, p.plan, randomUUID()),
    /当前登录/,
  );
  const op = randomUUID();
  await f.service.commit(f.owner, f.id, p.plan, op);
  await f.service.commit(f.owner, f.id, p.plan, op);
  assert.equal(f.commits(), 1);
  assert.equal((await f.service.catalog(f.owner, f.id)).pending.length, 0);
});
for (const condition of ['logout', 'disconnect', 'expire'])
  test(`extension preview cannot survive ${condition}`, async (t) => {
    const f = fixture(t),
      p = await f.service.prepare(f.owner, f.id, change);
    f[condition]();
    await assert.rejects(f.service.commit(f.owner, f.id, p.plan, randomUUID()));
    assert.equal(f.commits(), 0);
  });
test('extension mutation with an unknown native outcome is not repeated', async (t) => {
  const f = fixture(t),
    p = await f.service.prepare(f.owner, f.id, change),
    op = randomUUID();
  f.unknown();
  await assert.rejects(f.service.commit(f.owner, f.id, p.plan, op), /lost/);
  assert.equal((await f.service.commit(f.owner, f.id, p.plan, op)).operation.state, 'unknown');
  assert.equal(f.commits(), 1);
});
test('revoking the account aborts an in-flight extension operation and its unknown result cannot replay', async (t) => {
  const f = fixture(t),
    p = await f.service.prepare(f.owner, f.id, change),
    op = randomUUID();
  f.hold();
  const request = f.service.commit(f.owner, f.id, p.plan, op);
  await f.started;
  f.service.revoke(f.owner.id);
  await assert.rejects(request, /aborted/);
  // A revoked preview cannot be confirmed again, even under the same operation.
  await assert.rejects(f.service.commit(f.owner, f.id, p.plan, op), /预览/);
  assert.equal(f.commits(), 1);
});

test('chat requests are local, scoped and include only safe editable MCP fields', async (t) => {
  const f = fixture(t);
  const p = await f.service.prepare(f.owner, f.id, {
    kind: 'mcp-save',
    name: 'qa-mcp',
    config: {
      transport: 'streamable-http',
      url: 'https://example.test/mcp?token=hidden-query',
      headers: { Authorization: 'hidden-header' },
    },
  });
  const count = f.calls.length;
  const pending = f.service.requests(f.owner, f.id);
  assert.equal(pending.pending.length, 1);
  assert.equal(f.calls.length, count, 'chat polling must not connect to the host');
  const editable = f.service.preview(f.owner, f.id, p.plan);
  assert.equal(editable.change.config.url, 'https://example.test/mcp');
  assert.deepEqual(editable.change.config.headers, { Authorization: '' });
  assert.equal(editable.requiresCredentials, true);
  assert.ok(!JSON.stringify(editable).includes('hidden-'));
  assert.equal(f.service.requests({ ...f.owner, sessionHash: 'login-b' }, f.id).pending.length, 0);
  assert.throws(() => f.service.preview({ ...f.owner, sessionHash: 'login-b' }, f.id, p.plan));
});

test('a submitted preview cannot be resubmitted with a fresh operation ID after an unknown result', async (t) => {
  const f = fixture(t),
    p = await f.service.prepare(f.owner, f.id, change),
    op = randomUUID();
  f.unknown();
  await assert.rejects(f.service.commit(f.owner, f.id, p.plan, op));
  await assert.rejects(f.service.commit(f.owner, f.id, p.plan, randomUUID()), /原操作/);
  assert.equal(f.commits(), 1);
  assert.equal(f.service.requests(f.owner, f.id).pending.length, 0);
});

test('chat MCP credentials must be filled in the human editor before confirmation', async (t) => {
  const f = fixture(t);
  const p = await f.service.prepare(
    f.owner,
    f.id,
    {
      kind: 'mcp-save',
      name: 'qa-mcp',
      config: {
        transport: 'stdio',
        command: 'node',
        args: ['qa.mjs'],
        env: { API_KEY: '' },
      },
    },
    { fromChat: true },
  );
  assert.equal(p.needsConfiguration, true);
  await assert.rejects(f.service.commit(f.owner, f.id, p.plan, randomUUID()), /配置/);
  assert.equal(f.commits(), 0);
});

test('chat schemas keep secrets in human configuration and expose only read-only installation status', async () => {
  const { registerAppFeatures } = await import('../server/app-feature-tools.mjs');
  const registered = new Map(),
    calls = [];
  registerAppFeatures(
    { register: (tool) => registered.set(tool.name, tool) },
    {
      dshRemote: {
        extensionActor: (ctx) => ctx.actor,
        extensions: {
          prepare: (...args) => {
            calls.push(args);
            return { plan: 'synthetic-plan' };
          },
          status: (...args) => {
            calls.push(args);
            return { state: 'applied' };
          },
        },
      },
    },
  );
  const tool = registered.get('assistant.extension_change');
  const config = {
    kind: 'mcp-save',
    name: 'qa',
    config: { transport: 'stdio', command: 'node', env: { API_KEY: '' } },
  };
  assert.equal(tool.schema.safeParse({ change: config }).success, true);
  assert.equal(
    tool.schema.safeParse({
      change: { ...config, config: { ...config.config, env: { API_KEY: 'secret' } } },
    }).success,
    false,
  );
  assert.equal(
    tool.schema.safeParse({
      change: {
        ...config,
        config: { transport: 'streamable-http', url: 'https://example.test/mcp?token=secret' },
      },
    }).success,
    false,
  );
  assert.equal(tool.available({ origin: 'dsh', actor: { role: 'member' } }), false);
  assert.equal(tool.available({ origin: 'pi', actor: { role: 'owner' } }), false);
  const ctx = { origin: 'dsh', actor: { id: 'alice', role: 'owner' }, conversation: 'chat-a' };
  await tool.execute(ctx, { change: config });
  assert.deepEqual(calls[0][3], { fromChat: true });
  assert.ok(![...registered.keys()].some((n) => /extension.*(?:confirm|commit)/.test(n)));
  const status = registered.get('assistant.extension_status');
  assert.deepEqual(await status.execute(ctx, { id: randomUUID() }), { state: 'applied' });
});
