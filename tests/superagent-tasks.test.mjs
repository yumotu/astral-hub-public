import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createSuperAgent } from '../server/superagent.mjs';

test('SuperAgent task ledger persists Leader to subagent delegation and isolates owners', () => {
  const db = new DatabaseSync(':memory:');
  let clock = Date.parse('2026-11-22T00:00:00.000Z');
  const ledger = createSuperAgent(db, { now: () => clock });
  const id = randomUUID();
  const created = ledger.create('alice', { id, title: '整理邮件', input: '整理本周邮件并生成待办', runtime: 'DPH' });
  assert.equal(created.executor, 'subagent');
  assert.equal(created.status, 'queued');
  assert.deepEqual(ledger.list('bob'), []);
  assert.deepEqual(ledger.create('alice', { id, title: '整理邮件', input: '整理本周邮件并生成待办', runtime: 'DPH' }), created);
  assert.throws(() => ledger.create('alice', { id, title: '另一任务', input: '不同内容', runtime: 'DPH' }), { status: 409 });

  clock += 1000;
  const running = ledger.report('alice', id, { status: 'running', revision: 1, progress: 25 });
  assert.equal(running.progress, 25);
  const waiting = ledger.report('alice', id, { status: 'waiting_user', revision: 2, progress: 40, attention: '请确认是否继续发送草稿。' });
  assert.equal(waiting.attention, '请确认是否继续发送草稿。');
  const resumed = ledger.report('alice', id, { status: 'running', revision: 3, progress: 60 });
  assert.equal(resumed.status, 'running');
  const done = ledger.report('alice', id, { status: 'succeeded', revision: 4, progress: 100, report: 'subagent 已完成整理。' });
  assert.equal(done.status, 'succeeded');
  assert.equal(ledger.snapshot('alice').counts.completed, 1);
  assert.throws(() => ledger.report('alice', id, { status: 'running', revision: 5 }), { status: 409 });
  db.close();
});

test('SuperAgent task ledger does not replay unknown or cancelled work', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = createSuperAgent(db);
  const id = randomUUID();
  ledger.create('alice', { id, title: '远程检查', input: '检查项目构建', runtime: 'Remote' });
  const cancelled = ledger.stop('alice', id, 1);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => ledger.stop('alice', id, 2), { status: 409 });
  db.close();
});
