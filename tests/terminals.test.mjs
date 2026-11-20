import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminals } from '../server/terminals.mjs';
import { createTerminalRuntime } from '../deploy/pi/terminal-runtime.mjs';
const owner = randomUUID(),
  other = randomUUID(),
  taskId = randomUUID(),
  conversationId = randomUUID();
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT);');
  db.prepare('INSERT INTO users VALUES(?,?)').run(owner, 'owner');
  let time = Date.now();
  const calls = [],
    events = [];
  const transport = {
    url: 'http://private-host',
    token: 'private-only',
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return Response.json({ output: 'approved command result', exitCode: 0 });
    },
  };
  const options = {
    body: async (req) => req.data,
    pi: transport,
    host: transport,
    now: () => time,
  };
  const service = createTerminals(db, options),
    scope = service.scope(owner, { id: taskId, conversationId }, (event) => events.push(event));
  async function request(path, data, token = scope.token, method) {
    let status, value;
    await service.before(
      {
        method: method || (data ? 'POST' : 'GET'),
        headers: { authorization: 'Bearer ' + token },
        data,
      },
      new URL('http://app/api/pi/host-access' + path),
      (s, v) => {
        status = s;
        value = v;
      },
    );
    return { status, value };
  }
  t.after(() => {
    service.close();
    db.close();
  });
  return {
    service,
    scope,
    request,
    calls,
    events,
    db,
    options,
    tick: (delta) => {
      time += delta;
    },
  };
}
const command = {
  callId: 'tool-call-one',
  target: 'server',
  command: 'pwd',
  cwd: '/opt/astral-hub',
  reason: '确认服务器主机目录',
  timeout: 1000,
};
test('host execution requires an exact, account-owned, one-use approval and cannot be invoked by a normal API token', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.request('/request', command, 'wrong'), { status: 401 });
  const created = await f.request('/request', command);
  assert.equal(created.status, 201);
  const id = created.value.id;
  assert.match(f.events[0].message, /root/);
  assert.match(f.events[0].message, /pwd/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.request('/' + id + '/execute', {}), { status: 409 });
  await assert.rejects(
    f.service.respond(other, { id: taskId }, { id: 'access:' + id, confirmed: true }),
    { status: 404 },
  );
  await f.service.respond(owner, { id: taskId }, { id: 'access:' + id, confirmed: true });
  await assert.rejects(
    f.service.respond(owner, { id: taskId }, { id: 'access:' + id, confirmed: true }),
    { status: 409 },
  );
  const result = await f.request('/' + id + '/execute', {});
  assert.equal(result.value.exitCode, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].ownerId, owner);
  assert.equal(f.calls[0].command, 'pwd');
  await assert.rejects(f.request('/' + id + '/execute', {}), { status: 409 });
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.request('/request', { ...command, ownerId: other }),
    (e) => e.name === 'ZodError',
  );
});
test('denial, expiry, changed commands and process restarts do not grant host access', async (t) => {
  const f = fixture(t),
    created = await f.request('/request', command),
    id = created.value.id;
  assert.equal((await f.request('/request', command)).value.id, id);
  assert.equal(f.events.length, 1);
  await assert.rejects(f.request('/request', { ...command, command: 'whoami' }), { status: 409 });
  await f.service.respond(owner, { id: taskId }, { id: 'access:' + id, confirmed: false });
  await assert.rejects(f.request('/' + id + '/execute', {}), { status: 409 });
  const second = (await f.request('/request', { ...command, callId: 'second' })).value.id;
  f.tick(6 * 60000);
  assert.equal((await f.request('/' + second + '/status')).value.state, 'expired');
  await assert.rejects(f.request('/' + second + '/execute', {}), { status: 409 });
  assert.equal(f.calls.length, 0);
  const third = (await f.request('/request', { ...command, callId: 'third' })).value.id;
  await f.service.respond(owner, { id: taskId }, { id: 'access:' + third, confirmed: true });
  const restarted = createTerminals(f.db, f.options);
  assert.equal(
    f.db.prepare('SELECT state FROM host_access_requests WHERE id=?').get(third).state,
    'interrupted',
  );
  restarted.close();
  await f.service.revoke(owner, taskId);
  await assert.rejects(f.request('/' + third + '/execute', {}), { status: 401 });
});
test('human terminals require an independent owner and cannot inject another account into the runtime', async (t) => {
  const f = fixture(t),
    url = new URL('http://app/api/terminals/server');
  await assert.rejects(
    f.service.handle({ method: 'POST', data: { cols: 80, rows: 24 } }, url, () => {}, {
      id: other,
      role: 'member',
    }),
    { status: 403 },
  );
  await assert.rejects(
    f.service.handle(
      { method: 'POST', data: { cols: 80, rows: 24, ownerId: other } },
      url,
      () => {},
      { id: owner, role: 'owner' },
    ),
    (e) => e.name === 'ZodError',
  );
  await f.service.handle({ method: 'POST', data: { cols: 80, rows: 24 } }, url, () => {}, {
    id: owner,
    role: 'owner',
  });
  assert.equal(f.calls[0].ownerId, owner);
  assert.equal(f.calls[0].action, 'open');
});
test('PTY output survives reconnect, input and resize are forwarded, and another owner cannot read a session', async (t) => {
  let data,
    exit,
    written = '',
    size;
  const fake = {
    spawn: () => ({
      onData: (fn) => {
        data = fn;
      },
      onExit: (fn) => {
        exit = fn;
      },
      write: (s) => {
        written += s;
      },
      resize: (c, r) => {
        size = [c, r];
      },
      kill: () => exit({ exitCode: 0 }),
    }),
  };
  const home = await mkdtemp(join(tmpdir(), 'astral-terminal-test-'));
  const runtime = await createTerminalRuntime({
    pty: fake,
    target: 'pi',
    homeRoot: home,
    defaultCwd: '/tmp',
  });
  t.after(async () => {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  });
  const session = await runtime.handle({ action: 'open', ownerId: owner });
  data('first\r\n');
  data('second\r\n');
  let read = await runtime.handle({
    action: 'read',
    ownerId: owner,
    sessionId: session.id,
    after: 0,
  });
  assert.equal(read.chunks.length, 2);
  await assert.rejects(runtime.handle({ action: 'read', ownerId: other, sessionId: session.id }), {
    status: 404,
  });
  await runtime.handle({ action: 'input', ownerId: owner, sessionId: session.id, data: 'pwd\r' });
  assert.equal(written, 'pwd\r');
  await runtime.handle({
    action: 'resize',
    ownerId: owner,
    sessionId: session.id,
    cols: 100,
    rows: 30,
  });
  assert.deepEqual(size, [100, 30]);
  data('third');
  read = await runtime.handle({
    action: 'read',
    ownerId: owner,
    sessionId: session.id,
    after: read.cursor,
  });
  assert.equal(read.chunks[0].data, 'third');
  await runtime.handle({ action: 'close', ownerId: owner, sessionId: session.id });
  assert.equal((await runtime.handle({ action: 'list', ownerId: owner })).sessions[0].closed, true);
});
test('automatic approvals execute once, retain review evidence and are invalidated before execution after revocation', async (t) => {
  const f = fixture(t),
    url = new URL(`http://app/api/pi/approval-policies/${conversationId}`),
    actor = { id: owner, role: 'owner' };
  await f.service.handle(
    { method: 'PATCH', data: { mode: 'assist', targets: ['server'], minutes: 15 } },
    url,
    () => {},
    actor,
  );
  const created = await f.request('/request', command);
  assert.equal(created.status, 201);
  assert.equal(f.events.length, 0);
  const id = created.value.id;
  assert.equal((await f.request('/' + id + '/execute', {})).status, 200);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.request('/' + id + '/execute', {}), { status: 409 });
  const second = (await f.request('/request', { ...command, callId: 'revoke-me' })).value.id;
  await f.service.handle({ method: 'PATCH', data: { mode: 'manual' } }, url, () => {}, actor);
  await assert.rejects(f.request('/' + second + '/execute', {}), { status: 409 });
  assert.equal(f.calls.length, 1);
  const audit = f.db.prepare("SELECT * FROM terminal_audit WHERE action LIKE '%assist%'").all();
  assert.ok(audit.length);
});
