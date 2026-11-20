import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createPiSchedulePump } from '../server/pi-schedules.mjs';
import { createPiTasks } from '../server/pi-tasks.mjs';
const owner = randomUUID(),
  conversationId = randomUUID();
const submission = () => ({
  id: randomUUID(),
  ownerId: owner,
  conversationId,
  jobId: 'job',
  jobName: 'check',
  scheduledAt: '2026-11-02T08:00:00Z',
  input: '检查项目',
  projectId: null,
  access: 'read',
  thinkingLevel: 'off',
  timeZone: 'Asia/Shanghai',
  toolAllowlist: ['web_search'],
  skills: [],
  status: 'queued',
  createdAt: new Date().toISOString(),
  output: '',
  error: '',
});

test('computer schedules only enter their bound computer queue; offline/unavailable targets never fall back to Pi', async () => {
  const run = {
      ...submission(),
      projectId: randomUUID(),
      target: { kind: 'computer', deviceId: randomUUID(), execute: false },
      toolAllowlist: null,
    },
    ack = [];
  let admissions = 0,
    available = true,
    revoked = false;
  const pump = createPiSchedulePump({
    bridge: async (path, p) => (path.endsWith('/pending') ? { runs: [run] } : (ack.push(p), {})),
    tasks: {
      get: () => {
        throw Error('server fallback');
      },
      add: () => {
        throw Error('server fallback');
      },
    },
    ownerAllowed: () => true,
    scope: () => null,
    completed: () => null,
    computer: async (actual) => {
      admissions++;
      assert.deepEqual(actual.target, run.target);
      if (revoked) throw Object.assign(Error('authorization revoked'), { status: 403 });
      return available ? { id: run.id, status: 'queued' } : undefined;
    },
  });
  try {
    await pump.tick();
    assert.equal(ack.at(-1).status, 'accepted');
    available = false;
    ack.length = 0;
    await pump.tick();
    assert.equal(ack.length, 0);
    revoked = true;
    await pump.tick();
    assert.equal(ack.at(-1).status, 'error');
    assert.equal(ack.at(-1).disablePlan, true);
    assert.equal(admissions, 3);
  } finally {
    pump.close();
  }
});
test('schedule admissions reuse the durable chat queue and never replay an uncertain execution on restart', async () => {
  const db = new DatabaseSync(':memory:'),
    run = submission(),
    acknowledgements = [];
  const options = { available: () => false, completed: () => false };
  let tasks = createPiTasks(db, options);
  const bridge = async (path, data) => {
    if (path.endsWith('/pending')) return { runs: [run] };
    acknowledgements.push(data);
    return { ok: true };
  };
  let pump = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: (id) => id === owner,
    scope: () => null,
    completed: () => null,
  });
  try {
    await pump.tick();
    await pump.tick();
    assert.equal(tasks.all(owner).length, 1);
    assert.equal(tasks.get(owner, run.id).schedule.jobId, 'job');
    assert.deepEqual(tasks.get(owner, run.id).toolAllowlist, ['web_search']);
    assert.equal(acknowledgements.at(-1).status, 'accepted');
    const state = tasks.get(owner, run.id);
    db.prepare('UPDATE pi_tasks SET state=? WHERE owner=? AND id=?').run(
      JSON.stringify({ ...state, status: 'running' }),
      owner,
      run.id,
    );
    pump.close();
    tasks.close();
    tasks = createPiTasks(db, options);
    pump = createPiSchedulePump({
      bridge,
      tasks,
      ownerAllowed: () => true,
      scope: () => null,
      completed: () => null,
    });
    await pump.tick();
    assert.equal(tasks.all(owner).length, 1);
    assert.equal(acknowledgements.at(-1).status, 'interrupted');
  } finally {
    pump.close();
    tasks.close();
    db.close();
  }
});
test('schedule submissions enforce owner, scope and payload validation; capacity limits retain pending work', async () => {
  const run = submission(),
    ack = [];
  let adds = 0;
  const bridge = async (path, data) =>
    path.endsWith('/pending') ? { runs: [run] } : (ack.push(data), {});
  const tasks = {
    get: () => null,
    add() {
      adds++;
      throw Object.assign(new Error('busy'), { status: 429 });
    },
  };
  let pump = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: () => false,
    scope: () => null,
    completed: () => null,
  });
  await pump.tick();
  pump.close();
  assert.equal(adds, 0);
  assert.equal(ack.at(-1).status, 'error');
  ack.length = 0;
  pump = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: () => true,
    scope: () => ({ projectId: 'other', access: 'edit' }),
    completed: () => null,
  });
  await pump.tick();
  pump.close();
  assert.equal(adds, 0);
  assert.equal(ack.at(-1).status, 'error');
  ack.length = 0;
  pump = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: () => true,
    scope: () => null,
    completed: () => null,
  });
  await pump.tick();
  pump.close();
  assert.equal(adds, 1);
  assert.equal(ack.length, 0);
  run.bridgeToken = 'forged';
  pump = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: () => true,
    scope: () => null,
    completed: () => null,
  });
  await pump.tick();
  pump.close();
  assert.equal(adds, 1);
});

test('deleted conversations stay closed when a later scheduled occurrence is delivered', async () => {
  const db = new DatabaseSync(':memory:'),
    run = submission(),
    ack = [];
  const tasks = createPiTasks(db, { available: () => false, completed: () => false });
  tasks.closeConversation(owner, conversationId);
  const pump = createPiSchedulePump({
    tasks,
    ownerAllowed: () => true,
    scope: () => null,
    completed: () => null,
    bridge: async (path, p) => (path.endsWith('/pending') ? { runs: [run] } : (ack.push(p), {})),
  });
  try {
    await pump.tick();
    assert.equal(tasks.all(owner).length, 0);
    assert.equal(ack[0].status, 'error');
    assert.match(ack[0].error, /已删除/);
  } finally {
    pump.close();
    tasks.close();
    db.close();
  }
});
