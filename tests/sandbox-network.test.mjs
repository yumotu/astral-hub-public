import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createSandboxNetwork } from '../server/sandbox-network.mjs';
import { readSandboxNetwork } from '../deploy/pi/bash-network.mjs';
import { createSandboxOperations, sandboxArgs } from '../deploy/pi/bash-sandbox.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,role TEXT)');
  const admin = { id: randomUUID(), username: 'owner', role: 'owner' },
    alice = { id: randomUUID(), username: 'alice', role: 'member' },
    bob = { id: randomUUID(), username: 'bob', role: 'member' };
  for (const actor of [admin, alice, bob])
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(actor.id, actor.username, actor.role);
  let now = Date.now();
  const notices = [];
  const service = createSandboxNetwork(db, {
    now: () => now,
    notifications: { publish: (...p) => notices.push(p) },
  });
  t.after(() => {
    service.close();
    db.close();
  });
  const call = async (actor, path, method = 'GET', input) => {
    let result;
    await service.handle(
      { method },
      new URL('http://app/api' + path),
      (status, body) => (result = { status, body }),
      actor,
      async () => input,
    );
    return result;
  };
  const internal = async (scope, method = 'GET') => {
    let result;
    await service.before(
      { method, headers: { authorization: 'Bearer ' + scope.token } },
      new URL(scope.url + '/network'),
      (status, body) => (result = { status, body }),
    );
    return result;
  };
  return { db, admin, alice, bob, service, call, internal, notices, advance: (ms) => (now += ms) };
}
test('Bash network is off by default, members request approval, scopes cannot self-authorize or cross accounts', async (t) => {
  const f = fixture(t),
    a = randomUUID(),
    b = randomUUID(),
    path = '/pi/conversations/' + a + '/network';
  const aScope = f.service.scope(f.alice.id, { id: randomUUID(), conversationId: a }),
    bScope = f.service.scope(f.bob.id, { id: randomUUID(), conversationId: b });
  assert.equal((await f.internal(aScope)).body.enabled, false);
  await assert.rejects(f.call(f.alice, path, 'PATCH', { enabled: true }), (e) => e.status === 400);
  const request = await f.call(f.alice, path, 'PATCH', {
    enabled: true,
    minutes: 15,
    acknowledged: true,
  });
  assert.equal(request.status, 202);
  assert.equal(request.body.enabled, false);
  assert.ok(request.body.request.id);
  assert.equal(
    (await f.call(f.alice, path, 'PATCH', { enabled: true, minutes: 15, acknowledged: true })).body
      .request.id,
    request.body.request.id,
  );
  assert.equal(f.notices.length, 1);
  await assert.rejects(f.call(f.alice, '/pi/network-requests'), (e) => e.status === 403);
  await assert.rejects(f.internal(aScope, 'POST'), (e) => e.status === 403);
  const requests = (await f.call(f.admin, '/pi/network-requests')).body.requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].username, 'alice');
  await assert.rejects(
    f.call(f.admin, '/pi/network-requests/' + request.body.request.id, 'POST', { approved: true }),
    (e) => e.status === 400,
  );
  await f.call(f.admin, '/pi/network-requests/' + request.body.request.id, 'POST', {
    approved: true,
    acknowledged: true,
  });
  assert.equal((await f.internal(aScope)).body.enabled, true);
  assert.equal((await f.internal(bScope)).body.enabled, false);
  await assert.rejects(
    f.call(f.admin, '/pi/network-requests/' + request.body.request.id, 'POST', {
      approved: true,
      acknowledged: true,
    }),
    (e) => e.status === 409,
  );
  await f.call(f.alice, path, 'PATCH', { enabled: false });
  assert.equal((await f.internal(aScope)).body.enabled, false);
  aScope.revoke();
  await assert.rejects(f.internal(aScope), (e) => e.status === 403);
  assert.equal((await f.internal(bScope)).body.enabled, false);
});
test('administrator grants require acknowledgment, expire and revoke on conversation/task close', async (t) => {
  const f = fixture(t),
    conversation = randomUUID(),
    id = randomUUID(),
    path = '/pi/conversations/' + conversation + '/network';
  const scope = f.service.scope(f.admin.id, { id, conversationId: conversation });
  await f.call(f.admin, path, 'PATCH', { enabled: true, minutes: 5, acknowledged: true });
  assert.equal((await f.internal(scope)).body.enabled, true);
  f.advance(5 * 60000 + 1);
  assert.equal((await f.internal(scope)).body.enabled, false);
  await f.call(f.admin, path, 'PATCH', { enabled: true, minutes: 60, acknowledged: true });
  const version = (await f.internal(scope)).body.version;
  f.service.revokeConversation(f.admin.id, conversation);
  const closed = (await f.internal(scope)).body;
  assert.equal(closed.enabled, false);
  assert.ok(closed.version > version);
  f.service.revokeTask(f.admin.id, id);
  await assert.rejects(f.internal(scope), (e) => e.status === 403);
});
test('network policy client exposes no capability token in errors and rejects invalid responses', async () => {
  assert.deepEqual(await readSandboxNetwork({ url: '', token: '' }), {
    enabled: false,
    version: 0,
    expiresAt: null,
  });
  const secret = 'synthetic-capability-private';
  let called = 0;
  const value = await readSandboxNetwork({
    url: 'http://app/api/pi/sandbox-access',
    token: secret,
    fetchImpl: async (url, options) => {
      called++;
      assert.equal(url, 'http://app/api/pi/sandbox-access/network');
      assert.equal(options.headers.Authorization, 'Bearer ' + secret);
      return Response.json({ enabled: true, version: 2, expiresAt: Date.now() + 60000 });
    },
  });
  assert.equal(value.enabled, true);
  assert.equal(called, 1);
  for (const response of [
    Response.json({ error: 'denied' }, { status: 403 }),
    Response.json({ enabled: 'yes', version: 2, expiresAt: Date.now() + 60000 }),
  ])
    await assert.rejects(
      readSandboxNetwork({ url: 'http://app', token: secret, fetchImpl: async () => response }),
      (e) => /无法核验/.test(e.message) && !e.message.includes(secret),
    );
});
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'astral-network-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projects: [{ id: 'own', root, readOnly: false }] };
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.kills++;
    setImmediate(() => child.emit('close', 137));
  };
  child.kills = 0;
  return child;
}
test('offline Bash keeps its namespace and credentials; an authorized command stops on revocation', async (t) => {
  const { root, projects } = await workspace(t);
  const offline = await sandboxArgs(projects, root, 'pwd');
  assert.ok(offline.includes('--unshare-all'));
  assert.equal(offline.includes('--share-net'), false);
  let count = 0,
    spawned;
  const child = fakeChild();
  const operations = createSandboxOperations(projects, root, {
    networkPollMs: 5,
    getNetworkPolicy: async () => ({
      enabled: ++count < 3,
      version: 1,
      expiresAt: Date.now() + 60000,
    }),
    spawnProcess: (exe, args, options) => {
      spawned = { exe, args, options };
      return child;
    },
  });
  await assert.rejects(
    operations.exec('node -e "console.log(1)"', root, { onData: () => {}, timeout: 5 }),
    /联网授权/,
  );
  assert.equal(child.kills, 1);
  assert.ok(spawned.args.indexOf('--share-net') > spawned.args.indexOf('--unshare-all'));
  assert.ok(spawned.args.includes('/etc/resolv.conf'));
  assert.deepEqual(spawned.options.env, { PATH: '/usr/local/bin:/usr/bin:/bin' });
});
test('late policy responses cannot kill a process after the original command ended', async (t) => {
  const { root, projects } = await workspace(t),
    child = fakeChild();
  let count = 0,
    release;
  const operations = createSandboxOperations(projects, root, {
    networkPollMs: 5,
    getNetworkPolicy: async () => {
      if (++count <= 2) return { enabled: true, version: 1, expiresAt: Date.now() + 60000 };
      return new Promise((r) => (release = r));
    },
    spawnProcess: () => child,
  });
  const running = operations.exec('pwd', root, { onData: () => {}, timeout: 5 });
  for (let i = 0; i < 30 && !release; i++) await pause(5);
  assert.ok(release);
  child.emit('close', 0);
  assert.deepEqual(await running, { exitCode: 0 });
  release({ enabled: false, version: 2, expiresAt: null });
  await pause(10);
  assert.equal(child.kills, 0);
});

