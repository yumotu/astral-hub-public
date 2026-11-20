import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPiTasks } from '../server/pi-tasks.mjs';

test('a lagging client catches the current partial answer before completion without replaying every character', async (t) => {
  const db = new DatabaseSync(':memory:');
  const tasks = createPiTasks(db, {
    available: () => false, completed: () => false,
    run: async () => ({ output: '' }), cancel: async () => {},
  });
  t.after(() => { tasks.close(); db.close(); });
  const add = (owner, id) => tasks.add(owner, { id, conversationId: id, input: 'synthetic', mode: 'queue', attachments: [] });
  add('alice', 'one'); add('bob', 'private');
  const before = tasks.snapshot('alice').cursor;
  for (let i = 0; i < 1000; i++) tasks.event('alice', 'one', { type: 'thinking_delta', delta: '想' });
  tasks.event('bob', 'private', { type: 'text_delta', delta: 'must stay private' });
  for (const delta of ['正文', '正在', '流式输出']) tasks.event('alice', 'one', { type: 'text_delta', delta });
  const recovered = await tasks.changes('alice', before, {}, { destroyed: false });
  assert.equal(recovered.events.length, 1);
  const current = recovered.events[0].event.task;
  assert.equal(current.output, '正文正在流式输出');
  assert.equal(current.thinking, '想'.repeat(1000));
  assert.equal(current.phase, '正在回复');
  assert.notEqual(current.status, 'done');
  assert.equal(recovered.cursor, tasks.snapshot('alice').cursor);
  assert.ok(!JSON.stringify(recovered).includes('must stay private'));
  tasks.event('alice', 'one', { type: 'text_delta', delta: '，继续' });
  const live = await tasks.changes('alice', recovered.cursor, {}, { destroyed: false });
  assert.equal(live.events.length, 1);
  assert.deepEqual(live.events[0].event, { type: 'text_delta', delta: '，继续' });
  assert.ok(live.cursor > recovered.cursor);
});

test('snapshot catch-up keeps every changed conversation when more than 200 conversations have events', async (t) => {
  const db = new DatabaseSync(':memory:');
  const tasks = createPiTasks(db, {
    available: () => false, completed: () => false,
    run: async () => ({ output: '' }), cancel: async () => {},
  });
  t.after(() => { tasks.close(); db.close(); });
  for (let i = 0; i < 205; i++) {
    const id = `task-${i}`;
    tasks.add('alice', { id, conversationId: id, input: 'synthetic', mode: 'queue', attachments: [] });
    db.prepare("UPDATE pi_tasks SET state=json_set(state,'$.status','done') WHERE id=?").run(id);
    tasks.event('alice', id, { type: 'text_delta', delta: `answer-${i}` });
  }
  const first = await tasks.changes('alice', 0, {}, { destroyed: false });
  assert.equal(first.events.length, 200);
  const second = await tasks.changes('alice', first.cursor, {}, { destroyed: false });
  const ids = new Set([...first.events, ...second.events].map((r) => r.taskId));
  assert.equal(ids.size, 205);
  assert.equal(second.cursor, tasks.snapshot('alice').cursor);
  assert.equal(first.events[0].event.task.output, 'answer-0');
});
