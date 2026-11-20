import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { createRemoteIdentity, remoteFingerprint } from '../server/dsh-remote-client.mjs';

// These tests exercise actual HTTP/auth/native admission routes. The Pi bridge
// and Remote host are deterministic protocol fixtures, not real model runs.
async function fixture(
  t,
  {
    location = 'computer',
    piProjects = [{ id: 'workspace', name: 'Pi project', readOnly: true }],
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-unified-api-'));
  const admin = 'synthetic-unified-admin-token-1234567890';
  const peer = createRemoteIdentity();
  const piRuns = [],
    prompts = [],
    creates = [],
    sessions = new Map(),
    watchers = new Map();
  let piHold,
    unknown = false,
    directoryHold;
  const directoryReads = [];
  const record = (seq, type, data) => ({
    type: 'event',
    event: { seq, type, time: 1000 + seq, data, surfaceOp: 'append' },
  });
  const emit = (sid, type, data) => {
    const events = sessions.get(sid) || [];
    const frame = record(events.length, type, data);
    events.push(frame);
    sessions.set(sid, events);
    watchers.get(sid)?.(frame);
  };
  const chat = {
    async create(workspace, sid) {
      creates.push({ workspace, sid });
      sessions.set(sid, []);
      return { sessionId: sid };
    },
    async watch(sid, listener) {
      watchers.set(sid, listener);
      const records = sessions.get(sid) || [];
      listener({
        type: 'snapshot',
        header: { id: sid, version: 3 },
        cursor: records.at(-1)?.event.seq ?? -1,
        records,
        hasMore: false,
        projections: { asOfSeq: records.at(-1)?.event.seq ?? 0, values: {} },
      });
    },
    async prompt(sid, id, text, mode) {
      prompts.push({ sid, id, text, mode });
      if (unknown) throw Error('Synthetic lost prompt receipt');
      emit(sid, 'turn/start', { turn: 1 });
      emit(sid, 'user/message', {
        turn: 1,
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: id },
      });
      emit(sid, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'DSH-ANSWER about the shared project' }] },
      });
      emit(sid, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
      return { accepted: true };
    },
    async cancel() {
      return { accepted: true };
    },
    async respond() {
      return { accepted: true };
    },
  };
  const app = await createApp({
    token: admin,
    dataDir: dir,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-bridge-token',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: false });
        if (url.endsWith('/projects')) return Response.json({ projects: piProjects });
        if (url.endsWith('/schedules/pending')) return Response.json({ runs: [] });
        if (url.endsWith('/run/stream')) {
          piRuns.push(JSON.parse(options.body));
          await piHold;
          return new Response(
            JSON.stringify({
              type: 'done',
              output: 'PI-ANSWER about the original project',
              tools: [],
            }) + '\n',
            { headers: { 'Content-Type': 'application/x-ndjson' } },
          );
        }
        return Response.json({});
      },
    },
    dshRemote: {
      enabled: true,
      chatEnabled: true,
      allowedOrigins: ['https://synthetic-remote.test'],
      fetch: async (url) => {
        if (url.endsWith('/auth/login'))
          return Response.json({
            token: 'synthetic-web-token-123456',
            account: 'synthetic@example.test',
          });
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
            name: 'Synthetic DSH computer',
            platform: 'linux',
            membershipId: 'synthetic-membership',
            role: 'host',
            identityKey: peer.publicKey,
          });
        throw Error('Unexpected synthetic Remote request: ' + url);
      },
      connect: async () => ({
        async workspaces() {
          directoryReads.push('workspaces');
          await directoryHold;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'baseline',
                value: {
                  items: [
                    {
                      workspaceId: 'work',
                      title: 'DSH project',
                      path: '/private/hidden',
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
        chat: () => chat,
        async close() {},
      }),
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, data, token, method) => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'unifiedowner',
      displayName: 'Synthetic owner',
      password: 'Synthetic-unified-password',
      adminToken: admin,
    })
  ).body;
  assert.ok(owner.token);
  const invitation = (await req('/auth/invitations', {}, owner.token)).body;
  const other = (
    await req('/auth/register', {
      username: 'unifiedother',
      displayName: 'Other',
      password: 'Synthetic-unified-password',
      invite: invitation.code,
    })
  ).body;
  const connectionId = randomUUID();
  assert.equal(
    (
      await req(
        '/agent/remote/connections',
        {
          id: connectionId,
          name: 'Synthetic DSH',
          origin: 'https://synthetic-remote.test',
          account: 'synthetic@example.test',
          password: 'synthetic-not-real',
        },
        owner.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await req(
        '/agent/remote/connections/' + connectionId + '/trust',
        {
          deviceId: peer.deviceId,
          fingerprint: remoteFingerprint(peer.publicKey),
          location,
        },
        owner.token,
      )
    ).status,
    200,
  );
  const own = (path, data, method) => req(path, data, owner.token, method);
  return {
    app,
    req,
    own,
    owner,
    other,
    piRuns,
    prompts,
    creates,
    connectionId,
    remoteDeviceId: peer.deviceId,
    piTarget: { origin: 'server', projectId: 'workspace' },
    dshTarget: { origin: 'remote', projectId: 'work', connectionId },
    holdPi() {
      let release;
      piHold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        piHold = undefined;
        release();
      };
    },
    loseReceipt() {
      unknown = true;
    },
    directoryReads,
    holdDirectory() {
      let release;
      directoryHold = new Promise((resolve) => {
        release = resolve;
      });
      const clear = () => {
        directoryHold = undefined;
        release();
      };
      t.after(clear);
      return clear;
    },
  };
}
async function waitTask(f, id) {
  for (let n = 0; n < 120; n++) {
    const result = await f.own('/pi/tasks');
    const task = result.body.tasks.find((task) => task.id === id);
    if (['done', 'error'].includes(task?.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Synthetic Pi task did not settle');
}
async function createPi(f) {
  const result = await f.own('/assistant/conversations', { id: randomUUID(), target: f.piTarget });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.conversation;
}
async function submitPi(f, conversation, input) {
  const id = randomUUID();
  const result = await f.own('/pi/tasks', {
    id,
    conversationId: conversation.active.nativeId,
    projectId: 'workspace',
    access: 'read',
    input,
  });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return id;
}

test('deferred history and selected Pi or paired computer creation do not wait for an unrelated DSH directory', async (t) => {
  const f = await fixture(t),
    now = Date.now(),
    deviceId = randomUUID(),
    projectId = randomUUID();
  f.app.store.db
    .prepare(
      'INSERT INTO relay_devices(id,owner,name,platform,root_label,allow_write,token_hash,expires,last_seen,created_at,capabilities) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      deviceId,
      f.owner.user.id,
      'Existing paired computer',
      'linux',
      'private-root',
      1,
      randomUUID(),
      now + 600000,
      now,
      new Date(now).toISOString(),
      '["conversation_handoff_v1"]',
    );
  f.app.store.db
    .prepare('INSERT INTO relay_projects(device_id,id,name,allow_write,allow_execute,revoked) VALUES(?,?,?,?,?,?)')
    .run(deviceId, projectId, 'Existing project', 1, 1, 0);
  f.holdDirectory();
  const prompt = async (promise) => {
    let deadline;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error('unrelated DSH directory blocked local conversation')),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const history = await prompt(f.own('/assistant/conversations?targets=deferred'));
  assert.equal(history.status, 200);
  assert.ok(history.body.targets.some((v) => v.origin === 'computer' && v.deviceId === deviceId));
  assert.equal(f.directoryReads.length, 0, 'deferred history does not start a Remote call');
  const piDirectory = await prompt(f.own('/assistant/targets?backend=pi'));
  assert.equal(piDirectory.status, 200);
  assert.ok(
    piDirectory.body.targets.some((v) => v.origin === 'server' && v.projectId === 'workspace'),
    'cold Pi directory includes authorized server folders',
  );
  assert.ok(
    piDirectory.body.targets.some((v) => v.origin === 'computer' && v.deviceId === deviceId),
  );
  assert.ok(piDirectory.body.targets.every((v) => v.origin !== 'remote'));
  assert.equal(f.directoryReads.length, 0, 'Pi directory does not start a Remote call');
  const server = await prompt(
    f.own('/assistant/conversations', { id: randomUUID(), target: f.piTarget }),
  );
  assert.equal(server.status, 201, JSON.stringify(server.body));
  const target = { origin: 'computer', deviceId, projectId };
  const computer = await prompt(f.own('/assistant/conversations', { id: randomUUID(), target }));
  assert.equal(computer.status, 201, JSON.stringify(computer.body));
  assert.equal(computer.body.conversation.active.runtime.deviceId, deviceId);
  assert.equal(f.directoryReads.length, 0, 'neither Pi target reads any DSH directory');
  for (const update of [
    { sql: 'expires=?', value: now - 1 },
    { sql: 'last_seen=?', value: now - 60000 },
    { sql: 'capabilities=?', value: '[]' },
  ]) {
    f.app.store.db
      .prepare('UPDATE relay_devices SET ' + update.sql + ' WHERE id=?')
      .run(update.value, deviceId);
    const denied = await prompt(f.own('/assistant/conversations', { id: randomUUID(), target }));
    assert.equal(denied.status, 409, update.sql + ' must invalidate the formerly available target');
    f.app.store.db
      .prepare('UPDATE relay_devices SET expires=?,last_seen=?,capabilities=? WHERE id=?')
      .run(now + 600000, now, '["conversation_handoff_v1"]', deviceId);
  }
  assert.equal(
    f.app.store.db
      .prepare('SELECT COUNT(*) AS n FROM relay_devices WHERE owner=?')
      .get(f.owner.user.id).n,
    1,
    'conversation creation reuses the existing paired device',
  );
  f.app.store.db
    .prepare('UPDATE relay_projects SET revoked=1 WHERE device_id=? AND id=?')
    .run(deviceId, projectId);
  const denied = await prompt(f.own('/assistant/conversations', { id: randomUUID(), target }));
  assert.equal(denied.status, 409);
  const other = await prompt(
    f.req('/assistant/conversations', { id: randomUUID(), target }, f.other.token),
  );
  assert.equal(other.status, 409);
  const after = await prompt(f.own('/assistant/conversations?targets=deferred'));
  assert.equal(after.body.conversations.length, 2);
  assert.ok(!after.body.targets.some((v) => v.origin === 'computer'));
});

test('independent target endpoint is authenticated, owner scoped and validates the selected DSH workspace', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req('/assistant/targets')).status, 401);
  const targets = await f.own('/assistant/targets');
  assert.equal(targets.status, 200, JSON.stringify(targets.body));
  assert.ok(
    targets.body.targets.some((v) => v.origin === 'remote' && v.connectionId === f.connectionId),
  );
  assert.ok(f.directoryReads.length > 0);
  const piOnly = await f.own('/assistant/targets?backend=pi');
  assert.equal(piOnly.status, 200);
  assert.ok(piOnly.body.targets.every((v) => v.origin !== 'remote'));
  const cached = await f.own('/assistant/targets');
  assert.ok(
    cached.body.targets.some((v) => v.origin === 'remote' && v.connectionId === f.connectionId),
    'Pi-only reads must not replace the full cached directory',
  );
  const reads = f.directoryReads.length;
  const rejected = await f.own('/assistant/conversations', {
    id: randomUUID(),
    target: { ...f.dshTarget, projectId: 'missing' },
  });
  assert.equal(rejected.status, 409);
  assert.ok(
    f.directoryReads.length > reads,
    'selected DSH target is checked freshly despite a warm UI directory',
  );
  assert.equal(f.creates.length, 0);
  const other = await f.req('/assistant/targets', undefined, f.other.token);
  assert.equal(other.status, 200);
  assert.ok(!other.body.targets.some((v) => v.origin === 'remote'));
});

