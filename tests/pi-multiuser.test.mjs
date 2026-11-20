import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPiTasks } from '../server/pi-tasks.mjs';
import { createRunPool } from '../deploy/pi/run-pool.mjs';
import { concurrencyLimits, recommendedConcurrency } from '../deploy/pi/concurrency.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('Expected scheduler transition');
}
function fixture(t, limits = {}) {
  const db = new DatabaseSync(':memory:'),
    starts = [],
    finishes = new Map();
  const tasks = createPiTasks(db, {
    available: () => true,
    completed: () => false,
    run: (owner, task) =>
      new Promise((resolve) => {
        starts.push({ owner, id: task.id, conversationId: task.conversationId });
        finishes.set(task.id, () => resolve({ output: 'done' }));
      }),
    steer: async () => {},
    cancel: async (_owner, task) => finishes.get(task.id)?.(),
    ...limits,
  });
  const add = (owner, conversationId = randomUUID()) => {
    const p = {
      id: randomUUID(),
      conversationId,
      input: 'synthetic task',
      mode: 'queue',
      attachments: [],
    };
    tasks.add(owner, p);
    return p;
  };
  t.after(async () => {
    tasks.close();
    for (const finish of finishes.values()) finish();
    await tick();
    db.close();
  });
  return { db, tasks, starts, finishes, add };
}

test('default capacity permits four independent conversations for one user', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.add('alice');
  await waitFor(() => f.starts.length === 4);
  assert.equal(f.tasks.snapshot('alice').scheduler.maxConcurrent, recommendedConcurrency());
});

test('users share capacity fairly without per-user limits and cannot monopolize the next free slot', async (t) => {
  const f = fixture(t, { maxConcurrent: 4, maxConcurrentPerUser: 2 });
  const a = [f.add('alice'), f.add('alice'), f.add('alice')];
  const b = [f.add('bob'), f.add('bob')],
    c = f.add('carol');
  await waitFor(() => f.starts.length === 4);
  assert.deepEqual(
    f.starts.map((x) => x.owner),
    ['alice', 'bob', 'carol', 'alice'],
  );
  assert.equal(f.tasks.get('alice', a[2].id).status, 'queued');
  assert.equal(f.tasks.get('carol', c.id).status, 'running');
  f.finishes.get(a[0].id)();
  await waitFor(() => f.starts.length === 5);
  assert.equal(f.starts.at(-1).id, b[1].id);
  assert.equal(f.tasks.get('alice', a[2].id).status, 'queued');
  const snapshot = f.tasks.snapshot('bob');
  assert.equal(snapshot.scheduler.maxConcurrentPerUser, 4);
  assert.ok(snapshot.tasks.every((x) => b.some((p) => p.id === x.id)));
  assert.ok(!JSON.stringify(snapshot).includes('alice'));
});

test('identical conversation IDs on separate accounts have independent lanes, FIFO and cancellation', async (t) => {
  const f = fixture(t, { maxConcurrent: 4 }),
    conversation = randomUUID();
  const a = f.add('alice', conversation),
    next = f.add('alice', conversation),
    b = f.add('bob', conversation);
  await waitFor(() => f.starts.length === 2);
  assert.equal(f.tasks.get('alice', next.id).status, 'queued');
  await assert.rejects(f.tasks.stop('bob', a.id), { status: 404 });
  await f.tasks.stop('alice', a.id);
  await waitFor(() => f.tasks.get('alice', a.id).status === 'cancelled');
  assert.equal(f.tasks.get('alice', next.id).status, 'interrupted');
  assert.equal(f.tasks.get('bob', b.id).status, 'running');
  f.finishes.get(b.id)();
  await waitFor(() => f.tasks.get('bob', b.id).status === 'done');
});

test('one user can occupy all available global slots without sharing credentials or controls', () => {
  const pool = createRunPool(4, 2);
  const a = { ownerId: 'alice', pluginToken: 'a' },
    b = { ownerId: 'alice', pluginToken: 'b' };
  pool.acquire('a', a);
  pool.acquire('b', b);
  assert.equal(pool.canRun('third', 'alice'), true);
  assert.equal(pool.canRun('third', 'bob'), true);
  pool.acquire('alice-third', { ownerId: 'alice', pluginToken: 'd' });
  const c = { ownerId: 'bob', pluginToken: 'c' };
  pool.acquire('third', c);
  assert.equal(pool.byToken('c'), c);
  pool.release('a', c);
  assert.equal(pool.size, 4);
  assert.equal(pool.canRun('fifth', 'alice'), false);
  assert.equal(pool.get('a'), a);
});

test('configuration accepts more than eight slots and bounds invalid or excessive limits consistently', () => {
  assert.deepEqual(concurrencyLimits(), {
    maxConcurrent: recommendedConcurrency(),
    maxConcurrentPerUser: recommendedConcurrency(),
  });
  assert.deepEqual(concurrencyLimits(16, 8), { maxConcurrent: 16, maxConcurrentPerUser: 16 });
  assert.deepEqual(concurrencyLimits(100, 100), { maxConcurrent: 32, maxConcurrentPerUser: 32 });
  assert.deepEqual(concurrencyLimits('invalid', Infinity), {
    maxConcurrent: recommendedConcurrency(),
    maxConcurrentPerUser: recommendedConcurrency(),
  });
  assert.deepEqual(concurrencyLimits(2, 8), { maxConcurrent: 2, maxConcurrentPerUser: 2 });
});
test('capacity recommendation follows CPU and host memory; native admission pauses under memory pressure', () => {
  assert.equal(recommendedConcurrency({ cpus: 2, memoryBytes: 1736 * 1024 * 1024 }), 8);
  assert.equal(recommendedConcurrency({ cpus: 64, memoryBytes: 64 * 1024 ** 3 }), 32);
  assert.equal(recommendedConcurrency({ cpus: 1, memoryBytes: 256 * 1024 ** 2 }), 1);
  let available = 1024 ** 3;
  const pool = createRunPool(8, 1, { availableMemory: () => available });
  pool.acquire('a', { ownerId: 'same', pluginToken: 'a' });
  pool.acquire('b', { ownerId: 'same', pluginToken: 'b' });
  available = 100 * 1024 ** 2;
  assert.equal(pool.canRun('c', 'same'), false);
  assert.throws(() => pool.acquire('c', {}), { status: 429 });
  available = 512 * 1024 ** 2;
  assert.equal(pool.canRun('c', 'same'), true);
});

test('pending queues have user and global bounds while retries remain idempotent at capacity', (t) => {
  const f = fixture(t, { available: () => false });
  let first;
  for (let user = 0; user < 25; user++) {
    for (let task = 0; task < 20; task++) {
      const p = f.add('user-' + user);
      if (!first) first = p;
    }
  }
  assert.throws(() => f.add('user-0'), { status: 429 });
  assert.throws(() => f.add('new-user'), { status: 429 });
  assert.equal(f.tasks.add('user-0', first).id, first.id);
  assert.equal(f.tasks.snapshot('user-0').tasks.length, 20);
  assert.equal(f.db.prepare('SELECT count(*) n FROM pi_tasks').get().n, 500);
});
