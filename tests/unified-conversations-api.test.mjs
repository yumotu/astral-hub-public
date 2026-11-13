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
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-unified-api-'));
  const admin = 'synthetic-unified-admin-token-1234567890';
  const peer = createRemoteIdentity();
  const piRuns = [],
    prompts = [],
    creates = [],
    sessions = new Map(),
    watchers = new Map();
  let piHold,
    unknown = false;
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
        if (url.endsWith('/projects'))
          return Response.json({
            projects: [{ id: 'workspace', name: 'Pi project', readOnly: true }],
          });
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
          location: 'computer',
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