test('server target directory uses source projects as folders without duplicate levels', async (t) => {
  const f = await fixture(t, {
    piProjects: [
      { id: 'workspace', name: '服务器项目目录', source: true, readOnly: false },
      {
        id: 'users',
        name: 'users',
        source: false,
        sourceId: 'workspace',
        readOnly: false,
      },
      { id: 'astral-hub', name: '星屿应用源码', source: true, readOnly: false },
    ],
  });
  const response = await f.own('/assistant/targets?backend=pi');
  assert.equal(response.status, 200);
  const projects = response.body.targets.filter((target) => target.origin === 'server');
  const workspace = projects.find((target) => target.projectId === 'workspace');
  const users = projects.find((target) => target.projectId === 'users');
  const source = projects.find((target) => target.projectId === 'astral-hub');
  assert.deepEqual(
    {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
    },
    { workspaceId: 'workspace', workspaceName: '服务器项目目录' },
  );
  assert.deepEqual(
    { workspaceId: users.workspaceId, workspaceName: users.workspaceName },
    { workspaceId: 'workspace', workspaceName: '服务器项目目录' },
  );
  assert.deepEqual(
    { workspaceId: source.workspaceId, workspaceName: source.workspaceName },
    { workspaceId: 'astral-hub', workspaceName: '星屿应用源码' },
  );
});

