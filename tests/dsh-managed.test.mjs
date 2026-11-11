import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDshRemote } from '../server/dsh-remote.mjs';
import { createRemoteIdentity, remoteFingerprint } from '../server/dsh-remote-client.mjs';

function fixture(t, extra = {}) {
  const db = new DatabaseSync(':memory:'),
    owner = randomUUID(),
    peer = createRemoteIdentity(),
    calls = [];
  db.exec(
    'CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT); CREATE TABLE sessions(user_id TEXT,hash TEXT,expires INTEGER);',
  );
  db.prepare('INSERT INTO users VALUES(?,?)').run(owner, 'owner');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
    owner,
    'synthetic-session',
    Date.now() + 600000,
  );
  const managed = {
    version: 1,
    owner,
    name: '服务器DSH',
    origin: 'http://127.0.0.1:8971',
    account: 'owner@example.test',
    password: 'synthetic-private-password',
    deviceId: peer.deviceId,
    fingerprint: remoteFingerprint(peer.publicKey),
  };
  const actor = { id: owner, role: 'owner', sessionHash: 'synthetic-session' };
  const remote = createDshRemote(db, {
    token: 'synthetic-sealing-token-123456789012345',
    body: async (r) => r.input,
    enabled: true,
    chatEnabled: true,
    allowedOrigins: [managed.origin],
    managed,
    fetch: async (url, init) => {
      calls.push(url);
      await extra.before?.(url, db);
      if (url.endsWith('/auth/login'))
        return Response.json({ token: 'synthetic-web-token-123456', account: managed.account });
      if (url.endsWith('/devices/register'))
        return Response.json({
          accessToken: 'synthetic-access-token-123456',
          refreshToken: 'synthetic-refresh-token-123456',
          accessTokenExpiresAt: Date.now() + 600000,
          refreshTokenExpiresAt: Date.now() + 1200000,
        });
      if (url.endsWith('/devices/' + peer.deviceId))
        return Response.json({
          deviceId: peer.deviceId,
          name: managed.name,
          platform: 'linux',
          membershipId: 'synthetic-membership',
          role: 'host',
          identityKey: extra.wrongPin ? createRemoteIdentity().publicKey : peer.publicKey,
        });
      throw Error('unexpected mock request');
    },
    ...extra.options,
  });
  async function req(path, input, who = actor, method = input ? 'POST' : 'GET') {
    let status, value;
    try {
      const handled = await remote.handle(
        { method, input },
        new URL('http://hub.test/api/agent/remote' + path),
        (s, v) => {
          status = s;
          value = v;
        },
        who,
      );
      return { status: handled ? status : 404, value };
    } catch (error) {
      return { status: error.status || (error.name === 'ZodError' ? 400 : 500), error };
    }
  }
  t.after(async () => {
    await remote.close();
    db.close();
  });
  return { db, remote, managed, actor, calls, req };
}
test('managed server is owner-scoped, credentials stay private and an Agent cannot authorize it', async (t) => {
  const f = fixture(t);
  const mine = await f.req('/status'),
    other = await f.req('/status', null, { id: randomUUID(), role: 'member' });
  assert.deepEqual(mine.value.managedServer, { name: '服务器DSH' });
  assert.equal(other.value.managedServer, null);
  assert.ok(!JSON.stringify(mine.value).includes(f.managed.password));
  for (const actor of [
    null,
    { ...f.actor, role: 'member' },
    { ...f.actor, id: randomUUID() },
    { id: f.actor.id, role: 'owner' },
  ])
    assert.equal((await f.req('/managed/connect', { id: randomUUID() }, actor)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.req('/managed/connect', { id: randomUUID(), origin: 'http://evil.test' })).status,
    400,
  );
});
test('managed server pins its provisioned identity and repeat association does not register again', async (t) => {
  const f = fixture(t),
    id = randomUUID();
  const first = await f.req('/managed/connect', { id });
  assert.equal(first.status, 200, first.error?.stack);
  assert.equal(first.value.connection.host.location, 'server');
  assert.equal(first.value.connection.host.fingerprint, f.managed.fingerprint);
  const count = f.calls.length,
    second = await f.req('/managed/connect', { id: randomUUID() });
  assert.equal(second.value.connection.id, id);
  assert.equal(f.calls.length, count);
  const row = f.db.prepare('SELECT * FROM dsh_remote_connections').get();
  for (const secret of [f.managed.password, 'synthetic-access-token', 'synthetic-refresh-token'])
    assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal(
    (
      await f.req('/connections', {
        id: randomUUID(),
        name: 'bypass',
        origin: f.managed.origin,
        account: f.managed.account,
        password: f.managed.password,
      })
    ).status,
    403,
  );
});
test('managed server refuses a changed host pin and never retries the unknown registration', async (t) => {
  const f = fixture(t, { wrongPin: true }),
    id = randomUUID();
  assert.equal((await f.req('/managed/connect', { id })).status, 409);
  assert.equal(f.db.prepare('SELECT secret FROM dsh_remote_connections').get().secret, null);
  const count = f.calls.length;
  assert.equal((await f.req('/managed/connect', { id })).status, 409);
  assert.equal(f.calls.length, count);
});
test('logout during registration prevents credentials being installed', async (t) => {
  const f = fixture(t, {
    before: (url, db) => {
      if (url.endsWith('/devices/register')) db.exec('DELETE FROM sessions');
    },
  });
  assert.equal((await f.req('/managed/connect', { id: randomUUID() })).status, 403);
  assert.equal(f.db.prepare('SELECT state FROM dsh_remote_connections').get().state, 'error');
});
test('withdrawn association is not revived by an old request id', async (t) => {
  const f = fixture(t),
    id = randomUUID();
  assert.equal((await f.req('/managed/connect', { id })).status, 200);
  assert.equal((await f.req('/connections/' + id, null, f.actor, 'DELETE')).status, 200);
  const n = f.calls.length;
  assert.equal((await f.req('/managed/connect', { id })).status, 409);
  assert.equal(f.calls.length, n);
});
test('closed feature gates cannot be bypassed through managed association', async (t) => {
  for (const options of [{ enabled: false }, { chatEnabled: false }]) {
    const f = fixture(t, { options });
    assert.equal((await f.req('/managed/connect', { id: randomUUID() })).status, 503);
    assert.equal(f.calls.length, 0);
  }
});
