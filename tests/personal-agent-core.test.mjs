import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAgentStore } from '../shared/personal-agent-core.mjs';

const clock = () => Date.parse('2026-11-22T00:00:00.000Z');

test('P1 local core creates a goal, task, run and attention in one read snapshot', () => {
  const store = createPersonalAgentStore({ ownerId: 'alice', clock });
  store.createGoal({ goalId: 'goal-1', title: '准备考试', conversationId: 'conversation-1', engine: 'DPH' }, 'op-goal');
  store.createTask({ taskId: 'task-1', title: '整理资料', goalId: 'goal-1', conversationId: 'conversation-1', engine: 'DPH' }, 'op-task');
  store.startRun({ runId: 'run-1', taskId: 'task-1', conversationId: 'conversation-1', engine: 'DPH' }, 'op-run');
  store.createAttention({ attentionId: 'attention-1', title: '需要确认', question: '是否继续？' }, 'op-attention');
  const snapshot = store.snapshot();
  assert.equal(snapshot.goals[0].id, 'goal-1');
  assert.equal(snapshot.tasks[0].status, 'planned');
  assert.equal(snapshot.runs[0].status, 'streaming');
  assert.equal(snapshot.attentions[0].status, '待决定');
  assert.equal(snapshot.readOnly, true);
});

test('P1 commands are idempotent and unknown results remain visible', () => {
  const store = createPersonalAgentStore({ ownerId: 'alice', clock });
  const first = store.startRun({ runId: 'run-1', taskId: 'task-1', conversationId: 'conversation-1', engine: 'Pi' }, 'same-operation');
  const second = store.startRun({ runId: 'run-1', taskId: 'task-1', conversationId: 'conversation-1', engine: 'Pi' }, 'same-operation');
  assert.deepEqual(first, second);
  store.reportRun({ runId: 'run-1', taskId: 'task-1', progress: 40, unknown: true }, 'unknown-operation');
  assert.equal(store.snapshot().runs[0].status, 'unknown_result');
  assert.equal(store.events().length, 2);
});

test('attention must be explicitly resolved before it leaves the snapshot', () => {
  const store = createPersonalAgentStore({ ownerId: 'alice', clock });
  store.createAttention({ attentionId: 'attention-1', title: '授权', question: '允许吗？' }, 'create-attention');
  store.resolveAttention({ attentionId: 'attention-1', answer: '允许本次' }, 'resolve-attention');
  assert.equal(store.snapshot().attentions[0].status, 'resolved');
  assert.equal(store.snapshot().attentions[0].answer, '允许本次');
});
