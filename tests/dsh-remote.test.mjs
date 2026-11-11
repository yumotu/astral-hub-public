import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDshRemote } from '../server/dsh-remote.mjs';
import { createApp } from '../server/index.mjs';
import {
  createRemoteIdentity,
  remoteFingerprint,
  remoteOrigin,
} from '../server/dsh-remote-client.mjs';
import {
  generateKeyPair,
  NoiseIkSession,
  createNoisePrologue,
  SecureMessageCodec,
} from '../server/vendor/dsh-remote/client.mjs';

test('fixed Remote crypto authenticates identities, fragments real encrypted traffic and rejects tamper or replay', async () => {
  const host = generateKeyPair(),
    client = generateKeyPair();
  const prologue = createNoisePrologue(randomUUID(), 'host', 'client');
  const initiator = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: client.privateKey,
    localPublicKey: client.publicKey,
    remotePublicKey: host.publicKey,
    prologue,
  });
  const responder = new NoiseIkSession({
    role: 'responder',
    localPrivateKey: host.privateKey,
    localPublicKey: host.publicKey,
    remotePublicKey: client.publicKey,
    prologue,
  });
  try {
    responder.readHandshake(initiator.writeHandshake());
    initiator.readHandshake(responder.writeHandshake());
    const data = Buffer.alloc(180000, 87),
      encoder = new SecureMessageCodec(),
      decoder = new SecureMessageCodec();
    let result, first;
    for (const fragment of encoder.encode(data)) {
      const encrypted = initiator.encrypt(fragment);
      first ||= encrypted;
      result = decoder.decode(responder.decrypt(encrypted));
    }
    assert.deepEqual(Buffer.from(result), data);
    assert.throws(() => responder.decrypt(first));
    const fresh = initiator.encrypt(new TextEncoder().encode('not tampered'));
    fresh[0] ^= 1;
    assert.throws(() => responder.decrypt(fresh));
    const meta = JSON.parse(
      await readFile(new URL('../server/vendor/dsh-remote/UPSTREAM.json', import.meta.url)),
    );
    const bytes = await readFile(
      new URL('../server/vendor/dsh-remote/client.mjs', import.meta.url),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.bundleSha256);
    const wrong = new NoiseIkSession({
      role: 'responder',
      localPrivateKey: host.privateKey,
      localPublicKey: host.publicKey,
      remotePublicKey: generateKeyPair().publicKey,
      prologue,
    });
    const freshInitiator = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: client.privateKey,
      localPublicKey: client.publicKey,
      remotePublicKey: host.publicKey,
      prologue,
    });
    try {
      assert.throws(() => wrong.readHandshake(freshInitiator.writeHandshake()));
    } finally {
      wrong.destroy();
      freshInitiator.destroy();
    }
  } finally {
    initiator.destroy();
    responder.destroy();
  }
});

