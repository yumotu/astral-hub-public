import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';
import { createRemoteIdentity, remoteFingerprint } from '../server/dsh-remote-client.mjs';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { createProjectManagement } from '../server/project-management.mjs';
import { DatabaseSync } from 'node:sqlite';

function pause() {
  let reached, release;
  const ready = new Promise((r) => {
    reached = r;
  });
  const resume = new Promise((r) => {
    release = r;
  });
  return { ready, resume, reached, release };
}

// Actual HTTP/authentication/storage and native admission routes; the Pi bridge
// and trusted Remote host are deterministic fixtures and never call a model.
async function fixture(t, { location = 'computer' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-project-management-'));
  const folder = join(dir, 'actual-folder');
  await mkdir(folder);
  await writeFile(join(folder, 'kept.txt'), 'project bytes retained');
  const admin = 'synthetic-management-admin-token-1234567890';
  const peer = createRemoteIdentity(),
    sessions = new Map();
  const requests = { directories: 0, models: 0, writes: 0, creates: 0 };
  const scheduled = [];
  let offline = false,
    projectPause,
    createPause,
    scheduledAck;
  const options = {
    token: admin,
    dataDir: join(dir, 'data'),
    notifications: { start: false },
    piConfig: {
      url: 'http://synthetic-management-pi',
      token: 'synthetic-private-bridge',
      fetch: async (url, init) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: false });
        if (url.endsWith('/schedules/pending')) return Response.json({ runs: scheduled });
        if (url.endsWith('/schedules/ack')) {
          const result = JSON.parse(init.body);
          scheduled.splice(0);
          scheduledAck?.(result);
          return Response.json({ ok: true });
        }
        if (url.endsWith('/projects')) {
          const principal = JSON.parse(init.headers['X-Astral-Project-Principal']);
          if (projectPause) {
            const pause = projectPause;
            projectPause = null;
            pause.reached();
            await pause.resume;
          }
          return Response.json({
            projects: [
              {
                id: 'workspace',
                name: 'Actual folder',
                serverPath: folder,
                readOnly: false,
                memberAccess: 'read',
              },
              ...(principal.admin
                ? [{ id: 'admin-only', name: 'Private project', readOnly: false }]
                : []),
            ],
          });
        }
        requests.models++;
        throw Error('Unexpected Pi request ' + url);
      },
    },
    dshRemote: {
      enabled: true,
      chatEnabled: true,
      allowedOrigins: ['https://synthetic-management-remote.test'],
      fetch: async (url) => {
        if (url.endsWith('/auth/login'))
          return Response.json({ token: 'synthetic-web-token-123456', account: 'qa@example.test' });
        if (url.endsWith('/devices/register'))
          return Response.json({
            accessToken: 'synthetic-access-123456',
            refreshToken: 'synthetic-refresh-123456',
            accessTokenExpiresAt: Date.now() + 600000,
            refreshTokenExpiresAt: Date.now() + 1200000,
          });
        if (url.endsWith('/devices/' + peer.deviceId))
          return Response.json({
            deviceId: peer.deviceId,
            name: 'Same computer',
            platform: 'linux',
            membershipId: 'synthetic-member',
            role: 'host',
            identityKey: peer.publicKey,
          });
        throw Error('Unexpected Remote authentication request');
      },
      connect: async () => ({
        async workspaces() {
          requests.directories++;
          if (offline) throw Error('Synthetic Remote is offline');
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'baseline',
                value: {
                  items: [
                    {
                      workspaceId: 'work',
                      title: 'Remote folder',
                      path: '/private/remote-folder',
                      sessionIds: [...sessions.keys()],
                    },
                  ],
                },
              };
            },
            async close() {},
          };
        },
        async sessions() {
          return {
            items: [...sessions.keys()].map((sessionId) => ({
              sessionId,
              updatedAt: 1,
              running: false,
              blank: false,
            })),
          };
        },
        chat: () => ({
          async create(workspace, sid) {
            if (createPause) {
              const gate = createPause;
              createPause = null;
              gate.reached();
              await gate.resume;
            }
            requests.creates++;
            sessions.set(sid, []);
            return { sessionId: sid };
          },
          async watch(sid, listener) {
            listener({
              type: 'snapshot',
              header: { id: sid, version: 3 },
              cursor: -1,
              records: [],
              hasMore: false,
              projections: { asOfSeq: 0, values: {} },
            });
          },
          async prompt() {
            requests.models++;
            throw Error('No model call expected');
          },
        }),
        async close() {},
      }),
    },
  };
  let app;
  const start = async () => {
    app = await createApp(options);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  await start();
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, data, token, method) => {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'managementowner',
      password: 'Synthetic-management-password',
      displayName: 'Management owner',
      adminToken: admin,
    })
  ).body;
  const own = (path, data, method) => req(path, data, owner.token, method);
  const invite = (await own('/auth/invitations', {})).body;
  const member = (
    await req('/auth/register', {
      username: 'managementmember',
      password: 'Synthetic-management-password',
      displayName: 'Other member',
      invite: invite.code,
    })
  ).body;
  const pairing = (await own('/relay/pairing', {})).body;
  const device = (
    await req('/relay/device/enroll', {
      code: pairing.code,
      name: 'Same computer',
      platform: 'linux',
      rootLabel: 'Synthetic folder',
      allowWrite: true,
    })
  ).body;
  assert.ok(device.token);
  const projectId = randomUUID(),
    connectionId = randomUUID();
  const announce = () =>
    req(
      '/relay/device/workspace/announce',
      {
        version: 2,
        capabilities: ['conversation_handoff_v1'],
        projects: [{ id: projectId, name: 'Relay folder', allowWrite: true, allowExecute: true }],
      },
      device.token,
    );
  assert.equal((await announce()).status, 200);
  assert.equal(
    (
      await own('/agent/remote/connections', {
        id: connectionId,
        name: 'Same computer',
        origin: 'https://synthetic-management-remote.test',
        account: 'qa@example.test',
        password: 'synthetic-only',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await own('/agent/remote/connections/' + connectionId + '/trust', {
        deviceId: peer.deviceId,
        fingerprint: remoteFingerprint(peer.publicKey),
        location,
      })
    ).status,
    200,
  );
  const target = { origin: 'server', projectId: 'workspace' };
  const relayTarget = { origin: 'computer', deviceId: device.deviceId, projectId };
  const remoteTarget = { origin: 'remote', connectionId, projectId: 'work' };
  await own('/assistant/targets');
  const management = async () => {
    const r = await own('/assistant/project-management');
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.body;
  };
  const project = async (p) =>
    (await management()).projects.find(
      (v) =>
        v.target.origin === p.origin &&
        v.target.projectId === p.projectId &&
        v.target.deviceId === p.deviceId &&
        v.target.connectionId === p.connectionId,
    );
  const change = async (action, p) =>
    own('/assistant/project-management/' + action, {
      target: p,
      revision: (await project(p)).revision,
    });
  return {
    get app() {
      return app;
    },
    own,
    req,
    owner,
    member,
    device,
    target,
    relayTarget,
    remoteTarget,
    connectionId,
    requests,
    project,
    management,
    change,
    announce,
    folder,
    async reopen() {
      await stop();
      await start();
    },
    offline() {
      offline = true;
    },
    pauseNextProjectRead() {
      let reached, release;
      const ready = new Promise((resolve) => {
        reached = resolve;
      });
      const resume = new Promise((resolve) => {
        release = resolve;
      });
      projectPause = { reached, resume };
      return { ready, release };
    },
    pauseNextRemoteCreate() {
      createPause = pause();
      return createPause;
    },
    schedule(run) {
      const result = new Promise((resolve) => {
        scheduledAck = resolve;
      });
      scheduled.push(run);
      return result;
    },
  };
}

test('project removal persists across restart and heartbeats, preserves history/files, and rejects stale admissions and defaults', async (t) => {
  const f = await fixture(t),
    ids = [],
    native = {};
  assert.equal((await f.req('/assistant/project-management')).status, 401);
  for (const target of [f.target, f.relayTarget, f.remoteTarget]) {
    const id = randomUUID();
    const r = await f.own('/assistant/conversations', { id, target });
    assert.equal(r.status, 201, JSON.stringify(r));
    ids.push(id);
    native[target.origin] = r.body.conversation.active.nativeId;
  }
  assert.equal(
    (await f.own('/pi/preferences', { defaultProjectId: 'workspace' }, 'PATCH')).status,
    200,
  );
  for (const target of [f.target, f.relayTarget, f.remoteTarget]) {
    const prior = await f.project(target);
    assert.deepEqual(
      await f.project(target),
      prior,
      'repeated metadata reads must not change revisions',
    );
    const removed = await f.change('remove', target);
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.ok(removed.body.project.removedAt);
    assert.equal(
      (await f.own('/assistant/project-management/remove', { target, revision: prior.revision }))
        .status,
      409,
    );
    assert.equal(
      (await f.own('/assistant/conversations', { id: randomUUID(), target })).status,
      409,
    );
  }
  for (const route of ['/pi/tasks', '/pi/submissions', '/pi/message']) {
    const sent = await f.own(route, {
      id: randomUUID(),
      conversationId: native.server,
      input: 'must stay blocked',
      projectId: 'workspace',
    });
    assert.equal(sent.status, 409, JSON.stringify({ route, sent }));
  }
  const prompt = await f.own('/agent/remote/conversations/' + native.remote + '/prompt', {
    id: randomUUID(),
    text: 'must stay blocked',
  });
  assert.equal(prompt.status, 409, JSON.stringify(prompt));
  assert.equal(
    f.app.store.db.prepare('SELECT COUNT(*) AS n FROM dsh_actions').get().n,
    0,
    'rejected project admission must not reserve an action',
  );
  assert.equal((await f.own('/pi/preferences')).body.preferences.defaultProjectId, null);
  assert.equal(
    (await f.own('/pi/preferences', { defaultProjectId: 'workspace' }, 'PATCH')).status,
    409,
  );
  assert.equal(
    (await f.own('/pi/conversations', { id: randomUUID(), projectId: 'workspace' })).status,
    409,
  );
  assert.equal(
    (
      await f.own('/agent/remote/conversations', {
        id: randomUUID(),
        connectionId: f.connectionId,
        workspaceId: 'work',
      })
    ).status,
    409,
  );
  assert.equal((await f.announce()).status, 200);
  await f.reopen();
  const managed = await f.management();
  assert.equal(managed.projects.filter((p) => p.removedAt).length, 3);
  const directory = await f.own('/assistant/targets');
  assert.ok(
    !directory.body.targets.some((v) =>
      ['workspace', f.relayTarget.projectId, 'work'].includes(v.projectId),
    ),
  );
  const history = await f.own('/assistant/conversations?targets=deferred');
  assert.deepEqual(history.body.conversations.map((c) => c.id).sort(), ids.sort());
  const other = await f.req('/assistant/targets', undefined, f.member.token);
  assert.ok(other.body.targets.some((v) => v.origin === 'server' && v.projectId === 'workspace'));
  assert.ok(!other.body.targets.some((v) => v.origin !== 'server'));
  for (const target of [f.target, f.relayTarget, f.remoteTarget])
    assert.equal((await f.change('restore', target)).status, 200);
  assert.equal(await readFile(join(f.folder, 'kept.txt'), 'utf8'), 'project bytes retained');
  assert.equal(f.requests.models, 0);
});

test('display names and revisions are stable per target/account and reset to the real folder name', async (t) => {
  const f = await fixture(t);
  for (const target of [f.target, f.relayTarget, f.remoteTarget]) {
    const original = await f.project(target);
    const renamed = await f.own(
      '/assistant/project-management/display-name',
      { target, name: '我的项目' },
      'PUT',
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.project.name, '我的项目');
    assert.equal(renamed.body.project.originalName, original.originalName);
    for (let n = 0; n < 3; n++) assert.deepEqual(await f.project(target), renamed.body.project);
    assert.ok(renamed.body.project.revision > original.revision);
    assert.equal(
      (await f.own('/assistant/project-management/remove', { target, revision: original.revision }))
        .status,
      409,
    );
    const reset = await f.own(
      '/assistant/project-management/display-name',
      { target, name: null },
      'PUT',
    );
    assert.equal(reset.body.project.name, original.originalName);
  }
  assert.equal(
    (
      await f.req(
        '/assistant/project-management/display-name',
        { target: { origin: 'server', projectId: 'admin-only' }, name: 'Denied' },
        f.member.token,
        'PUT',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(
        '/assistant/project-management/display-name',
        { target: f.relayTarget, name: 'Denied' },
        f.member.token,
        'PUT',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.own(
        '/assistant/project-management/display-name',
        { target: { ...f.target, path: '/private' }, name: 'Denied' },
        'PUT',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.own(
        '/assistant/project-management/display-name',
        { target: f.target, name: 'a\nb' },
        'PUT',
      )
    ).status,
    400,
  );
  assert.equal(await readFile(join(f.folder, 'kept.txt'), 'utf8'), 'project bytes retained');
});

test('management stays local while Remote is offline and blocks projects with file work or unresolved native admission', async (t) => {
  const f = await fixture(t);
  const before = f.requests.directories;
  f.offline();
  assert.equal((await f.management()).computers.length, 2);
  assert.equal(f.requests.directories, before);
  const db = f.app.store.db,
    op = randomUUID(),
    at = new Date().toISOString();
  db.prepare(
    'INSERT INTO relay_operations(id,owner,device_id,project_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(op, f.owner.user.id, f.device.deviceId, f.relayTarget.projectId, '{}', 'queued', at, at);
  assert.equal((await f.change('remove', f.relayTarget)).status, 409);
  db.prepare("UPDATE relay_operations SET status='done' WHERE id=?").run(op);
  const unresolved = randomUUID();
  db.prepare('INSERT INTO assistant_switches VALUES(?,?,?,?,?,?)').run(
    f.owner.user.id,
    unresolved,
    randomUUID(),
    JSON.stringify({ target: f.target }),
    randomUUID(),
    'unknown',
  );
  assert.equal((await f.change('remove', f.target)).status, 409);
  db.prepare("UPDATE assistant_switches SET state='done' WHERE id=?").run(unresolved);
  assert.equal((await f.change('remove', f.target)).status, 200);
  assert.equal((await f.change('remove', f.remoteTarget)).status, 200);
  assert.ok((await f.change('restore', f.remoteTarget)).status >= 400);
  assert.ok(
    (await f.project(f.remoteTarget)).removedAt,
    'failed live revalidation must not restore a stale project',
  );
});

test('computer removal revokes the exact credentials, work and terminals while preserving saved account history', async (t) => {
  const f = await fixture(t),
    db = f.app.store.db;
  const history = [];
  for (const target of [f.relayTarget, f.remoteTarget]) {
    const created = await f.own('/assistant/conversations', { id: randomUUID(), target });
    assert.equal(created.status, 201, JSON.stringify(created));
    history.push(created.body.conversation);
  }
  const computers = (await f.management()).computers;
  assert.equal(computers.length, 2);
  assert.equal(new Set(computers.map((c) => c.name)).size, 1);
  const relay = computers.find((v) => v.target.origin === 'computer');
  const remote = computers.find((v) => v.target.origin === 'remote');
  assert.notEqual(relay.hostId, remote.hostId);
  const job = randomUUID(),
    completedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO relay_jobs(id,owner,device_id,project_id,conversation_id,input,access,status,output,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    job,
    f.owner.user.id,
    f.device.deviceId,
    f.relayTarget.projectId,
    history[0].active.nativeId,
    'saved input',
    'read',
    'done',
    'saved output',
    completedAt,
    completedAt,
  );
  assert.equal((await f.change('remove', f.relayTarget)).status, 200);
  const op = randomUUID(),
    term = randomUUID(),
    at = new Date().toISOString();
  db.prepare(
    'INSERT INTO relay_operations(id,owner,device_id,project_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(op, f.owner.user.id, f.device.deviceId, f.relayTarget.projectId, '{}', 'queued', at, at);
  db.prepare(
    'INSERT INTO relay_terminals(id,owner,device_id,project_id,status,cols,rows,last_seen,submission,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    term,
    f.owner.user.id,
    f.device.deviceId,
    f.relayTarget.projectId,
    'open',
    80,
    24,
    Date.now(),
    '{}',
    at,
    at,
  );
  const remove = (computer, token = f.owner.token) =>
    f.req(
      '/assistant/computer-management/remove',
      { target: computer.target, revision: computer.revision },
      token,
    );
  assert.equal((await remove(relay, f.member.token)).status, 404);
  assert.equal((await remove({ ...relay, revision: relay.revision + 1 })).status, 409);
  assert.equal((await remove(relay)).status, 200);
  assert.equal((await f.announce()).status, 401);
  assert.equal(
    db.prepare('SELECT status FROM relay_operations WHERE id=?').get(op).status,
    'cancelled',
  );
  assert.equal(
    db.prepare('SELECT status FROM relay_terminals WHERE id=?').get(term).status,
    'closed',
  );
  assert.equal(
    (await f.management()).computers.find((c) => c.target.origin === 'remote').removedAt,
    null,
  );
  const listPath =
    '/relay/conversations?deviceId=' + f.device.deviceId + '&projectId=' + f.relayTarget.projectId;
  const savedList = await f.own(listPath);
  assert.equal(savedList.status, 200, JSON.stringify(savedList));
  assert.equal(savedList.body.conversations[0].id, history[0].active.nativeId);
  assert.equal((await f.req(listPath, undefined, f.member.token)).status, 404);
  const savedJob = await f.own('/relay/jobs/' + job);
  assert.equal(savedJob.status, 200, JSON.stringify(savedJob));
  assert.equal(savedJob.body.job.output, 'saved output');
  assert.equal((await f.req('/relay/jobs/' + job, undefined, f.member.token)).status, 404);
  assert.equal(
    (await f.req('/relay/conversations/' + history[0].active.nativeId, undefined, f.member.token))
      .status,
    404,
  );
  assert.equal(
    (
      await f.own(
        '/relay/conversations/' + history[0].active.nativeId,
        { title: 'denied' },
        'PATCH',
      )
    ).status,
    404,
  );
  assert.equal((await f.own('/relay/conversations/' + history[0].active.nativeId)).status, 200);
  assert.equal((await remove(remote)).status, 200);
  const revoked = db
    .prepare('SELECT revoked,secret FROM dsh_remote_connections WHERE id=?')
    .get(f.connectionId);
  assert.equal(revoked.revoked, 1);
  assert.equal(revoked.secret, null);
  assert.equal(
    (await f.own('/agent/remote/conversations/' + history[1].active.nativeId)).status,
    200,
  );
  assert.equal((await f.change('restore', f.relayTarget)).status, 409);
  await f.reopen();
  assert.equal((await f.management()).computers.filter((c) => c.removedAt).length, 2);
  assert.equal(
    (await f.own('/assistant/conversations?targets=deferred')).body.conversations.length,
    2,
  );
  assert.equal(await readFile(join(f.folder, 'kept.txt'), 'utf8'), 'project bytes retained');
});

test('trusted server DSH connections never become removable computers', async (t) => {
  const f = await fixture(t, { location: 'server' });
  const management = await f.management();
  assert.equal(management.computers.length, 1);
  assert.equal(management.computers[0].target.origin, 'computer');
  assert.equal(
    (
      await f.own('/assistant/computer-management/remove', {
        target: { origin: 'remote', connectionId: f.connectionId },
        revision: 1,
      })
    ).status,
    400,
  );
  assert.equal(
    f.app.store.db
      .prepare('SELECT revoked FROM dsh_remote_connections WHERE id=?')
      .get(f.connectionId).revoked,
    0,
  );
});

test('project removal during asynchronous Pi directory validation prevents execution admission', async (t) => {
  const f = await fixture(t);
  for (const route of ['/pi/tasks', '/pi/submissions', '/pi/message']) {
    const created = await f.own('/assistant/conversations', { id: randomUUID(), target: f.target });
    assert.equal(created.status, 201, JSON.stringify(created));
    const gate = f.pauseNextProjectRead();
    const id = randomUUID();
    const sent = f.own(route, {
      id,
      conversationId: created.body.conversation.active.nativeId,
      input: 'blocked after async directory validation',
      projectId: 'workspace',
    });
    await gate.ready;
    try {
      assert.equal((await f.change('remove', f.target)).status, 200);
    } finally {
      gate.release();
    }
    const result = await sent;
    assert.equal(result.status, 409, JSON.stringify({ route, result }));
    assert.equal(f.app.store.db.prepare('SELECT 1 FROM pi_jobs WHERE id=?').get(id), undefined);
    assert.equal((await f.change('restore', f.target)).status, 200);
  }
  assert.equal(f.requests.models, 0);
});

test(
  'removed server projects reject new scheduled admissions without model calls',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.own('/assistant/conversations', { id: randomUUID(), target: f.target });
    assert.equal(created.status, 201);
    assert.equal((await f.change('remove', f.target)).status, 200);
    const id = randomUUID();
    const ack = await f.schedule({
      id,
      ownerId: f.owner.user.id,
      conversationId: created.body.conversation.active.nativeId,
      jobId: 'removed-project',
      jobName: 'removed project synthetic schedule',
      scheduledAt: '2026-11-16T00:00:00Z',
      input: 'must remain unexecuted',
      projectId: 'workspace',
      access: 'read',
      thinkingLevel: 'off',
      timeZone: 'UTC',
      toolAllowlist: null,
      skills: [],
      status: 'queued',
      createdAt: new Date().toISOString(),
      output: '',
      error: '',
    });
    assert.equal(ack.status, 'error');
    assert.equal(ack.disablePlan, true);
    assert.match(ack.error, /已移除/);
    assert.equal(f.app.store.db.prepare('SELECT 1 FROM pi_jobs WHERE id=?').get(id), undefined);
    assert.equal(f.app.store.db.prepare('SELECT 1 FROM pi_tasks WHERE id=?').get(id), undefined);
    assert.equal(f.requests.models, 0);
  },
);

test('pending and uncertain DSH conversation creation blocks project removal before a runtime binding exists', async (t) => {
  const f = await fixture(t),
    gate = f.pauseNextRemoteCreate(),
    id = randomUUID();
  const opening = f.own('/agent/remote/conversations', {
    id,
    connectionId: f.connectionId,
    workspaceId: f.remoteTarget.projectId,
  });
  await gate.ready;
  try {
    const blocked = await f.change('remove', f.remoteTarget);
    assert.equal(blocked.status, 409, JSON.stringify(blocked));
    assert.match(blocked.body.error, /创建结果待核对/);
    assert.equal(
      f.app.store.db
        .prepare('SELECT 1 FROM agent_conversation_bindings WHERE conversation_id=?')
        .get(id),
      undefined,
    );
  } finally {
    gate.release();
  }
  assert.equal((await opening).status, 201);
  f.app.store.db.prepare("UPDATE dsh_conversations SET state='unknown' WHERE id=?").run(id);
  assert.equal((await f.change('remove', f.remoteTarget)).status, 409);
  assert.equal(f.requests.creates, 1);
  assert.equal(f.requests.models, 0);
});

test('DSH conversation creation rechecks project eligibility after awaiting a connection', async (t) => {
  const db = new DatabaseSync(':memory:'),
    gate = pause(),
    connectionId = randomUUID(),
    id = randomUUID();
  let removed = false,
    creates = 0;
  const service = createDshConversations(db, {
    body: async (r) => r.input,
    rate() {},
    live: () => ({ state: 'ready' }),
    catalogue: async () => ({
      host: { location: 'computer', deviceId: randomUUID() },
      workspaces: [{ id: 'work' }],
      sessions: [],
    }),
    connection: async () => {
      gate.reached();
      await gate.resume;
      return {
        client: {
          chat: () => ({
            create: async () => {
              creates++;
              return { sessionId: id };
            },
          }),
        },
        peer: { location: 'computer', deviceId: randomUUID() },
      };
    },
    unified: () => ({
      assertProjectSelectable() {
        if (removed) throw Object.assign(Error('project removed'), { status: 409 });
      },
    }),
  });
  t.after(() => {
    service.close();
    db.close();
  });
  const opening = service.handle(
    { method: 'POST', input: { id, connectionId, workspaceId: 'work' } },
    new URL('http://fixture/api/agent/remote/conversations'),
    () => {},
    { id: 'synthetic-owner' },
  );
  await gate.ready;
  removed = true;
  gate.release();
  await assert.rejects(opening, { status: 409 });
  assert.equal(creates, 0);
  assert.equal(
    db.prepare('SELECT state FROM dsh_conversations WHERE id=?').get(id).state,
    'unknown',
  );
});

test('project restoration rechecks computer removal after asynchronous availability succeeds', async (t) => {
  const f = await fixture(t),
    gate = pause();
  assert.equal((await f.change('remove', f.remoteTarget)).status, 200);
  const management = createProjectManagement(f.app.store.db, {
    adapters: {
      deferredTargets: () => [f.remoteTarget],
      cachedTargets: () => [],
      nativeList: () => [],
      async available() {
        gate.reached();
        await gate.resume;
      },
    },
    relay: {},
    dshRemote: { managementConnections: () => [] },
  });
  const restoring = management.restore(f.owner.user, {
    target: f.remoteTarget,
    revision: (await f.project(f.remoteTarget)).revision,
  });
  await gate.ready;
  const computer = (await f.management()).computers.find((c) => c.target.origin === 'remote');
  try {
    assert.equal(
      (
        await f.own('/assistant/computer-management/remove', {
          target: computer.target,
          revision: computer.revision,
        })
      ).status,
      200,
    );
  } finally {
    gate.release();
  }
  await assert.rejects(restoring, { status: 409 });
  assert.ok((await f.project(f.remoteTarget)).removedAt);
  assert.equal(f.requests.models, 0);
});