for (const location of ['server', 'computer'])
  test(`unified target directory preserves ${location} DSH location and distinct same-name computer identities without private metadata`, async (t) => {
    const f = await fixture(t, { location });
    const projectId = randomUUID(),
      first = randomUUID(),
      second = randomUUID(),
      now = Date.now();
    const insertDevice = f.app.store.db.prepare(
      'INSERT INTO relay_devices(id,owner,name,platform,root_label,allow_write,token_hash,expires,last_seen,created_at,capabilities) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const [id, owner, lastSeen] of [
      [first, f.owner.user.id, now],
      [second, f.owner.user.id, now],
      [randomUUID(), f.other.user.id, now],
      [randomUUID(), f.owner.user.id, now - 60000],
    ]) {
      insertDevice.run(
        id,
        owner,
        'Same computer name',
        'linux',
        '/private/relay-root',
        1,
        randomUUID(),
        now + 600000,
        lastSeen,
        new Date(now).toISOString(),
        '["conversation_handoff_v1"]',
      );
      f.app.store.db
        .prepare('INSERT INTO relay_projects(device_id,id,name,allow_write,allow_execute,revoked) VALUES(?,?,?,?,?,?)')
        .run(id, projectId, 'Same project name', 1, 1, 0);
    }
    const result = await f.own('/assistant/conversations');
    assert.equal(result.status, 200);
    const targets = result.body.targets;
    assert.equal(targets.filter((target) => target.origin === 'server').length, 2);
    assert.ok(
      targets
        .filter((target) => target.origin === 'server')
        .every((target) => target.location === 'server'),
    );
    assert.deepEqual(
      targets
        .filter((target) => target.origin === 'computer')
        .sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
      [first, second].sort().map((id) => ({
        origin: 'computer',
        deviceId: id,
        location: 'computer',
        hostId: id,
        projectId,
        workspaceId: id,
        workspaceName: '本机工作区',
        locationName: 'Same computer name',
        projectName: 'Same project name',
      })),
    );
    assert.deepEqual(
      targets.filter((target) => target.origin === 'remote'),
      [
        {
          origin: 'remote',
          connectionId: f.connectionId,
          location,
          hostId: f.remoteDeviceId,
          projectId: 'work',
          locationName: 'Synthetic DSH computer',
          projectName: 'DSH project',
        },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(targets),
      /private|synthetic-access|synthetic-web|token_hash/,
    );
    assert.deepEqual(f.piRuns, []);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.creates, []);
  });

