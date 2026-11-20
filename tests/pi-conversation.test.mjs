import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationEntries,
  latestCompletedTask,
  currentSessionContext,
  mergeSessionContext,
  messageDelivery,
  normalizeMessageMode,
} from '../shared/pi-conversation.mjs';

const task = (id, minute, status = 'done', extra = {}) => ({
  id,
  conversationId: 'a',
  createdAt: `2026-11-02T00:${minute}:00Z`,
  startedAt: `2026-11-02T00:${minute}:01Z`,
  status,
  input: id,
  output: '',
  tools: [],
  ...extra,
});

test('current observations survive stale history responses but never hide a newer completed task', () => {
  const old = task('old', '01', 'done', { context: { messageCount: 10 } });
  const turns = [{ id: old.id, createdAt: old.createdAt, execution: { context: old.context } }];
  const snapshot = { conversationId: 'a', revision: 3, baselineTaskId: 'old', context: { messageCount: 11 } };
  assert.deepEqual(currentSessionContext(turns, [old], 'a', snapshot), { messageCount: 11 });
  assert.equal(mergeSessionContext(snapshot, { ...snapshot, revision: 2 }, 'a'), snapshot);
  assert.equal(mergeSessionContext(snapshot, { ...snapshot, conversationId: 'b', revision: 4 }, 'a'), snapshot);
  assert.deepEqual(currentSessionContext(turns, [task('new', '02', 'done', { context: { messageCount: 12 } }), old], 'a', snapshot), { messageCount: 12 });
  assert.equal(currentSessionContext(turns, [old], 'a', { ...snapshot, context: null }), null);
  assert.equal(currentSessionContext([], [], 'a', { ...snapshot, baselineTaskId: null, context: null }), null);
  assert.deepEqual(currentSessionContext(turns, [old], 'a', null), old.context, 'old databases remain readable');
  assert.equal(currentSessionContext([], [], 'b', snapshot), null);
});

test('a task restored at the front of a snapshot supplies the newest session context after completion', () => {
  const previous = task('previous', '01', 'done', {
    context: { stats: { assistantMessages: 23, toolCalls: 32 } },
  });
  const running = task('restored-running', '02', 'running', {
    context: { stats: { assistantMessages: 26, toolCalls: 34 } },
  });
  // Snapshots put pending tasks first. Event replay updates that Map entry in
  // place, leaving it before older completed tasks even after it finishes.
  const replay = new Map([running, previous].map((t) => [t.id, t]));
  assert.equal(latestCompletedTask([...replay.values()], 'a'), previous);
  replay.set(running.id, { ...running, status: 'done' });
  const completed = latestCompletedTask([...replay.values()], 'a');
  assert.equal(completed.id, running.id);
  assert.deepEqual(completed.context.stats, { assistantMessages: 26, toolCalls: 34 });
  assert.deepEqual([...replay.keys()], [running.id, previous.id]);
});

test('session context selection ignores another conversation, supplements and unfinished tasks', () => {
  const previous = task('previous', '01');
  const latest = task('latest', '02');
  const snapshot = [latest, previous, task('foreign', '03', 'done', { conversationId: 'b' }),
    task('supplement', '04', 'done', { parentId: latest.id }), task('cancelled', '05', 'cancelled'),
    task('queued', '06', 'queued')];
  assert.equal(latestCompletedTask(snapshot, 'a'), latest);
  assert.equal(latestCompletedTask([...snapshot].reverse(), 'a'), latest);
  assert.equal(latestCompletedTask(snapshot, 'missing'), undefined);
  assert.equal(latestCompletedTask([], 'a'), undefined);
});

