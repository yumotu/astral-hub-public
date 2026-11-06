import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';
import { createStore } from '../server/store.mjs';
import { localDraw, scopedStorageKey } from '../web/src/data.ts';
import { accountScope, persistSession, loadSession } from '../web/src/session.ts';
import example from '../server/plugins/journal.example.json' with { type: 'json' };
const adminToken = 'test-admin-token-123456789012345678901234567890';
const password = 'Only-Test-Password-7731!';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-community-'));
  const app = await createApp({ token: adminToken, dataDir: dir, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, data, token = '', method) {
    const r = await fetch(url + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  const bootstrap = () =>
    request('/auth/bootstrap', { username: 'owner', displayName: '管理员', password, adminToken });
  async function member(owner, name) {
    const invite = await request('/auth/invitations', {}, owner);
    const result = await request('/auth/register', {
      username: name,
      displayName: name,
      password,
      invite: invite.body.code,
    });
    assert.equal(result.status, 201);
    return result.body;
  }
  return { ...app, dir, url, request, bootstrap, member };
}
test('independent conversations can be prepared before Pi is configured', async t => {
  const f = await fixture(t), owner = (await f.bootstrap()).body;
  const created = await f.request('/pi/conversations', { id: randomUUID() }, owner.token);
  assert.equal(created.status, 201);
  assert.equal(created.body.conversation.projectId, null);
});
test('reading an unused conversation does not save it; the first accepted task saves its project scope', async t => {
  const f=await fixture(t,{piConfig:{url:'http://fixture-pi',token:'synthetic-private',fetch:async url=>{
    if(url.endsWith('/health'))return Response.json({ready:true,nativeSessions:false});
    if(url.endsWith('/projects'))return Response.json({projects:[{id:'workspace',readOnly:false}]});
    return Response.json({output:'Synthetic fixture; no model'});
  }}});
  const owner=(await f.bootstrap()).body, id=randomUUID();
  const request=(path,body)=>f.request(path,body,owner.token);
  assert.equal((await request('/pi/conversations/'+id)).body.conversation,null);
  assert.equal((await request('/pi/conversations')).body.conversations.length,0);
  const rejected=randomUUID();
  assert.equal((await request('/pi/tasks',{id:randomUUID(),conversationId:rejected,input:'invalid edit',access:'edit',projectId:null})).status,400);
  assert.equal((await request('/pi/conversations')).body.conversations.length,0);
  assert.equal((await request('/pi/tasks',{id:randomUUID(),conversationId:id,input:'first message',projectId:'workspace',access:'read'})).status,202);
  const saved=(await request('/pi/conversations')).body.conversations.find(c=>c.id===id);
  assert.equal(saved.projectId,'workspace');
});
test('conversation controls persist account metadata, default directory and project bindings without changing native context', async t => {
  const calls = [];
  const f = await fixture(t, { piConfig: { url: 'http://pi', token: 'conversation-test-bridge', fetch: async (url, options) => {
    if (url.endsWith('/projects')) return Response.json({ projects: [{ id: 'workspace', readOnly: false }, { id: 'other', readOnly: false }] });
    if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: false });
    calls.push(JSON.parse(options.body));
    return Response.json({ output: '真实接口桩回复' });
  } } });
  const owner = (await f.bootstrap()).body, friend = await f.member(owner.token, 'conversationfriend');
  const request = (path, data, method) => f.request(path, data, owner.token, method);
  assert.equal((await f.request('/pi/conversations')).status, 401);
  assert.equal((await request('/pi/preferences')).body.preferences.defaultProjectId, 'workspace');
  const id = randomUUID(), path = '/pi/conversations/' + id;
  const created = await request('/pi/conversations', { id });
  assert.equal(created.status, 201);
  assert.equal(created.body.conversation.projectId, 'workspace');
  for (const invalid of [{}, { title: '' }, { title: '  ' }, { title: 'x'.repeat(121) }, { projectId: 'other' }, { pinned: 'yes' }]) assert.equal((await request(path, invalid, 'PATCH')).status, 400);
  const changed = await request(path, { title: '项目分析', pinned: true, archived: true }, 'PATCH');
  assert.equal(changed.status, 200);
  assert.ok(changed.body.conversation.pinnedAt);
  assert.equal((await request('/pi/conversations')).body.conversations.length, 0);
  assert.equal((await request('/pi/conversations?archived=only')).body.conversations[0].title, '项目分析');
  assert.equal((await request('/pi/conversations?archived=include')).body.conversations.length, 1);
  assert.equal((await request(path)).body.conversation.archivedAt, changed.body.conversation.archivedAt);
  assert.equal((await f.request(path, { title: '偷改' }, friend.token, 'PATCH')).status, 404);
  assert.equal((await f.request(path, undefined, friend.token)).body.conversation, null);
  assert.equal((await f.request('/pi/preferences', { defaultProjectId: 'workspace' }, friend.token, 'PATCH')).status, 403);
  assert.equal((await f.request('/pi/conversations', { id: randomUUID(), projectId: 'workspace' }, friend.token)).status, 403);
  assert.equal((await f.request('/pi/conversations', { id: randomUUID() }, friend.token)).body.conversation.projectId, null);
  assert.equal((await request('/pi/preferences', { defaultProjectId: '../root' }, 'PATCH')).status, 400);
  assert.equal((await request('/pi/preferences', { defaultProjectId: 'missing' }, 'PATCH')).status, 404);
  await request('/pi/preferences', { defaultProjectId: 'other' }, 'PATCH');
  assert.equal((await request('/pi/conversations', { id: randomUUID() })).body.conversation.projectId, 'other');
  assert.equal((await request(path)).body.conversation.projectId, 'workspace');
  assert.equal((await request('/pi/conversations', { id, projectId: 'other' })).status, 409);
  assert.equal((await request('/pi/tasks', { id: randomUUID(), conversationId: id, input: '越界', projectId: 'other' })).status, 409);
  assert.equal((await request('/pi/message', { id: randomUUID(), conversationId: id, input: '同目录继续', projectId: 'workspace' })).status, 200);
  assert.equal((await request(path)).body.conversation.title, '项目分析');
  assert.equal((await request(path)).body.turns.length, 1);
  await request(path, { archived: false, pinned: false }, 'PATCH');
  assert.equal((await request(path)).body.conversation.archivedAt, null);
  assert.equal((await request(path, undefined, 'DELETE')).status, 200);
  assert.equal((await request(path)).body.turns.length, 0);
  assert.equal((await request(path)).body.conversation, null);
  assert.equal((await request('/pi/conversations', { id })).status, 409);
  assert.equal(calls.length, 1, 'metadata operations must not prompt or replay the agent');
});
test('notification APIs require account ownership, isolate inboxes and reject injected destinations',async t=>{
  const f=await fixture(t,{notifications:{start:false}}),owner=(await f.bootstrap()).body;
  const friend=await f.member(owner.token,'noticefriend');
  assert.equal((await f.request('/notifications')).status,401);
  assert.equal((await f.request('/notifications',undefined,adminToken)).status,401);
  const created=await f.request('/notifications/test',{id:randomUUID()},owner.token);assert.equal(created.status,201);
  const id=created.body.notification.id;
  assert.equal((await f.request('/notifications',undefined,friend.token)).body.notifications.length,0);
  assert.equal((await f.request('/notifications',undefined,owner.token)).body.unread,1);
  assert.equal((await f.request('/notifications/'+id+'/read',{},friend.token)).status,404);
  assert.equal((await f.request('/notifications/'+id+'/read',{},owner.token)).status,200);
  assert.equal((await f.request('/notifications',undefined,owner.token)).body.unread,0);
  assert.equal((await f.request('/notifications/devices',{id:randomUUID(),platform:'web',enabled:true,preview:false,owner:friend.user.id},owner.token)).status,400);
  const status=await f.request('/notifications/status',undefined,owner.token);assert.equal(status.body.scope,owner.user.id);assert.equal(status.body.androidRemotePush,false);
  assert.equal('privateKey' in status.body,false);
});
test('notification bulk-read API validates its cursor and keeps other accounts unread', async (t) => {
  const f = await fixture(t, { notifications: { start: false } }),
    owner = (await f.bootstrap()).body;
  const other = await f.member(owner.token, 'bulkfriend');
  await f.request('/notifications/test', { id: randomUUID() }, owner.token);
  await f.request('/notifications/test', { id: randomUUID() }, other.token);
  const before = (await f.request('/notifications', undefined, owner.token)).body;
  await f.request('/notifications/test', { id: randomUUID() }, owner.token);
  assert.equal(
    (
      await f.request(
        '/notifications/read-all',
        { through: before.cursor, owner: other.user.id },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/notifications/read-all', { through: -1 }, owner.token)).status,
    400,
  );
  assert.equal(
    (await f.request('/notifications/read-all', { through: before.cursor }, owner.token)).status,
    200,
  );
  assert.equal((await f.request('/notifications', undefined, owner.token)).body.unread, 1);
  assert.equal((await f.request('/notifications', undefined, other.token)).body.unread, 1);
});

test('friend unread cursors are explicit, monotone, account scoped and do not acknowledge unseen messages', async (t) => {
  const f = await fixture(t),
    owner = (await f.bootstrap()).body,
    friend = await f.member(owner.token, 'unreadfriend'),
    third = await f.member(owner.token, 'unreadthird');
  await f.request('/social/contacts', { username: friend.user.username }, owner.token);
  assert.equal((await f.request('/social/unread', undefined, friend.token)).body.requests, 1);
  await f.request('/social/contacts/' + owner.user.id, { accept: true }, friend.token);
  const send = async (text) =>
    (
      await f.request(
        '/social/messages/' + owner.user.id,
        { id: randomUUID(), content: text },
        friend.token,
      )
    ).body.messages.at(-1);
  const first = await send('第一条');
  assert.equal((await f.request('/social/unread', undefined, owner.token)).body.messages, 1);
  await f.request('/social/messages/' + friend.user.id, undefined, owner.token);
  const next = await send('到达但尚未显示');
  assert.equal(
    (
      await f.request(
        '/social/messages/' + friend.user.id + '/read',
        { through: first.seq },
        owner.token,
      )
    ).status,
    200,
  );
  assert.equal((await f.request('/social/unread', undefined, owner.token)).body.messages, 1);
  const overview = (await f.request('/social/overview', undefined, owner.token)).body;
  assert.equal(overview.contacts.find((u) => u.id === friend.user.id).unread, 1);
  assert.equal(
    (
      await f.request(
        '/social/messages/' + friend.user.id + '/read',
        { through: next.seq, owner: third.user.id },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/social/messages/' + friend.user.id + '/read',
        { through: next.seq },
        third.token,
      )
    ).status,
    403,
  );
  await f.request(
    '/social/messages/' + friend.user.id + '/read',
    { through: next.seq },
    owner.token,
  );
  await f.request(
    '/social/messages/' + friend.user.id + '/read',
    { through: first.seq },
    owner.token,
  );
  assert.equal((await f.request('/social/unread', undefined, owner.token)).body.messages, 0);
  assert.equal((await f.request('/social/unread', undefined, adminToken)).status, 401);
  const otherDevice = (await f.request('/auth/login', { username: 'owner', password })).body;
  assert.equal((await f.request('/social/unread', undefined, otherDevice.token)).body.messages, 0);
});
test('context settings derive session scope from the account and validate updates without blocking on another task', async (t) => {
  const calls = [];
  const piConfig = {
    url: 'http://pi',
    token: 'private-bridge-token',
    fetch: async (url, options) => {
      if (url.endsWith('/sessions/context')) {
        calls.push(JSON.parse(options.body));
        return Response.json({
          model: 'deepseek-flash',
          contextWindow: 1048576,
          maxContextWindow: 1048576,
        });
      }
      return Response.json({});
    },
  };
  const { request, bootstrap, member } = await fixture(t, { piConfig });
  const owner = (await bootstrap()).body;
  const friend = await member(owner.token, 'ctxfriend');
  const id = randomUUID(),
    path = `/pi/conversations/${id}/context`;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, undefined, adminToken)).status, 401);
  assert.equal((await request(path, undefined, owner.token)).status, 200);
  assert.equal((await request(path, { contextWindow: 131072 }, friend.token)).status, 200);
  assert.notEqual(calls[0].sessionKey, calls[1].sessionKey);
  assert.equal(calls[1].contextWindow, 131072);
  assert.deepEqual(Object.keys(calls[0]), ['sessionKey']);
  for (const bad of [
    { contextWindow: 1.5 },
    { contextWindow: '1048576' },
    { contextWindow: 0 },
    { contextWindow: 131072, sessionKey: 'a'.repeat(64) },
    { refresh: true, apiKey: 'injected' },
  ])
    assert.equal((await request(path, bad, owner.token)).status, 400);
  assert.equal((await request(path, { contextWindow: null }, owner.token)).status, 200);
  assert.equal(calls.at(-1).contextWindow, null);
  assert.equal((await request(path, { refresh: true }, owner.token)).status, 200);
  assert.equal(calls.at(-1).refresh, true);
  assert.equal(
    (await request('/pi/conversations/not-a-uuid/context', undefined, owner.token)).status,
    400,
  );
});
test('one-time bootstrap, invite-only registration, normalized usernames and owner-only invites', async (t) => {
  const { request, bootstrap, member } = await fixture(t);
  assert.equal((await request('/auth/status')).body.initialized, false);
  assert.equal(
    (
      await request('/auth/bootstrap', {
        username: 'owner',
        displayName: 'Admin',
        password,
        adminToken: 'wrong',
      })
    ).status,
    403,
  );
  const owner = await bootstrap();
  assert.equal(owner.status, 201);
  assert.equal(owner.body.user.role, 'owner');
  assert.equal((await bootstrap()).status, 409);
  assert.equal((await request('/auth/status')).body.initialized, true);
  assert.equal(
    (
      await request('/auth/register', {
        username: 'friend',
        displayName: 'Friend',
        password,
        invite: 'wrong',
      })
    ).status,
    403,
  );
  const invitation = await request('/auth/invitations', {}, owner.body.token);
  const user = await request('/auth/register', {
    username: 'FRIEND',
    displayName: 'Friend',
    password,
    invite: invitation.body.code,
  });
  assert.equal(user.status, 201);
  assert.equal(user.body.user.username, 'friend');
  assert.equal(
    (
      await request('/auth/register', {
        username: 'other',
        displayName: 'Other',
        password,
        invite: invitation.body.code,
      })
    ).status,
    403,
  );
  assert.equal((await request('/auth/invitations', {}, user.body.token)).status, 403);
  assert.equal((await request('/auth/invitations', {}, adminToken)).status, 401);
  assert.equal(
    (await request('/auth/login', { username: 'friend', password: 'wrong' })).status,
    401,
  );
  assert.equal((await request('/auth/login', { username: 'friend', password })).status, 200);
  const body = JSON.stringify(user.body);
  assert.equal(body.includes(password), false);
  assert.equal(body.includes('password'), false);
});
test('legacy data is retained for owner; records, AI chat and plugins are isolated by account', async (t) => {
  const { request, bootstrap, member } = await fixture(t);
  const reading = localDraw('仅管理员可见的旧记录', 'single'),
    entry = { id: reading.id, deleted: false, data: reading };
  await request('/sync', { entries: [entry] }, adminToken);
  await request('/plugins', example, adminToken);
  const owner = (await bootstrap()).body,
    friend = await member(owner.token, 'friend');
  assert.equal((await request('/sync', { entries: [] }, owner.token)).body.entries.length, 1);
  assert.equal((await request('/sync', { entries: [] }, friend.token)).body.entries.length, 0);
  assert.equal((await request('/plugins', undefined, friend.token)).body.plugins.length, 0);
  const own = localDraw('成员私有记录', 'three');
  await request('/sync', { entries: [{ id: own.id, deleted: false, data: own }] }, friend.token);
  const adminEntries = (await request('/sync', { entries: [] }, owner.token)).body.entries;
  assert.equal(adminEntries.length, 1);
  assert.equal(adminEntries[0].id, reading.id);
  await request(
    '/sync',
    { entries: [{ id: reading.id, deleted: true, data: null }] },
    friend.token,
  );
  assert.equal(
    (await request('/sync', { entries: [] }, owner.token)).body.entries[0].deleted,
    false,
  );
  const chat = {
    id: randomUUID(),
    conversationId: randomUUID(),
    role: 'user',
    content: '私人 AI 内容',
    createdAt: new Date().toISOString(),
  };
  await request(
    '/chat/sync',
    { entries: [{ id: chat.id, deleted: false, data: chat }] },
    friend.token,
  );
  assert.deepEqual((await request('/chat/sync', { entries: [] }, owner.token)).body.entries, []);
  assert.equal((await request('/chat/sync', { entries: [] }, friend.token)).body.entries.length, 1);
});
test('sessions are hashed, logout invalidates a device and password change revokes all other sessions', async (t) => {
  const { request, bootstrap, store } = await fixture(t);
  const owner = (await bootstrap()).body;
  const other = (await request('/auth/login', { username: 'owner', password })).body;
  const raw = JSON.stringify(store.db.prepare('SELECT * FROM sessions').all());
  assert.equal(raw.includes(owner.token), false);
  assert.equal(raw.includes(other.token), false);
  const encoded = store.db.prepare('SELECT password FROM users').get().password;
  assert.equal(encoded.includes(password), false);
  assert.match(encoded, /^[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.equal((await request('/auth/logout', {}, other.token)).status, 200);
  assert.equal((await request('/auth/me', undefined, other.token)).status, 401);
  const third = (await request('/auth/login', { username: 'owner', password })).body;
  const changed = await request(
    '/auth/password',
    { oldPassword: password, password: 'Next-Password-Long-42!' },
    owner.token,
  );
  assert.equal(changed.status, 200);
  assert.equal((await request('/auth/me', undefined, owner.token)).status, 401);
  assert.equal((await request('/auth/me', undefined, third.token)).status, 401);
  assert.equal((await request('/auth/me', undefined, changed.body.token)).status, 200);
});
async function friends(t, options = {}) {
  const f = await fixture(t, options),
    owner = (await f.bootstrap()).body,
    alice = await f.member(owner.token, 'alice'),
    bob = await f.member(owner.token, 'bob');
  return { ...f, owner, alice, bob };
}
test('DMs require mutual contacts, server chooses sender, retries are idempotent and strangers cannot read', async (t) => {
  const { request, owner, alice, bob } = await friends(t);
  const path = `/social/messages/${bob.user.id}`;
  assert.equal((await request(path, undefined, alice.token)).status, 403);
  assert.equal((await request('/social/contacts', { username: 'bob' }, alice.token)).status, 201);
  assert.equal(
    (await request(path, { id: randomUUID(), content: 'hello' }, alice.token)).status,
    403,
  );
  assert.equal(
    (await request(`/social/contacts/${bob.user.id}`, { accept: true }, alice.token)).status,
    404,
  );
  const incoming = (await request('/social/overview', undefined, bob.token)).body.incoming;
  assert.equal(incoming[0].username, 'alice');
  await request(`/social/contacts/${alice.user.id}`, { accept: true }, bob.token);
  assert.equal(
    (await request(path, { id: randomUUID(), content: 'x', senderId: owner.user.id }, alice.token))
      .status,
    400,
  );
  const message = { id: randomUUID(), content: '你好 <script>test</script>' };
  const sent = await request(path, message, alice.token);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.messages[0].senderId, alice.user.id);
  assert.equal((await request(path, message, alice.token)).body.messages.length, 1);
  assert.equal(
    (await request(path, { ...message, content: 'different' }, alice.token)).status,
    409,
  );
  assert.equal(
    (await request(`/social/messages/${alice.user.id}`, undefined, bob.token)).body.messages[0]
      .content,
    message.content,
  );
  assert.equal((await request(path, undefined, owner.token)).status, 403);
  await request(
    '/auth/profile',
    { displayName: 'Alice', bio: '我的介绍', city: '杭州' },
    alice.token,
  );
  assert.equal(
    (await request('/social/overview', undefined, bob.token)).body.contacts[0].city,
    '杭州',
  );
});
test('locations are opt-in, approximate, contact-only, expiring and immediately revoked', async (t) => {
  let now = Date.now();
  const { request, owner, alice, bob } = await friends(t, { now: () => now });
  assert.deepEqual((await request('/social/overview', undefined, alice.token)).body.locations, []);
  const data = { latitude: 30.123456, longitude: 120.654321, accuracy: 20, ttlMinutes: 15 };
  assert.equal(
    (await request('/social/location', { ...data, ttlMinutes: 999 }, alice.token)).status,
    400,
  );
  await request('/social/location', data, alice.token);
  assert.equal((await request('/social/overview', undefined, bob.token)).body.locations.length, 0);
  await request('/social/contacts', { username: 'bob' }, alice.token);
  await request(`/social/contacts/${alice.user.id}`, { accept: true }, bob.token);
  let locations = (await request('/social/overview', undefined, bob.token)).body.locations;
  assert.equal(locations.length, 1);
  assert.equal(locations[0].latitude, 30.123);
  assert.equal(locations[0].longitude, 120.654);
  assert.equal(locations[0].accuracy, 150);
  assert.equal(
    (await request('/social/overview', undefined, owner.token)).body.locations.length,
    0,
  );
  await request('/social/location', undefined, alice.token, 'DELETE');
  assert.equal((await request('/social/overview', undefined, bob.token)).body.locations.length, 0);
  await request('/social/location', data, alice.token);
  now += 16 * 60000;
  assert.equal((await request('/social/overview', undefined, bob.token)).body.locations.length, 0);
  await request('/social/location', data, alice.token);
  await request(`/social/contacts/${alice.user.id}`, undefined, bob.token, 'DELETE');
  assert.equal((await request('/social/overview', undefined, bob.token)).body.locations.length, 0);
  assert.equal(
    (await request(`/social/messages/${alice.user.id}`, undefined, bob.token)).status,
    403,
  );
});
test('Pi bridge is account-authenticated, carries only its secret and isolates histories and deletion', async (t) => {
  const calls = [];
  const piConfig = {
    url: 'http://pi:8790',
    token: 'test-bridge-secret-12345678901234567890',
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${piConfig.token}`);
      if (url.endsWith('/health'))
        return Response.json({ ready: true, version: '1.4.0', model: 'deepseek-flash' });
      const p = JSON.parse(options.body);
      calls.push(p);
      assert.match(p.sessionKey, /^[a-f0-9]{64}$/);
      assert.equal(p.input, p.messages.at(-1).content);
      assert.equal(JSON.stringify(p).includes(piConfig.token), false);
      return Response.json({ output: 'Pi 的测试回复' });
    },
  };
  const { request, alice, bob } = await friends(t, { piConfig });
  assert.equal((await request('/pi/status', undefined, adminToken)).status, 401);
  assert.equal((await request('/pi/status', undefined, alice.token)).body.version, '1.4.0');
  const p = { id: randomUUID(), conversationId: randomUUID(), input: '解释异步函数' };
  assert.equal((await request('/pi/message', p, alice.token)).status, 200);
  assert.equal((await request('/pi/message', p, alice.token)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    (await request('/pi/message', { ...p, input: '不同请求' }, alice.token)).status,
    409,
  );
  assert.equal(
    (await request(`/pi/conversations/${p.conversationId}`, undefined, bob.token)).body.turns
      .length,
    0,
  );
  await request('/pi/message', { ...p, id: randomUUID(), input: '继续举例' }, alice.token);
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].role, 'assistant');
  await request('/pi/message', { ...p, id: randomUUID(), input: 'Bob 的问题' }, bob.token);
  assert.equal(calls[2].messages.length, 1);
  await request(`/pi/conversations/${p.conversationId}`, undefined, bob.token, 'DELETE');
  assert.equal(
    (await request('/pi/conversations', undefined, alice.token)).body.conversations.length,
    1,
  );
  assert.equal(
    (await request('/pi/conversations', undefined, bob.token)).body.conversations.length,
    0,
  );
});
test('Pi serializes requests, rejects client bridge options, and recovers after errors', { timeout: 10000 }, async (t) => {
  let release, entered, polled;
  const started = new Promise((r) => (entered = r));
  const schedulePolled = new Promise((r) => (polled = r));
  let count = 0;
  const piConfig = {
    url: 'http://pi:8790',
    token: 'bridge-secret-12345678901234567890123',
    fetch: async (url) => {
      if (new URL(url).pathname === '/schedules/pending') {
        polled();
        return Response.json({ runs: [] });
      }
      assert.equal(new URL(url).pathname, '/run');
      if (count++ === 0) {
        entered();
        await new Promise((r) => (release = r));
        return new Response('', { status: 502 });
      }
      return Response.json({ output: '恢复成功' });
    },
  };
  const { request, alice } = await friends(t, { piConfig });
  // Exercise the real background poll first; it must not consume a model response.
  await schedulePolled;
  const p = { id: randomUUID(), conversationId: randomUUID(), input: '测试' };
  assert.equal((await request('/pi/message', { ...p, tools: ['bash'] }, alice.token)).status, 400);
  const first = request('/pi/message', p, alice.token);
  try {
    await started;
    assert.equal((await request('/pi/message', { ...p, id: randomUUID() }, alice.token)).status, 429);
  } finally {
    release?.();
  }
  assert.equal((await first).status, 502);
  assert.equal((await request('/pi/message', p, alice.token)).status, 200);
});
test('old SQLite records migrate once; plugin deletion survives restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite'),
    old = new DatabaseSync(path);
  old.exec(
    'CREATE TABLE records(id TEXT PRIMARY KEY,data TEXT,deleted INTEGER);CREATE TABLE plugins(id TEXT PRIMARY KEY,manifest TEXT);',
  );
  const r = localDraw('旧资料', 'single');
  old.prepare('INSERT INTO records VALUES(?,?,0)').run(r.id, JSON.stringify(r));
  old.prepare('INSERT INTO plugins VALUES(?,?)').run(example.id, JSON.stringify(example));
  old.close();
  let store = createStore(path);
  assert.equal(store.all().length, 1);
  assert.equal(store.all('new-user').length, 0);
  store.deletePlugin(example.id);
  store.close();
  store = createStore(path);
  assert.equal(store.all().length, 1);
  assert.equal(store.plugins().length, 0);
  store.close();
});
test('device account caches are server-scoped, separate from guest, and persistent login is opt-in', (t) => {
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = new Map(),
    session = new Map(),
    storage = (m) => ({
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(local) });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(session),
  });
  t.after(() => {
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal);
    else delete globalThis.localStorage;
    if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession);
    else delete globalThis.sessionStorage;
  });
  const settings = { url: 'https://one.example.com', token: '' },
    a = {
      token: 'session-token-12345678901234567890123456789',
      user: { id: randomUUID(), role: 'member' },
      server: settings.url,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      remember: false,
    };
  local.set('astral.entries', 'old-device-records');
  assert.notEqual(accountScope(settings, null), accountScope(settings, a));
  assert.equal(local.get(scopedStorageKey('entries', accountScope(settings, a))), undefined);
  assert.equal(
    local.get(scopedStorageKey('entries', accountScope(settings, null))),
    'old-device-records',
  );
  persistSession(a);
  assert.equal(local.has('astral.account'), false);
  assert.equal(loadSession(settings).token, a.token);
  assert.equal(loadSession({ ...settings, url: 'https://other.example.com' }), null);
  persistSession({ ...a, remember: true });
  assert.equal(session.has('astral.account'), false);
  assert.equal(local.has('astral.account'), true);
  persistSession(null);
  assert.equal(loadSession(settings), null);
});

test('local AI configuration stays in the selected account and does not appear after switching users', async (t) => {
  const { loadScopedAI, persistSettings } = await import('../web/src/data.ts');
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = new Map(),
    session = new Map(),
    storage = (m) => ({
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(local) });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(session),
  });
  t.after(() => {
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal);
    else delete globalThis.localStorage;
    if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession);
    else delete globalThis.sessionStorage;
  });
  const base = {
    url: 'https://example.com',
    token: '',
    autoSync: false,
    remember: false,
    model: 'deepseek-flash',
    rememberKey: true,
    apiKey: 'mock-private-device-key',
    aiMode: 'local',
    aiScope: 'example:user-a',
  };
  persistSettings(base);
  assert.equal(loadScopedAI('example:user-a').apiKey, base.apiKey);
  assert.equal(loadScopedAI('example:user-b').apiKey, '');
  assert.equal(loadScopedAI('example:guest').apiKey, '');
  assert.equal(local.get('astral.settings').includes(base.apiKey), false);
});

test('account sessions, social messages, latest location and Pi history survive database restart', async (t) => {
  const { createAccounts } = await import('../server/accounts.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'astral-account-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');
  let store = createStore(path),
    a = createAccounts(store.db);
  const owner = await a.register({ username: 'owner', displayName: 'Owner', password }, true);
  const friend = await a.register({
    username: 'friend',
    displayName: 'Friend',
    password,
    invite: a.invite(owner.user).code,
  });
  a.request(owner.user.id, 'friend');
  a.respond(friend.user.id, owner.user.id, true);
  a.send(owner.user.id, friend.user.id, { id: randomUUID(), content: '持久消息' });
  a.shareLocation(owner.user.id, { latitude: 30, longitude: 120, accuracy: 300, ttlMinutes: 15 });
  const turn = { id: randomUUID(), conversationId: randomUUID(), input: '记住这个问题' };
  a.savePiTurn(owner.user.id, turn, '持久回复');
  store.close();
  store = createStore(path);
  a = createAccounts(store.db);
  assert.equal(a.authenticate(owner.token).username, 'owner');
  assert.equal(a.messages(friend.user.id, owner.user.id)[0].content, '持久消息');
  assert.equal(a.overview(friend.user.id).locations.length, 1);
  assert.equal(a.piHistory(owner.user.id, turn.conversationId)[0].output, '持久回复');
  assert.equal(a.piHistory(friend.user.id, turn.conversationId).length, 0);
  store.close();
});

test('server projects require owner, bind conversations, and never automatically replay failed edits', { timeout: 10000 }, async (t) => {
  let runs = 0;
  const calls = [];
  let resolvePoll;
  const firstPoll = new Promise((resolve) => { resolvePoll = resolve; });
  const piConfig = {
    url: 'http://pi:8790',
    token: 'bridge-token-12345678901234567890123',
    fetch: async (url) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith('/projects'))
        return Response.json({
          projects: [{ id: 'workspace', name: 'Workspace', readOnly: false }],
        });
      if (url.endsWith('/schedules/pending')) {
        resolvePoll();
        return Response.json({ runs: [] });
      }
      assert.equal(new URL(url).pathname, '/run');
      runs++;
      if (runs === 1)
        return Response.json(
          {
            error: 'failed after tool',
            tools: [
              {
                id: 'call',
                name: 'project_write',
                path: 'test.txt',
                status: 'done',
                summary: '写入完成',
              },
            ],
          },
          { status: 502 },
        );
      return Response.json({ output: '已读取项目', tools: [] });
    },
  };
  const { request, owner, alice } = await friends(t, { piConfig });
  await firstPoll;
  const memberProjects=await request('/pi/projects', undefined, alice.token);
  assert.equal(memberProjects.status,200);
  assert.deepEqual(memberProjects.body.projects,[],'unowned server directories remain hidden until explicitly granted');
  assert.equal((await request('/pi/projects', undefined, owner.token)).status, 200);
  const p = {
    id: randomUUID(),
    conversationId: randomUUID(),
    input: '修改文件',
    projectId: 'workspace',
    access: 'edit',
  };
  assert.equal((await request('/pi/message', p, alice.token)).status, 403);
  assert.equal((await request('/pi/message', p, owner.token)).status, 502, calls.join(', '));
  assert.equal(
    (await request('/pi/jobs/' + p.id, undefined, owner.token)).body.job.tools[0].path,
    'test.txt',
  );
  assert.equal((await request('/pi/jobs/' + p.id, undefined, alice.token)).status, 404);
  assert.equal((await request('/pi/message', p, owner.token)).status, 409);
  assert.equal(runs, 1);
  const next = { ...p, id: randomUUID(), conversationId: randomUUID(), access: 'read' };
  assert.equal((await request('/pi/message', next, owner.token)).status, 200);
  assert.equal(
    (
      await request(
        '/pi/message',
        { id: randomUUID(), conversationId: next.conversationId, input: '换为聊天' },
        owner.token,
      )
    ).status,
    409,
  );
  assert.equal(runs, 2);
});

test('relay pairs once, isolates device credentials, queues idempotently, cancels and revokes', async (t) => {
  let current = Date.now();
  const { request, owner, alice } = await friends(t, { now: () => current });
  assert.deepEqual((await request('/relay/devices', undefined, alice.token)).body.devices, []);
  const pair = await request('/relay/pairing', {}, owner.token);
  const enrollment = {
    code: pair.body.code,
    name: 'Test Mac',
    platform: 'darwin',
    rootLabel: 'sample-project',
    allowWrite: false,
  };
  const device = await request('/relay/device/enroll', enrollment);
  assert.equal(device.status, 201);
  assert.equal((await request('/relay/device/enroll', enrollment)).status, 403);
  assert.equal((await request('/status', undefined, device.body.token)).status, 401);
  assert.equal((await request('/relay/device/poll', undefined, owner.token)).status, 401);
  const p = { id: randomUUID(), deviceId: device.body.deviceId, input: '读取项目', access: 'read' };
  assert.equal((await request('/relay/jobs', { ...p, access: 'edit' }, owner.token)).status, 403);
  assert.equal((await request('/relay/jobs', p, owner.token)).status, 201);
  assert.equal((await request('/relay/jobs', p, owner.token)).status, 200);
  const claimed = await request('/relay/device/poll', undefined, device.body.token);
  assert.equal(claimed.body.job.id, p.id);
  assert.equal((await request('/relay/device/poll', undefined, device.body.token)).body.job, null);
  assert.equal((await request('/relay/jobs/' + p.id + '/cancel', {}, owner.token)).status, 200);
  assert.equal(
    (await request('/relay/device/heartbeat', { jobId: p.id }, device.body.token)).body.cancelled,
    true,
  );
  await request(
    '/relay/device/result',
    { jobId: p.id, status: 'done', output: 'late', tools: [] },
    device.body.token,
  );
  assert.equal(
    (await request('/relay/jobs?deviceId=' + p.deviceId, undefined, owner.token)).body.jobs[0]
      .status,
    'cancelled',
  );
  const stale = { ...p, id: randomUUID() };
  await request('/relay/jobs', stale, owner.token);
  await request('/relay/device/poll', undefined, device.body.token);
  current += 46000;
  assert.equal(
    (await request('/relay/jobs?deviceId=' + p.deviceId, undefined, owner.token)).body.jobs[0]
      .status,
    'interrupted',
  );
  await request('/relay/devices/' + p.deviceId, undefined, owner.token, 'DELETE');
  assert.equal((await request('/relay/device/poll', undefined, device.body.token)).status, 401);
});

test('relay model gateway keeps master key on server and only serves an active leased task', async (t) => {
  let called = 0;
  const { request, url, bootstrap } = await fixture(t, {
    aiConfig: { apiKey: 'mock-master-key', model: 'deepseek-flash' },
    relayFetch: async (endpoint, options) => {
      called++;
      assert.equal(endpoint, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer mock-master-key');
      const p = JSON.parse(options.body);
      assert.equal(p.model, 'deepseek-flash');
      assert.equal(p.max_tokens, 3000);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = (await bootstrap()).body;
  const pair = (await request('/relay/pairing', {}, owner.token)).body;
  const device = (
    await request('/relay/device/enroll', {
      code: pair.code,
      name: 'Test Windows',
      platform: 'win32',
      rootLabel: 'sample',
      allowWrite: false,
    })
  ).body;
  const p = { id: randomUUID(), deviceId: device.deviceId, input: '解释文件', access: 'read' };
  await request('/relay/jobs', p, owner.token);
  const modelCall = () =>
    fetch(url + '/relay/provider/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + device.token,
        'X-Astral-Job': p.id,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'untrusted',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 999999,
      }),
    });
  assert.equal((await modelCall()).status, 403);
  await request('/relay/device/poll', undefined, device.token);
  const response = await modelCall();
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('mock-master-key'), false);
  assert.equal(called, 1);
});

test('native Pi keeps all prior turns independently of display pagination and streams actual thinking and text', async (t) => {
  let received;
  const piConfig = {
    url: 'http://pi:8790',
    token: 'bridge-native-test-secret',
    fetch: async (url, options) => {
      if (url.endsWith('/health'))
        return Response.json({ ready: true, nativeSessions: true, streaming: true });
      received = JSON.parse(options.body);
      const events = [
        { type: 'response_start' },
        { type: 'thinking_delta', delta: '模型返回的思考' },
        { type: 'text_delta', delta: '流式\u2028回复' },
        {
          type: 'done',
          output: '流式\u2028回复',
          thinking: '模型返回的思考',
          tools: [],
          context: { messageCount: 105, autoCompaction: true },
        },
      ];
      return new Response(events.map((e) => JSON.stringify(e) + '\n').join(''), {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    },
  };
  const { request, bootstrap, store, url } = await fixture(t, { piConfig });
  const owner = (await bootstrap()).body,
    conversationId = randomUUID();
  for (let i = 0; i < 52; i++)
    store.db
      .prepare(
        'INSERT INTO pi_turns(id,owner,conversation_id,input,output,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        owner.user.id,
        conversationId,
        '问题' + i,
        '回答' + i,
        new Date().toISOString(),
      );
  const shown = (await request('/pi/conversations/' + conversationId, undefined, owner.token)).body
    .turns;
  assert.equal(shown.length, 50);
  assert.equal(shown[0].input, '问题2');
  const older = (
    await request(
      `/pi/conversations/${conversationId}?before=${shown[0].seq}`,
      undefined,
      owner.token,
    )
  ).body.turns;
  assert.deepEqual(
    older.map((x) => x.input),
    ['问题0', '问题1'],
  );
  const p = { id: randomUUID(), conversationId, input: '继续', stream: true, thinking: true };
  const response = await fetch(url + '/pi/message', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /x-ndjson/);
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.deepEqual(
    events.slice(0, 3).map((e) => e.type),
    ['response_start', 'thinking_delta', 'text_delta'],
  );
  assert.equal(events.at(-1).type, 'done');
  assert.equal(received.history.length, 104);
  assert.equal(received.history[0].content, '问题0');
  assert.equal(received.thinking, true);
  assert.equal(received.requestId, p.id);
  assert.match(received.sessionKey, /^[a-f0-9]{64}$/);
  const last = (
    await request('/pi/conversations/' + conversationId, undefined, owner.token)
  ).body.turns.at(-1);
  assert.equal(last.thinking, '模型返回的思考');
  assert.equal(last.output, '流式\u2028回复');
  assert.equal((await request('/pi/message', p, owner.token)).status, 200);
});

test('skills are owner-managed and native session controls are account-scoped', async (t) => {
  let skills = [],
    controls = [], skillQueries = [];
  const piConfig = {
    url: 'http://pi:8790',
    token: 'bridge-resources-test',
    fetch: async (url, options) => {
      if(url.endsWith('/projects'))return Response.json({projects:[{id:'workspace',readOnly:false}]});
      if (new URL(url).pathname === '/skills') {
        skillQueries.push(new URL(url).search);
        if (options.body) skills = [JSON.parse(options.body)];
        return Response.json({
          skills: new URL(url).searchParams.get('packages') === '1'
            ? [...skills, { name: 'mermaid', description: 'Diagram', enabled: true, source: 'package', readOnly: true, path: '/owner/packages/mermaid/SKILL.md' }]
            : skills,
          warning: 'QA package notice', diagnostics: [{ type: 'warning', path: '/owner/packages' }],
        });
      }
      controls.push(JSON.parse(options.body));
      return Response.json({ ok: true, commands: [], context: { messageCount: 0 } });
    },
  };
  const { request, owner, alice } = await friends(t, { piConfig });
  const definition = {
    name: 'review',
    description: '审查代码',
    instructions: '先读取，再报告',
    enabled: true,
  };
  assert.equal((await request('/pi/skills', definition, alice.token)).status, 403);
  assert.equal((await request('/pi/skills', definition, owner.token)).status, 200);
  const member = (await request('/pi/skills', undefined, alice.token)).body.skills[0];
  assert.equal(member.name, 'review');
  assert.equal(member.instructions, undefined);
  const native = (await request('/pi/skills', undefined, owner.token)).body;
  assert.equal(native.skills.find((s) => s.name === 'mermaid').readOnly, true);
  assert.equal(native.warning, 'QA package notice');
  assert.equal(skillQueries.at(-1), '?packages=1');
  const memberAgain = (await request('/pi/skills?packages=1', undefined, alice.token)).body;
  assert.equal(skillQueries.at(-1), '');
  assert.equal(memberAgain.skills.length, 1);
  assert.equal(memberAgain.warning, undefined);
  assert.equal(memberAgain.diagnostics, undefined);
  assert.ok(!JSON.stringify(memberAgain).includes('/owner/'));
  const id = randomUUID();
  assert.equal((await request(`/pi/conversations/${id}/inspect`, {}, owner.token)).status, 200);
  assert.equal((await request(`/pi/conversations/${id}/cancel`, {}, alice.token)).status, 200);
  assert.notEqual(controls[0].sessionKey, controls[1].sessionKey);
  assert.equal(
    (await request(`/pi/conversations/${id}/inspect`, { projectId: 'workspace' }, alice.token))
      .status,
    403,
  );
});

test('native command inspection allows a resource handshake longer than fifteen seconds without running a prompt', async (t) => {
  let prompts = 0;
  const f = await fixture(t, { piConfig: {
    url: 'http://pi:8790', token: 'slow-native-inspect-test',
    fetch: async (url, options) => {
      if (url.endsWith('/sessions/inspect')) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(); }, 16000);
          const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
          options.signal.addEventListener('abort', abort, { once: true });
        });
        return Response.json({ commands: [{ name: 'cron' }], context: { messageCount: 0 } });
      }
      if (url.endsWith('/run') || url.endsWith('/run/stream')) prompts++;
      return Response.json({ runs: [] });
    },
  } });
  const owner = (await f.bootstrap()).body;
  const result = await f.request('/pi/conversations/' + randomUUID() + '/inspect', {}, owner.token);
  assert.equal(result.status, 200);
  assert.equal(result.body.commands[0].name, 'cron');
  assert.equal(prompts, 0);
});

test('current session inspection survives history reload without rewriting past execution or leaking accounts', async (t) => {
  const inspected = [];
  const current = { messageCount: 18, stats: { tokens: { total: 703857 } } };
  const f = await fixture(t, { piConfig: {
    url: 'http://pi', token: 'session-snapshot-test',
    fetch: async (url, options) => {
      if (url.endsWith('/sessions/inspect')) {
        inspected.push(JSON.parse(options.body));
        return Response.json({ commands: [], context: current });
      }
      return Response.json({ ready: true, nativeSessions: false });
    },
  } });
  const owner = (await f.bootstrap()).body, friend = await f.member(owner.token, 'snapshotfriend');
  const { createAccounts } = await import('../server/accounts.mjs');
  const accounts = createAccounts(f.store.db), id = randomUUID(), path = '/pi/conversations/' + id;
  const oldExecution = { context: { stats: { tokens: { total: 694807 }, contextUsage: { tokens: 30443, contextWindow: 1048576, percent: 3 } } } };
  accounts.savePiTurn(owner.user.id, { id: randomUUID(), conversationId: id, input: 'before', execution: oldExecution }, 'past reply');
  assert.equal((await f.request(path, undefined, owner.token)).body.sessionContext ?? null, null);
  const inspectedResult = await f.request(path + '/inspect', {}, owner.token);
  assert.equal(inspectedResult.status, 200);
  const loaded = (await f.request(path, undefined, owner.token)).body;
  assert.deepEqual(loaded.sessionContext.context, current);
  assert.equal(loaded.sessionContext.source, 'inspect');
  assert.equal(loaded.sessionContext.baselineTaskId, loaded.turns[0].id);
  assert.deepEqual(loaded.turns[0].execution, oldExecution);
  assert.equal(loaded.sessionContext.context.stats.contextUsage, undefined);
  assert.equal((await f.request(path, undefined, friend.token)).body.sessionContext, null);
  assert.equal((await f.request(path + '/inspect', { revision: 999, context: current }, owner.token)).status, 400);
  await f.request(path, { archived: true }, owner.token, 'PATCH');
  assert.deepEqual((await f.request(path, undefined, owner.token)).body.sessionContext, loaded.sessionContext);
  assert.equal(inspected.length, 1, 'history reads do not start RPC or model work');
  assert.equal((await f.request(path, undefined, owner.token, 'DELETE')).status, 200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM pi_session_context WHERE owner=? AND conversation_id=?').get(owner.user.id, id).count, 0);
});

test('broken Pi streams never save a fabricated completed reply and release request capacity', async (t) => {
  let count = 0;
  const piConfig = {
    url: 'http://pi:8790',
    token: 'bridge-stream-error-test',
    fetch: async () => {
      count++;
      if (count === 1)
        return new Response(JSON.stringify({ type: 'text_delta', delta: '未完成' }) + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      return Response.json({ output: '下一条成功', tools: [] });
    },
  };
  const { request, bootstrap, url } = await fixture(t, { piConfig });
  const owner = (await bootstrap()).body;
  const conversationId = randomUUID(),
    p = { id: randomUUID(), conversationId, input: '测试中断', stream: true };
  const response = await fetch(url + '/pi/message', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(events.at(-1).type, 'error', JSON.stringify({status:response.status,events}));
  assert.equal(
    (await request('/pi/conversations/' + conversationId, undefined, owner.token)).body.turns
      .length,
    0,
  );
  assert.equal(
    (await request('/pi/message', { id: randomUUID(), conversationId, input: '继续' }, owner.token))
      .status,
    200,
  );
});

test('thinking effort reaches Pi unchanged and rejects unsupported levels without inference', async (t) => {
  const received = [];
  const piConfig = {
    url: 'http://pi:8790',
    token: 'thinking-level-bridge-test',
    fetch: async (url, options) => {
      received.push(JSON.parse(options.body));
      return Response.json({ output: 'ok', tools: [] });
    },
  };
  const { request, bootstrap } = await fixture(t, { piConfig });
  const owner = (await bootstrap()).body;
  for (const thinkingLevel of ['off', 'low', 'high', 'max']) {
    const p = { id: randomUUID(), conversationId: randomUUID(), input: '测试强度', thinkingLevel };
    assert.equal((await request('/pi/message', p, owner.token)).status, 200);
    assert.equal(received.at(-1).thinkingLevel, thinkingLevel);
  }
  assert.equal(
    (
      await request(
        '/pi/message',
        {
          id: randomUUID(),
          conversationId: randomUUID(),
          input: '无效档位',
          thinkingLevel: 'ultra',
        },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(received.length, 4);
  const legacy = {
    id: randomUUID(),
    conversationId: randomUUID(),
    input: '旧版开关',
    thinking: true,
  };
  assert.equal((await request('/pi/message', legacy, owner.token)).status, 200);
  assert.equal(received.at(-1).thinkingLevel, 'high');
});

test('agent permissions are server-derived and Bash output is retained in task replay and history', async (t) => {
  const calls = [];
  const piConfig = {
    url: 'http://pi',
    token: 'qa-server-derived-capability',
    fetch: async (url, init) => {
      const p = init.body && JSON.parse(init.body);
      if (url.endsWith('/projects'))
        return Response.json({ projects: [{ id: 'alpha', readOnly: false }] });
      if (url.endsWith('/run/stream')) {
        calls.push(p);
        const tool = {
          id: 'bash1',
          name: 'bash',
          path: '.',
          command: 'printf ready',
          output: 'ready',
          exitCode: 0,
          status: 'done',
        };
        const todo = {
          id: 'todo1',
          name: 'todo',
          path: '.',
          status: 'done',
          arguments: '{"action":"list"}',
          todos: [
            { id: '1', text: '检查项目结构', status: 'done' },
            { id: '2', text: '分析问题', status: 'pending' },
          ],
          todoAction: 'list',
          output: '[x] #1: 检查项目结构\n[ ] #2: 分析问题',
        };
        const events = [
          { type: 'response_start' },
          { type: 'text_delta', delta: '先检查项目。' },
          { type: 'thinking_delta', delta: '确认工具与范围。' },
          { type: 'tool_start', id: tool.id, name: 'bash', path: '.', command: tool.command },
          { type: 'tool_output', id: tool.id, output: 'rea' },
          { type: 'tool_end', id: tool.id, output: 'ready', exitCode: 0, error: false },
          {
            type: 'tool_start',
            id: todo.id,
            name: todo.name,
            path: '.',
            arguments: todo.arguments,
          },
          {
            type: 'tool_end',
            id: todo.id,
            todos: todo.todos,
            todoAction: 'list',
            output: todo.output,
          },
          {
            type: 'usage',
            usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 },
            responseMs: 1000,
          },
          { type: 'text_delta', delta: '完成' },
          { type: 'done', output: '完成', tools: [tool, todo] },
        ];
        return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      if (url.endsWith('/run')) calls.push(p);
      return Response.json({ output: '完成', tools: [] });
    },
  };
  const { request, owner, alice } = await friends(t, { piConfig });
  const id = randomUUID(),
    conversationId = randomUUID();
  assert.equal(
    (
      await request(
        '/pi/tasks',
        {
          id,
          conversationId,
          input: '运行检查',
          projectId: 'alpha',
          access: 'edit',
          canManageSkills: true,
        },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/pi/tasks',
        { id, conversationId, input: '运行检查', projectId: 'alpha', access: 'edit' },
        alice.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/pi/tasks',
        { id, conversationId, input: '运行检查', projectId: 'alpha', access: 'edit' },
        owner.token,
      )
    ).status,
    202,
  );
  let done;
  for (let i = 0; i < 80; i++) {
    done = (await request('/pi/tasks', undefined, owner.token)).body.tasks.find(
      (task) => task.id === id,
    );
    if (done?.status === 'done') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(done.status, 'done');
  assert.equal(calls[0].canManageSkills, true);
  assert.equal(done.tools[0].output, 'ready');
  assert.equal(done.tools[0].exitCode, 0);
  const replay = (await request('/pi/tasks/updates?after=0', undefined, owner.token)).body;
  assert(replay.events.some((e) => e.event.type === 'tool_output' && e.event.output === 'rea'));
  const history = (await request('/pi/conversations/' + conversationId, undefined, owner.token))
    .body.turns;
  assert.equal(history[0].tools[0].command, 'printf ready');
  assert.equal(history[0].tools[0].output, 'ready');
  assert.deepEqual(
    history[0].timeline.map((x) => x.kind),
    ['text', 'thinking', 'tool', 'tool', 'text'],
  );
  assert.equal(history[0].timeline[0].text, '先检查项目。');
  assert.equal(history[0].timeline[2].output, 'ready');
  assert.equal(history[0].timeline[4].text, '完成');
  assert.equal(history[0].timeline[3].todos[0].status, 'done');
  assert.equal(history[0].tools[1].todos[1].status, 'pending');
  assert.equal(history[0].execution.metrics.modelTurns, 1);
  assert.equal(history[0].execution.metrics.toolCalls, 2);
  assert.equal(history[0].execution.metrics.output, 20);
  assert.equal(history[0].execution.metrics.responseMs, 1000);
  assert(Date.parse(history[0].execution.finishedAt) >= Date.parse(history[0].execution.startedAt));
  assert(replay.events.some((e) => e.event.type === 'usage' && e.event.usage.cacheRead === 900));
  assert.deepEqual(done.execution, history[0].execution);
  assert.deepEqual(done.timeline, history[0].timeline);
  const member = await request(
    '/pi/message',
    { id: randomUUID(), conversationId: randomUUID(), input: '查询技能' },
    alice.token,
  );
  assert.equal(member.status, 200);
  assert.equal(calls.at(-1).canManageSkills, false);
});