test('unified HTTP directory preserves ownership, defaults, immutable segments and Pi → DSH → Pi visible context without replay', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req('/assistant/conversations')).status, 401);
  let conversation = await createPi(f);
  const stableId = conversation.id,
    originalPi = conversation.active.nativeId;
  const firstTask = await submitPi(
    f,
    conversation,
    'PI-ORIGINAL question about the shared project',
  );
  assert.equal((await waitTask(f, firstTask)).status, 'done');
  assert.equal(
    (await f.own('/assistant/preferences', { defaultBackend: 'dsh' }, 'PATCH')).status,
    200,
  );
  assert.equal(
    (await f.own('/assistant/conversations')).body.conversations[0].active.runtime.backend,
    'pi',
  );
  assert.equal(
    (await f.req('/assistant/conversations', undefined, f.other.token)).body.preferences
      .defaultBackend,
    'pi',
  );
  assert.equal(
    (
      await f.req(
        '/assistant/conversations/' + stableId,
        { title: 'Stolen' },
        f.other.token,
        'PATCH',
      )
    ).status,
    404,
  );
  await f.own(
    '/assistant/conversations/' + stableId,
    { title: 'Unified shared title', pinned: true },
    'PATCH',
  );
  const switchId = randomUUID(),
    switchPayload = { id: switchId, target: f.dshTarget };
  const switched = await f.own('/assistant/conversations/' + stableId + '/switch', switchPayload);
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  conversation = switched.body.conversation;
  assert.equal(conversation.id, stableId);
  assert.equal(conversation.title, 'Unified shared title');
  assert.ok(conversation.pinnedAt);
  assert.equal(conversation.active.runtime.backend, 'dsh');
  assert.equal(conversation.segments[0].nativeId, originalPi);
  assert.equal(
    (await f.own('/assistant/conversations/' + stableId + '/switch', switchPayload)).status,
    200,
  );
  assert.equal(
    f.creates.length,
    1,
    'an idempotent engine switch cannot create a second native session',
  );
  const stale = await f.own('/pi/tasks', {
    id: randomUUID(),
    conversationId: originalPi,
    projectId: 'workspace',
    input: 'Do not run the old segment',
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const dshId = conversation.active.nativeId,
    promptId = randomUUID();
  const sent = await f.own('/agent/remote/conversations/' + dshId + '/prompt', {
    id: promptId,
    text: 'DSH-FOLLOWUP user message',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].text, /PI-ORIGINAL/);
  assert.match(f.prompts[0].text, /PI-ANSWER/);
  const nativeView = (await f.own('/agent/remote/conversations/' + dshId)).body.conversation;
  assert.equal(
    nativeView.messages.find((m) => m.role === 'user').text,
    'DSH-FOLLOWUP user message',
    'internal handoff and presentation rules stay out of visible human input',
  );
  const back = await f.own('/assistant/conversations/' + stableId + '/switch', {
    id: randomUUID(),
    target: f.piTarget,
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  conversation = back.body.conversation;
  assert.equal(conversation.id, stableId);
  assert.equal(conversation.segments.length, 3);
  assert.notEqual(
    conversation.active.nativeId,
    originalPi,
    'switching back cannot reuse a stale native context',
  );
  const nextTask = await submitPi(f, conversation, 'PI-RETURN user message');
  assert.equal((await waitTask(f, nextTask)).status, 'done');
  assert.equal(f.piRuns.length, 2);
  const history = JSON.stringify(f.piRuns[1].history);
  for (const content of ['PI-ORIGINAL', 'PI-ANSWER', 'DSH-FOLLOWUP', 'DSH-ANSWER'])
    assert.ok(history.includes(content), content);
  assert.doesNotMatch(history, /星屿回复排版约定|本次用户内容/);
  const directory = await f.own('/assistant/conversations');
  assert.equal(
    directory.body.conversations.length,
    1,
    'all native segments belong to one visible chat',
  );
  assert.equal(directory.body.conversations[0].active.nativeId, conversation.active.nativeId);
  assert.deepEqual(
    (await f.req('/assistant/conversations', undefined, f.other.token)).body.conversations,
    [],
  );
});

test('unified switch refuses active Pi work and unknown DSH acceptance without invoking another model or replaying an operation', async (t) => {
  const f = await fixture(t);
  let conversation = await createPi(f);
  const release = f.holdPi();
  t.after(release);
  const task = await submitPi(f, conversation, 'Hold this original Pi task');
  const busy = await f.own('/assistant/conversations/' + conversation.id + '/switch', {
    id: randomUUID(),
    target: f.dshTarget,
  });
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  assert.equal(f.creates.length, 0);
  release();
  assert.equal((await waitTask(f, task)).status, 'done');
  const switched = await f.own('/assistant/conversations/' + conversation.id + '/switch', {
    id: randomUUID(),
    target: f.dshTarget,
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  conversation = switched.body.conversation;
  f.loseReceipt();
  const prompt = { id: randomUUID(), text: 'UNKNOWN-ACCEPTANCE must never replay' };
  const path = '/agent/remote/conversations/' + conversation.active.nativeId + '/prompt';
  assert.equal((await f.own(path, prompt)).status, 500);
  const retry = await f.own(path, prompt);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.operation.state, 'unknown');
  assert.equal(f.prompts.length, 1);
  const denied = await f.own('/assistant/conversations/' + conversation.id + '/switch', {
    id: randomUUID(),
    target: f.piTarget,
  });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.equal(
    (await f.own('/assistant/conversations')).body.conversations[0].active.runtime.backend,
    'dsh',
  );
  assert.equal(f.piRuns.length, 1);
});
