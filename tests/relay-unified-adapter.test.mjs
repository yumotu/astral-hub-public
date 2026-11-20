import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createRelayComputer } from '../server/relay-computer.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT);
    CREATE TABLE relay_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,input TEXT NOT NULL,access TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER,output TEXT NOT NULL DEFAULT '',tools TEXT NOT NULL DEFAULT '[]',error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE relay_devices(id TEXT PRIMARY KEY,owner TEXT,expires INTEGER,last_seen INTEGER,capabilities TEXT);
    CREATE TABLE relay_projects(device_id TEXT,id TEXT,revoked INTEGER);
    CREATE TABLE relay_operations(device_id TEXT,project_id TEXT,status TEXT,input TEXT);
    CREATE TABLE pi_files(id TEXT PRIMARY KEY,name TEXT,bytes INTEGER,sha256 TEXT,created_at TEXT,owner TEXT,conversation_id TEXT);
    CREATE TABLE pi_turns(owner TEXT,conversation_id TEXT);`);
  const actor = { id: randomUUID(), role: 'owner' };
  const device = {
    id: randomUUID(),
    owner: actor.id,
    expires: Date.now() + 600000,
    last_seen: Date.now(),
    capabilities: '["conversation_handoff_v1"]',
  };
  const projectId = randomUUID();
  db.prepare('INSERT INTO users VALUES(?,?)').run(actor.id, actor.role);
  db.prepare('INSERT INTO relay_devices VALUES(?,?,?,?,?)').run(
    device.id,
    actor.id,
    device.expires,
    device.last_seen,
    device.capabilities,
  );
  db.prepare('INSERT INTO relay_projects VALUES(?,?,0)').run(device.id, projectId);
  const handoff = [
    { role: 'user', content: 'Prior engine visible question' },
    { role: 'assistant', content: 'Prior engine visible answer' },
  ];
  const patches = [],
    deleted = [],
    deleteChecks = [],
    removals = [];
  let forbidDelete = false,
    managedId = null,
    deleting = false;
  const service = createRelayComputer(db, {
    body: async (req) => req.input,
    now: Date.now,
    limit() {},
    ownedDevice(id, owner) {
      assert.equal(id, device.id);
      assert.equal(owner, actor.id);
      return device;
    },
    project(id, pid) {
      assert.equal(id, device.id);
      assert.equal(pid, projectId);
      return { allow_write: true, allow_execute: true };
    },
    cancel() {},
    chatFiles: { selected: () => [], async removeConversation() {} },
    unified: () => ({
      assertWritable() {},
      forNative() {
        return managedId ? { id: managedId } : null;
      },
      deleting() {
        return deleting;
      },
      async remove(owner, id) {
        assert.equal(owner.id, actor.id);
        assert.equal(id, managedId);
        removals.push(id);
        const c = service.unified.list(actor)[0];
        if (c.runState.busy)
          throw Object.assign(Error('task result remains unresolved'), { status: 409 });
        deleting = true;
        try {
          return (await call('conversations/' + c.id, undefined, 'DELETE')).body;
        } finally {
          deleting = false;
        }
      },
      async handoff(owner, ref) {
        assert.equal(owner, actor.id);
        assert.equal(ref.origin, 'computer');
        return handoff;
      },
      async nativePatch(...args) {
        patches.push(args);
      },
      assertNativeDelete(...args) {
        deleteChecks.push(args);
        if (forbidDelete)
          throw Object.assign(Error('segmented history must be archived'), { status: 409 });
      },
      nativeDeleted(...args) {
        deleted.push(args);
      },
    }),
  });
  async function call(path, input, method = input ? 'POST' : 'GET', before = false) {
    const req = { method, input };
    let result;
    const json = (status, body) => {
      result = { status, body };
    };
    const handled = before
      ? await service.before(req, new URL('http://fixture/api/relay/' + path), json, device)
      : await service.after(req, new URL('http://fixture/api/relay/' + path), json, actor);
    assert.equal(handled, true);
    return result;
  }
  const submission = () => ({
    id: randomUUID(),
    deviceId: device.id,
    projectId,
    conversationId: randomUUID(),
    input: 'New user instruction',
    access: 'read',
    execute: false,
  });
  return {
    db,
    actor,
    device,
    projectId,
    service,
    call,
    submission,
    handoff,
    patches,
    deleted,
    deleteChecks,
    removals,
    manage: () => {
      managedId = randomUUID();
      return managedId;
    },
    forbidDelete: () => {
      forbidDelete = true;
    },
  };
}

test('relay persists unified visible handoff before polling, preserves the accepted receipt and completes without rewriting it', async (t) => {
  const f = fixture(t),
    p = f.submission();
  assert.equal((await f.call('submissions', p)).status, 202);
  const stored = () =>
    JSON.parse(f.db.prepare('SELECT handoff FROM relay_jobs WHERE id=?').get(p.id).handoff);
  assert.deepEqual(stored(), f.handoff);
  assert.equal((await f.call('submissions', p)).status, 200);
  const polled = await f.call('device/workspace/jobs/poll', undefined, 'GET', true);
  assert.equal(polled.body.job.id, p.id);
  assert.deepEqual(polled.body.job.handoff, f.handoff);
  const result = await f.call(
    'device/workspace/jobs/' + p.id + '/result',
    {
      revision: 1,
      output: 'Actual completed answer',
      thinking: '',
      phase: '',
      tools: [],
      status: 'done',
    },
    'POST',
    true,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'done');
  assert.deepEqual(stored(), f.handoff);
});

test('cached relay conversation state reports queued, waiting, stopping and interrupted work without polling the device', async (t) => {
  const f = fixture(t),
    p = f.submission();
  await f.call('submissions', p);
  const state = () =>
    f.service.unified.list(f.actor).find((c) => c.id === p.conversationId).runState;
  for (const [status, raw, expected] of [
    ['queued', {}, 'queued'],
    ['running', { uiRequests: [{ status: 'pending' }] }, 'waiting'],
    ['cancelled', { stop: { requestedAt: '2026-11-12T00:00:00Z' } }, 'stopping'],
    ['interrupted', {}, 'unknown'],
  ]) {
    f.db
      .prepare('UPDATE relay_jobs SET status=?,state=? WHERE id=?')
      .run(status, JSON.stringify(raw), p.id);
    assert.equal(state()?.busy, true, status);
    assert.equal(state()?.state, expected, status);
  }
  f.db.prepare("UPDATE relay_jobs SET status='done',state='{}' WHERE id=?").run(p.id);
  assert.equal(state()?.busy, false);
});

test('native relay metadata updates the unified view and segmented deletion is checked before removing native history', async (t) => {
  const f = fixture(t),
    p = f.submission();
  await f.call('submissions', p);
  const path = 'conversations/' + p.conversationId,
    ref = { origin: 'computer', nativeId: p.conversationId };
  const patch = { title: 'Shared renamed conversation', pinned: true, archived: true };
  assert.equal((await f.call(path, patch, 'PATCH')).status, 200);
  assert.deepEqual(f.patches, [[f.actor, ref, patch]]);
  f.db.prepare("UPDATE relay_jobs SET status='done' WHERE id=?").run(p.id);
  f.forbidDelete();
  await assert.rejects(f.call(path, undefined, 'DELETE'), { status: 409 });
  assert.deepEqual(f.deleteChecks, [[f.actor.id, ref]]);
  assert.ok(f.db.prepare('SELECT 1 FROM relay_conversations WHERE id=?').get(p.conversationId));
  assert.deepEqual(f.deleted, []);
});

test('successful native relay deletion removes its unified display index after the native transaction', async (t) => {
  const f = fixture(t),
    p = f.submission();
  await f.call('submissions', p);
  f.db.prepare("UPDATE relay_jobs SET status='done' WHERE id=?").run(p.id);
  assert.equal(
    (await f.call('conversations/' + p.conversationId, undefined, 'DELETE')).status,
    200,
  );
  assert.deepEqual(f.deleted, [[f.actor.id, { origin: 'computer', nativeId: p.conversationId }]]);
  assert.equal(
    f.db.prepare('SELECT 1 FROM relay_conversations WHERE id=?').get(p.conversationId),
    undefined,
  );
});

test('native relay deletion preserves interrupted work and unconfirmed stops before unified import', async (t) => {
  const f = fixture(t),
    p = f.submission();
  await f.call('submissions', p);
  for (const [status, state] of [
    ['interrupted', {}],
    ['unknown', {}],
    ['cancelled', { stop: { requestedAt: '2026-11-12T00:00:00Z' } }],
    ['running', { uiRequests: [{ status: 'pending' }] }],
  ]) {
    f.db
      .prepare('UPDATE relay_jobs SET status=?,state=? WHERE id=?')
      .run(status, JSON.stringify(state), p.id);
    await assert.rejects(f.call('conversations/' + p.conversationId, undefined, 'DELETE'), {
      status: 409,
    });
    assert.ok(f.db.prepare('SELECT 1 FROM relay_jobs WHERE id=?').get(p.id));
    assert.ok(f.db.prepare('SELECT 1 FROM relay_conversations WHERE id=?').get(p.conversationId));
  }
  assert.deepEqual(f.deleted, []);
  f.db
    .prepare("UPDATE relay_jobs SET status='cancelled',state=? WHERE id=?")
    .run(JSON.stringify({ stop: { acknowledgedAt: '2026-11-12T00:01:00Z' } }), p.id);
  assert.equal(
    (await f.call('conversations/' + p.conversationId, undefined, 'DELETE')).status,
    200,
  );
});

test('native relay deletion delegates managed histories once and retains unresolved work', async (t) => {
  const f = fixture(t),
    p = f.submission();
  await f.call('submissions', p);
  const managedId = f.manage();
  f.db.prepare("UPDATE relay_jobs SET status='interrupted' WHERE id=?").run(p.id);
  await assert.rejects(f.call('conversations/' + p.conversationId, undefined, 'DELETE'), {
    status: 409,
  });
  assert.deepEqual(f.removals, [managedId]);
  assert.ok(f.db.prepare('SELECT 1 FROM relay_jobs WHERE id=?').get(p.id));
  f.db.prepare("UPDATE relay_jobs SET status='done',state='{}' WHERE id=?").run(p.id);
  assert.equal(
    (await f.call('conversations/' + p.conversationId, undefined, 'DELETE')).status,
    200,
  );
  assert.deepEqual(f.removals, [managedId, managedId]);
  assert.equal(f.db.prepare('SELECT 1 FROM relay_jobs WHERE id=?').get(p.id), undefined);
  assert.equal(f.deleted.length, 1);
});