function fixture(t) {
  const db = new DatabaseSync(':memory:'),
    host = generateKeyPair(),
    otherHost = generateKeyPair(),
    id = randomUUID(),
    deviceId = randomUUID(),
    calls = [];
  let peerKey = host.publicKey,
    registrations = 0,
    opened = 0,
    gate;
  const apiFetch = async (url, init) => {
    calls.push({
      url,
      input: init.body && JSON.parse(init.body),
      token: init.headers.Authorization,
    });
    if (url.endsWith('/auth/login'))
      return Response.json({
        token: 'synthetic-web-token-123456',
        account: 'synthetic@example.test',
      });
    if (url.endsWith('/devices/register')) {
      registrations++;
      return Response.json({
        accessToken: 'synthetic-access-token-123456',
        refreshToken: 'synthetic-refresh-token-123456',
        accessTokenExpiresAt: Date.now() + 600000,
        refreshTokenExpiresAt: Date.now() + 1200000,
      });
    }
    if (url.includes('/devices?'))
      return Response.json({
        items: [
          {
            deviceId,
            name: 'Synthetic host',
            platform: 'linux',
            membershipId: 'same-account',
            online: true,
            identityKey: peerKey,
          },
        ],
        nextCursor: null,
      });
    if (url.endsWith('/devices/' + deviceId))
      return Response.json({
        deviceId,
        name: 'Synthetic host',
        platform: 'linux',
        membershipId: 'same-account',
        role: 'host',
        identityKey: peerKey,
      });
    throw Error('unexpected request');
  };
  const options = {
    token: 'synthetic-local-sealing-key-123456',
    body: async (req) => req.input,
    enabled: true,
    allowedOrigins: ['https://remote.example.test'],
    fetch: apiFetch,
    connect: async () => {
      opened++;
      await gate;
      return {
        workspaces: async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'baseline',
              value: {
                items: [
                  {
                    workspaceId: 'workspace',
                    title: 'Project',
                    path: '/private/project',
                    sessionIds: ['owned', 'child'],
                  },
                ],
              },
            };
          },
          async close() {},
        }),
        sessions: async () => ({
          items: [
            { sessionId: 'owned', title: 'Own chat', running: false, blank: false, updatedAt: 1 },
            {
              sessionId: 'child',
              parentSessionId: 'owned',
              running: false,
              blank: false,
              updatedAt: 1,
            },
            { sessionId: 'foreign', running: true, blank: false, updatedAt: 2 },
          ],
        }),
        async close() {},
      };
    },
  };
  let remote = createDshRemote(db, options);
  const call = async (path, input, owner = 'alice', method) => {
    let result, status;
    try {
      const handled = await remote.handle(
        { method: method || (input ? 'POST' : 'GET'), input },
        new URL('https://hub.example/api/agent/remote/connections' + path),
        (code, value) => {
          status = code;
          result = value;
        },
        owner ? { id: owner } : null,
      );
      return { status: handled ? status : 404, body: result };
    } catch (error) {
      return { status: error.status || (error.name === 'ZodError' ? 400 : 500), error };
    }
  };
  t.after(async () => {
    await remote.close();
    db.close();
  });
  const creation = {
    id,
    name: 'Test',
    origin: 'https://remote.example.test',
    account: 'synthetic@example.test',
    password: 'synthetic-password-12345',
  };
  return {
    db,
    call,
    id,
    deviceId,
    creation,
    calls,
    changed: () => {
      peerKey = otherHost.publicKey;
    },
    fingerprint: () => remoteFingerprint(peerKey),
    registrations: () => registrations,
    opened: () => opened,
    blockConnect() {
      let release;
      gate = new Promise((r) => {
        release = r;
      });
      return release;
    },
    async restart() {
      await remote.close();
      remote = createDshRemote(db, options);
    },
  };
}

test('Remote connections encrypt credentials, isolate owners, pin exact host identity and never repeat registration', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('', f.creation, null)).status, 403);
  assert.equal(
    (await f.call('', { ...f.creation, origin: 'https://internal.invalid' })).status,
    403,
  );
  assert.equal((await f.call('', f.creation)).status, 201);
  assert.equal((await f.call('', f.creation)).status, 409);
  assert.equal(f.registrations(), 1);
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM dsh_remote_connections').all());
  for (const secret of [
    'synthetic-password-12345',
    'synthetic-web-token',
    'synthetic-access-token',
    'synthetic-refresh-token',
  ])
    assert.ok(!stored.includes(secret));
  assert.deepEqual((await f.call('', null, 'bob')).body.connections, []);
  assert.equal((await f.call('/' + f.id + '/hosts', null, 'bob')).status, 404);
  const hosts = (await f.call('/' + f.id + '/hosts')).body.hosts;
  assert.equal(hosts[0].deviceId, f.deviceId);
  assert.equal(hosts[0].identityKey, undefined);
  const identity = (await f.call('/' + f.id + '/identity?deviceId=' + f.deviceId)).body;
  assert.equal(identity.fingerprint, f.fingerprint());
  const trust = { deviceId: f.deviceId, fingerprint: identity.fingerprint, location: 'computer' };
  assert.equal(
    (await f.call('/' + f.id + '/trust', { ...trust, fingerprint: 'A'.repeat(64) })).status,
    409,
  );
  assert.equal((await f.call('/' + f.id + '/trust', trust)).status, 200);
  await f.restart();
  const list = (await f.call('')).body.connections;
  assert.equal(list[0].host.fingerprint, trust.fingerprint);
  const catalogue = await f.call('/' + f.id + '/catalogue');
  assert.equal(catalogue.status, 200);
  assert.deepEqual(
    catalogue.body.sessions.map((x) => x.id),
    ['owned'],
  );
  assert.equal(catalogue.body.workspaces[0].path, undefined);
  assert.equal(catalogue.body.agent.capabilities.streaming.supported, false);
  await f.restart();
  f.changed();
  assert.equal((await f.call('/' + f.id + '/catalogue')).status, 409);
  assert.equal((await f.call('/' + f.id, null, 'alice', 'DELETE')).status, 200);
  assert.equal((await f.call('/' + f.id + '/hosts')).status, 404);
  assert.equal(f.db.prepare('SELECT secret FROM dsh_remote_connections').get().secret, null);
});

