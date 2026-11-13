import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createUnifiedConversations } from '../server/unified-conversations.mjs';
import { serverPiRuntime } from '../server/agent-bindings.mjs';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const actors = [{ id: randomUUID() }, { id: randomUUID() }],
    connection = randomUUID();
  const source = { origin: 'server', projectId: 'workspace' },
    target = { origin: 'remote', projectId: 'work', connectionId: connection };
  let busy = false,
    allow = true,
    failCreate = false,
    paused = null,
    afterCreate = null;
  const native = [],
    messages = new Map(),
    created = [];
  const adapters = {
    actor: (id) => ({ id }),
    nativeList: (a) => native.filter((n) => n.owner === a.id),
    targets: async () => (allow ? [source, target] : []),
    state: async () => ({ busy, label: '正在执行' }),
    visible: async (a, r) => {
      if (!allow) throw Error('revoked');
      assert.ok(native.some((n) => n.owner === a.id && n.nativeId === r.nativeId));
      return { messages: messages.get(r.nativeId) || [] };
    },
    create: async (a, t, id) => {
      created.push(id);
      if (paused) await paused;
      if (failCreate) throw Error('unknown');
      const runtime =
        t.origin === 'server'
          ? serverPiRuntime(a.id, id, t.projectId)
          : {
              version: 1,
              backend: 'dsh',
              transport: 'dsh-remote',
              location: 'server',
              deviceId: 'host-one',
              connectionId: connection,
              projectId: t.projectId,
              sessionKey: id,
            };
      const n = {
        owner: a.id,
        id,
        nativeId: id,
        origin: t.origin,
        runtime,
        createdAt: '2026-11-12T00:00:00Z',
        updatedAt: '2026-11-12T00:00:00Z',
        title: 'Native title',
      };
      native.push(n);
      if (afterCreate) await afterCreate(n);
      return n;
    },
  };
  const service = () => createUnifiedConversations(db, adapters);
  return {
    db,
    actors,
    source,
    target,
    native,
    messages,
    created,
    service,
    adapters,
    setBusy: (v) => (busy = v),
    setAllow: (v) => (allow = v),
    setFailure: (v) => (failCreate = v),
    setPaused: (v) => (paused = v),
    setAfterCreate: (v) => (afterCreate = v),
  };
}
test('Pi → DPH → Pi is one owned display conversation with immutable segments and visible handoff after restart', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  const first = await s.create(a, { id, target: f.source });
  f.messages.set(first.active.nativeId, [
    { role: 'user', content: 'remember blue' },
    { role: 'assistant', content: 'blue acknowledged' },
  ]);
  s.preferences(a.id, { defaultBackend: 'dsh' });
  assert.equal(s.preferences(f.actors[1].id).defaultBackend, 'pi');
  const switched = await s.switch(a, id, { id: randomUUID(), target: f.target });
  assert.equal(switched.id, id);
  assert.equal(switched.segments.length, 2);
  assert.equal(switched.active.runtime.backend, 'dsh');
  assert.throws(() => s.assertWritable(a.id, first.active), /已结束/);
  const h = await s.handoff(a.id, switched.active);
  assert.ok(h.some((m) => m.content === 'remember blue'));
  f.messages.set(switched.active.nativeId, [
    { role: 'user', content: 'also green' },
    { role: 'assistant', content: 'green acknowledged' },
  ]);
  const third = await s.switch(a, id, { id: randomUUID(), target: f.source });
  assert.equal(third.segments.length, 3);
  assert.notEqual(third.active.nativeId, first.active.nativeId);
  const restored = f.service();
  assert.equal(restored.cached(a).conversations.length, 1);
  assert.ok((await restored.handoff(a.id, third.active)).some((m) => m.content === 'also green'));
  assert.equal(restored.cached(f.actors[1]).conversations.length, 0);
  await assert.rejects(
    restored.switch(f.actors[1], id, { id: randomUUID(), target: f.target }),
    /不存在/,
  );
  await restored.patch(a, id, { title: 'Keep this', pinned: true, archived: true });
  assert.equal(restored.cached(a).conversations[0].title, 'Keep this');
  f.setAllow(false);
  await assert.rejects(restored.handoff(a.id, third.active), /revoked/);
});
test('unknown creation is never replayed; same operation reconciles saved native result only', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  await s.create(a, { id, target: f.source });
  f.setFailure(true);
  const op = { id: randomUUID(), target: f.target };
  await assert.rejects(s.switch(a, id, op), /unknown/);
  f.setFailure(false);
  await assert.rejects(s.switch(a, id, op), /不会重复创建/);
  assert.equal(f.created.length, 2);
  await assert.rejects(s.switch(a, id, { id: randomUUID(), target: f.target }), /不会创建第二个/);
  assert.equal(f.created.length, 2);
  assert.equal(s.cached(a).conversations[0].segments.length, 1);
  const nativeId = f.created[1];
  f.native.push({
    owner: a.id,
    origin: 'remote',
    nativeId,
    id: nativeId,
    runtime: {
      version: 1,
      backend: 'dsh',
      transport: 'dsh-remote',
      location: 'server',
      deviceId: 'host-one',
      connectionId: f.target.connectionId,
      projectId: 'work',
      sessionKey: nativeId,
    },
  });
  assert.equal(
    s.cached(a).conversations.length,
    1,
    'polling cannot import an unknown-operation reservation',
  );
  const ready = await s.switch(a, id, op);
  assert.equal(ready.segments.length, 2);
  assert.equal(f.created.length, 2);
  const retry = await s.switch(a, id, op);
  assert.equal(retry.active.nativeId, ready.active.nativeId);
});
test('busy, revoked target and concurrent switch cannot send or change an active selection', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  const c = await s.create(a, { id, target: f.source });
  f.setBusy(true);
  await assert.rejects(s.switch(a, id, { id: randomUUID(), target: f.target }), /暂不可切换/);
  assert.equal(f.created.length, 1);
  f.setBusy(false);
  f.setAllow(false);
  await assert.rejects(s.switch(a, id, { id: randomUUID(), target: f.target }), /不可用/);
  f.setAllow(true);
  let release;
  f.setPaused(new Promise((r) => (release = r)));
  const switching = s.switch(a, id, { id: randomUUID(), target: f.target });
  await new Promise((r) => setImmediate(r));
  assert.throws(() => s.assertWritable(a.id, c.active), /切换引擎/);
  await assert.rejects(s.switch(a, id, { id: randomUUID(), target: f.target }), /正在切换/);
  release();
  await switching;
  assert.equal(f.created.length, 2);
});
test('native import separates same UUID across owners and transports', async (t) => {
  const f = fixture(t),
    s = f.service(),
    id = randomUUID();
  for (const a of f.actors)
    f.native.push({
      owner: a.id,
      nativeId: id,
      origin: 'server',
      runtime: serverPiRuntime(a.id, id),
      title: a.id,
      updatedAt: '2026-11-12T00:00:00Z',
    });
  assert.equal(s.cached(f.actors[0]).conversations.length, 1);
  assert.equal(s.cached(f.actors[1]).conversations.length, 1);
});