test('HTTP network policy uses login identity and only the live task capability can read execution policy', async (t) => {
  const { createApp } = await import('../server/index.mjs'),
    root = await mkdtemp(join(tmpdir(), 'astral-network-http-'));
  let controller, payload;
  const token = 'synthetic-network-admin-'.repeat(3);
  const app = await createApp({
    token,
    dataDir: root,
    notifications: { start: false },
    piConfig: {
      url: 'http://pi',
      token: 'private-test',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: true });
        if (url.endsWith('/run/stream')) {
          payload = JSON.parse(options.body);
          return new Response(
            new ReadableStream({
              start(c) {
                controller = c;
                c.enqueue(
                  new TextEncoder().encode(JSON.stringify({ type: 'response_start' }) + '\n'),
                );
              },
            }),
            { headers: { 'Content-Type': 'application/x-ndjson' } },
          );
        }
        return Response.json({});
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const call = async (path, body, auth, method) => {
    const r = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await call('/auth/bootstrap', {
      username: 'owner',
      displayName: 'Owner',
      password: 'Synthetic-Network-Password!',
      adminToken: token,
    })
  ).body;
  const conversation = randomUUID(),
    path = '/pi/conversations/' + conversation + '/network';
  assert.equal((await call(path)).status, 401);
  assert.equal(
    (await call(path, { enabled: true, acknowledged: true, minutes: 5 }, owner.token, 'PATCH'))
      .status,
    200,
  );
  const id = randomUUID();
  assert.equal(
    (
      await call(
        '/pi/tasks',
        { id, conversationId: conversation, input: 'Synthetic task only' },
        owner.token,
      )
    ).status,
    202,
  );
  for (let i = 0; i < 50 && !payload; i++) await pause(5);
  assert.ok(payload.sandboxAccess.token);
  assert.equal((await call('/pi/sandbox-access/network', null, owner.token)).status, 403);
  assert.equal(
    (await call('/pi/sandbox-access/network', null, payload.sandboxAccess.token)).body.enabled,
    true,
  );
  assert.equal(
    (
      await call(
        '/pi/tasks',
        {
          id: randomUUID(),
          conversationId: randomUUID(),
          input: 'forged',
          sandboxAccess: payload.sandboxAccess,
        },
        owner.token,
      )
    ).status,
    400,
  );
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ type: 'done', output: 'No model invoked.', tools: [] }) + '\n',
    ),
  );
  controller.close();
  for (let i = 0; i < 50; i++) {
    const s = await call('/pi/tasks', null, owner.token);
    if (s.body.tasks.find((t) => t.id === id)?.status === 'done') break;
    await pause(5);
  }
  assert.equal(
    (await call('/pi/sandbox-access/network', null, payload.sandboxAccess.token)).status,
    403,
  );
});