test('Remote origin policy blocks credentials, local-network redirects and unapproved endpoints before network access', () => {
  const origins = new Set([
    'https://remote.example.test',
    'http://127.0.0.1:9123',
    'http://192.168.1.1',
  ]);
  assert.equal(
    remoteOrigin('https://remote.example.test/', origins),
    'https://remote.example.test',
  );
  assert.equal(remoteOrigin('http://127.0.0.1:9123/', origins), 'http://127.0.0.1:9123');
  for (const value of [
    'https://user:password@remote.example.test',
    'https://remote.example.test/path',
    'https://remote.example.test?token=secret',
    'http://192.168.1.1',
    'https://169.254.169.254',
    'file:///etc/passwd',
  ])
    assert.throws(() => remoteOrigin(value, origins));
});

test('revocation during an asynchronous Remote handshake cannot publish a catalogue or resurrect saved credentials', async (t) => {
  const f = fixture(t);
  await f.call('', f.creation);
  await f.call('/' + f.id + '/trust', {
    deviceId: f.deviceId,
    fingerprint: f.fingerprint(),
    location: 'server',
  });
  const release = f.blockConnect();
  const pending = f.call('/' + f.id + '/catalogue');
  for (let i = 0; i < 100 && !f.opened(); i++) await new Promise((r) => setImmediate(r));
  assert.equal(f.opened(), 1);
  const removed = f.call('/' + f.id, null, 'alice', 'DELETE');
  release();
  assert.equal((await removed).status, 200);
  assert.ok([404, 409].includes((await pending).status));
  assert.equal(
    f.db.prepare('SELECT secret,revoked FROM dsh_remote_connections').get().secret,
    null,
  );
});

test('Remote HTTP routes require an independent account, explicit enablement and strict input before external authorization', async (t) => {
  for (const enabled of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'astral-remote-api-'));
    const token = 'synthetic-remote-api-master-token-1234567890';
    const app = await createApp({
      token,
      dataDir: dir,
      notifications: { start: false },
      dshRemote: {
        enabled,
        allowedOrigins: ['https://remote.example.test'],
        fetch: async () => assert.fail('unexpected external connection'),
      },
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    try {
      const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
      const req = async (path, data, auth) => {
        const r = await fetch(base + path, {
          method: data ? 'POST' : 'GET',
          headers: {
            ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
            ...(data ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
        });
        return { status: r.status, body: await r.json() };
      };
      const owner = (
        await req('/auth/bootstrap', {
          username: 'remoteowner',
          password: 'Synthetic-password-12345',
          displayName: 'Owner',
          adminToken: token,
        })
      ).body;
      const path = '/agent/remote/connections';
      assert.equal((await req(path)).status, 401);
      assert.equal((await req(path, null, token)).status, 403);
      const status = await req('/agent/remote/status', null, owner.token);
      assert.equal(status.status, 200);
      assert.equal(status.body.enabled, enabled);
      assert.equal(status.body.chatAvailable, false);
      assert.equal((await req('/agent/remote/conversations', null, owner.token)).status, 503);
      const result = await req(path, null, owner.token);
      assert.equal(result.status, enabled ? 200 : 503);
      if (enabled) {
        assert.deepEqual(result.body.connections, []);
        assert.equal(
          (
            await req(
              path,
              {
                id: randomUUID(),
                name: 'invalid',
                origin: 'https://internal.invalid',
                account: 'test@example.test',
                password: 'synthetic-password',
              },
              owner.token,
            )
          ).status,
          403,
        );
        assert.equal((await req(path, { backend: 'other' }, owner.token)).status, 400);
      }
    } finally {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  }
});