test('poll after native creation but before switch commit never imports a duplicate, including restart', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  await s.create(a, { id, target: f.source });
  let entered, release;
  const created = new Promise((r) => (entered = r)),
    paused = new Promise((r) => (release = r));
  f.setAfterCreate(async () => {
    entered();
    await paused;
  });
  const switching = s.switch(a, id, { id: randomUUID(), target: f.target });
  await created;
  assert.equal(s.cached(a).conversations.length, 1);
  assert.equal(f.service().cached(a).conversations.length, 1);
  const pending = f.native.at(-1);
  assert.throws(() => s.assertWritable(a.id, pending), /正在准备/);
  assert.throws(
    () => s.assertWritable(a.id, pending, { switchingStatus: 503 }),
    (e) => e.status === 503,
  );
  release();
  const done = await switching;
  assert.equal(done.segments.length, 2);
  assert.equal(s.cached(a).conversations.length, 1);
});
test('creating a new display row also reserves the native session while polling', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  f.setAfterCreate(async () => {
    assert.equal(s.cached(a).conversations.length, 0);
  });
  await s.create(a, { id, target: f.source });
  assert.equal(s.cached(a).conversations.length, 1);
});
test('recovery refuses an unavailable native result and never creates it twice', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  await s.create(a, { id, target: f.source });
  f.setFailure(true);
  const op = { id: randomUUID(), target: f.target };
  await assert.rejects(s.switch(a, id, op), /unknown/);
  f.setFailure(false);
  const nativeId = f.created[1];
  f.native.push({
    owner: a.id,
    origin: 'remote',
    nativeId,
    id: nativeId,
    state: 'creating',
    runtime: {
      version: 1,
      backend: 'dsh',
      transport: 'dsh-remote',
      location: 'server',
      deviceId: 'host-one',
      connectionId: f.target.connectionId,
      projectId: 'work',
      sessionKey: nativeId,
    },
  });
  await assert.rejects(s.switch(a, id, op), /待核对/);
  assert.equal(f.created.length, 2);
  assert.equal(s.cached(a).conversations.length, 1);
  assert.equal(s.cached(a).conversations[0].segments.length, 1);
});