test('old failures stay before newer replies and active tasks in one conversation chronology', () => {
  const tasks = [
    task('running', '04', 'running'),
    task('old-failure', '01', 'error'),
    task('new-reply', '03'),
    task('other', '05', 'error', { conversationId: 'b' }),
    task('queued', '05', 'queued'),
  ];
  const turns = [
    { id: 'first', createdAt: '2026-11-02T00:00:00Z' },
    { id: 'new-reply', createdAt: '2026-11-02T00:03:50Z' },
  ];
  const entries = conversationEntries(turns, tasks, 'a');
  assert.deepEqual(
    entries.map((e) => e.turn.id),
    ['first', 'old-failure', 'new-reply', 'running'],
  );
  assert.equal(entries[1].task.status, 'error');
  assert.equal(entries[2].task, null);
  assert.equal(entries[2].submittedAt, tasks[2].createdAt);
  assert.deepEqual(
    conversationEntries(turns, [...tasks].reverse(), 'a').map((e) => e.turn.id),
    entries.map((e) => e.turn.id),
  );
});

test('completion before history refresh stays visible once and keeps its place after replay', () => {
  const completed = task('done', '02', 'done', {
    output: 'actual result',
    finishedAt: '2026-11-02T00:02:59Z',
    metrics: { toolCalls: 2 },
    attachmentFiles: [{ id: 'attachment' }],
  });
  const before = [{ id: 'previous', createdAt: '2026-11-02T00:01:00Z' }];
  const snapshot = conversationEntries(before, [completed], 'a');
  assert.equal(snapshot[1].turn.output, 'actual result');
  assert.equal(snapshot[1].turn.execution.metrics.toolCalls, 2);
  assert.equal(snapshot[1].turn.attachments[0].id, 'attachment');
  const replay = conversationEntries(
    [
      ...before,
      {
        id: 'done',
        output: 'saved result',
        createdAt: '2026-11-02T00:02:59Z',
        execution: { startedAt: completed.startedAt },
      },
    ],
    [completed],
    'a',
  );
  assert.deepEqual(
    replay.map((e) => e.turn.id),
    snapshot.map((e) => e.turn.id),
  );
  assert.equal(replay[1].turn.output, 'saved result');
  assert.equal(replay[1].task, null);
});

test('supplements stay with their parent without duplicate confirmed messages or forgotten failures', () => {
  const parent = task('parent', '01', 'running');
  const child = task('child', '02', 'accepted', { parentId: 'parent' });
  const failed = task('rejected', '03', 'error', { parentId: 'parent' });
  const orphan = task('orphan', '04', 'error', { parentId: 'missing' });
  const withdrawn = task('withdrawn', '05', 'cancelled', { startedAt: undefined });
  const live = conversationEntries([], [parent, child, failed, orphan, withdrawn], 'a');
  assert.deepEqual(
    live.map((e) => e.turn.id),
    ['parent', 'orphan'],
  );
  assert.deepEqual(
    live[0].supplements.map((t) => t.id),
    ['child', 'rejected'],
  );
  assert.deepEqual(
    conversationEntries([], [failed, child, parent], 'a')[0].supplements.map((t) => t.id),
    ['child', 'rejected'],
  );
  const saved = [
    {
      id: 'parent',
      createdAt: parent.createdAt,
      supplements: [{ id: 'child', input: 'confirmed' }],
    },
  ];
  const replay = conversationEntries(
    saved,
    [{ ...parent, status: 'done' }, { ...child, status: 'done' }, failed, orphan],
    'a',
  );
  assert.deepEqual(
    replay[0].supplements.map((t) => t.id),
    ['rejected'],
  );
  assert.deepEqual(conversationEntries(saved, [], 'a')[0].turn.supplements, saved[0].supplements);
});

test('new instructions default to steering while idle submissions remain independent queued tasks', () => {
  const active = { id: 'current' };
  assert.equal(normalizeMessageMode(null), 'steer');
  assert.equal(normalizeMessageMode('invalid'), 'steer');
  assert.deepEqual(messageDelivery(active, undefined), { mode: 'steer', parentId: 'current' });
  assert.deepEqual(messageDelivery(active, 'queue'), { mode: 'queue', parentId: null });
  assert.deepEqual(messageDelivery(null, 'steer'), { mode: 'queue', parentId: null });
});
