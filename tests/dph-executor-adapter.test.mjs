import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAgentStore } from '../shared/personal-agent-core.mjs';
import { createDphExecutorAdapter } from '../shared/dph-executor-adapter.mjs';

const clock = () => Date.parse('2026-11-22T00:00:00.000Z');

function fixture() {
  const store = createPersonalAgentStore({ ownerId: 'demo-owner', clock });
  store.createTask({ taskId: 'task-1', title: 'DPH 合成任务', conversationId: 'conversation-1', engine: 'DPH' }, 'task-create');
  const adapter = createDphExecutorAdapter({ store });
  adapter.start({ runId: 'run-1', taskId: 'task-1', conversationId: 'conversation-1' }, 'run-start');
  return { store, adapter };
}

test('DPH adapter synchronizes progress into the same workbench snapshot', () => {
  const { store, adapter } = fixture();
  adapter.progress({ runId: 'run-1', taskId: 'task-1', progress: 45, step: '读取项目上下文', report: '已读取' }, 'progress-1');
  const snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].engine, 'DPH');
  assert.equal(snapshot.runs[0].progress, 45);
  assert.equal(snapshot.tasks[0].progress, 45);
  assert.equal(snapshot.tasks[0].status, 'running');
});

test('DPH waiting and completion remain explicit and idempotent', () => {
  const { store, adapter } = fixture();
  adapter.waitForUser({ attentionId: 'attention-1', title: '需要用户确认', question: '是否继续执行？' }, 'attention-1');
  adapter.waitForUser({ attentionId: 'attention-1', title: '需要用户确认', question: '是否继续执行？' }, 'attention-1');
  adapter.finish({ runId: 'run-1', taskId: 'task-1', report: '合成执行完成' }, 'finish-1');
  const snapshot = store.snapshot();
  assert.equal(snapshot.attentions.length, 1);
  assert.equal(snapshot.runs[0].status, 'finished');
  assert.equal(snapshot.tasks[0].status, 'succeeded');
});

test('DPH unknown result is preserved for later reconciliation', () => {
  const { store, adapter } = fixture();
  adapter.unknown({ runId: 'run-1', taskId: 'task-1', progress: 20 }, 'unknown-1');
  assert.equal(store.snapshot().runs[0].status, 'unknown_result');
});