test('target preparation validates the actual native binding before changing display state', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  await s.create(a, { id, target: f.source });
  f.setAfterCreate(async (n) => {
    n.runtime = { ...n.runtime, projectId: 'other-project' };
  });
  await assert.rejects(s.switch(a, id, { id: randomUUID(), target: f.target }), /绑定与请求不一致/);
  const rows = s.cached(a).conversations;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].segments.length, 1);
});

test('single native deletion removes unified index while segmented history cannot be deleted piecemeal', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  const c = await s.create(a, { id, target: f.source });
  assert.equal(s.forNative(a.id, c.active).id, id);
  await s.nativePatch(a, c.active, { title: 'Unified native title' });
  assert.equal(s.cached(a).conversations[0].title, 'Unified native title');
  const next = await s.switch(a, id, { id: randomUUID(), target: f.target });
  assert.throws(() => s.assertNativeDelete(a.id, c.active), /多个引擎/);
  await assert.rejects(s.remove(a, id), /归档/);
  assert.equal(s.cached(a).conversations.length, 1);
  const single = await s.create(a, { id: randomUUID(), target: f.source });
  f.adapters.remove = async (actor, ref) => {
    const index = f.native.findIndex((n) => n.owner === actor.id && n.nativeId === ref.nativeId);
    f.native.splice(index, 1);
    s.nativeDeleted(actor.id, ref);
  };
  f.setBusy(true);
  await assert.rejects(s.remove(a, single.id), /暂不可切换/);
  f.setBusy(false);
  await s.remove(a, single.id);
  assert.equal(s.cached(a).conversations.length, 1);
  assert.equal(s.cached(a).conversations[0].segments.length, next.segments.length);
  assert.equal(s.forNative(a.id, single.active), null);
});

test('visible handoff remains bounded when the last older message has less room than its omission marker', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  const first = await s.create(a, { id, target: f.source });
  f.messages.set(first.active.nativeId, [
    { role: 'user', content: 'OLDER'.repeat(20000) },
    { role: 'assistant', content: 'N'.repeat(47990) },
  ]);
  const switched = await s.switch(a, id, { id: randomUUID(), target: f.target });
  const h = await s.handoff(a.id, switched.active);
  assert.ok(h.slice(1).reduce((n, m) => n + m.content.length, 0) <= 48000);
  assert.match(h[0].content, /省略/);
});

test('handoff labels paginated source history as an excerpt even when remaining text fits', async (t) => {
  const f = fixture(t),
    s = f.service(),
    a = f.actors[0],
    id = randomUUID();
  await s.create(a, { id, target: f.source });
  f.adapters.visible = async () => ({
    messages: [{ role: 'assistant', content: 'Latest visible prose' }],
    hasMore: true,
  });
  const switched = await s.switch(a, id, { id: randomUUID(), target: f.target });
  const h = await s.handoff(a.id, switched.active);
  assert.match(h[0].content, /节选，较早内容已省略/);
});
