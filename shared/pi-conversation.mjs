import { longGoalControl } from '../deploy/pi/long-goal-command.mjs';

export const normalizeMessageMode = (value) => (value === 'queue' ? 'queue' : 'steer');

export function messageDelivery(activeTask, preference, input = '') {
  return activeTask && (longGoalControl(input) || normalizeMessageMode(preference) === 'steer')
    ? { mode: 'steer', parentId: activeTask.id }
    : { mode: 'queue', parentId: null };
}

export function latestCompletedTask(tasks, conversationId) {
  return tasks
    .filter(
      (task) => task.conversationId === conversationId && task.status === 'done' && !task.parentId,
    )
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
    .at(-1);
}

export function mergeSessionContext(previous, incoming, conversationId) {
  if (!incoming || incoming.conversationId !== conversationId) return previous;
  return previous?.conversationId === conversationId && previous.revision > incoming.revision
    ? previous
    : incoming;
}

export function currentSessionContext(turns, tasks, conversationId, snapshot) {
  const task = latestCompletedTask(tasks, conversationId);
  const turn = turns.at(-1);
  const candidates = [
    ...(turn
      ? [
          {
            id: turn.id,
            at: turn.execution?.finishedAt || turn.createdAt,
            context: turn.execution?.context,
          },
        ]
      : []),
    ...(task
      ? [
          {
            id: task.id,
            at: task.finishedAt || task.execution?.finishedAt || task.createdAt,
            context: task.context || task.execution?.context,
          },
        ]
      : []),
  ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const latest = candidates.at(-1);
  if (
    snapshot?.conversationId === conversationId &&
    snapshot.baselineTaskId === (latest?.id || null)
  )
    return snapshot.context;
  return latest?.context || null;
}

const incomplete = (task) =>
  ['error', 'interrupted'].includes(task.status) ||
  (task.status === 'cancelled' && !!task.startedAt);

function taskTurn(task) {
  return {
    id: task.id,
    input: task.input,
    output: task.output,
    createdAt: task.createdAt,
    projectId: task.projectId,
    access: task.access,
    thinking: task.thinking,
    timeline: task.timeline,
    tools: task.tools,
    attachments: task.attachmentFiles || [],
    artifacts: task.artifacts || [],
    execution: {
      ...task.execution,
      startedAt: task.startedAt || task.execution?.startedAt,
      finishedAt: task.finishedAt || task.execution?.finishedAt,
      metrics: task.metrics || task.execution?.metrics,
      context: task.context || task.execution?.context,
    },
  };
}

// One chronology for completed history and live/failed task snapshots. A status
// transition changes the row's contents, never its position or identity.
export function conversationEntries(turns, tasks, conversationId) {
  const scoped = tasks
    .filter((task) => task.conversationId === conversationId)
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const byId = new Map(scoped.map((task) => [task.id, task]));
  const represented = new Set(turns.flatMap((turn) => (turn.supplements || []).map((s) => s.id)));
  const entries = turns.map((turn) => ({
    turn,
    task: null,
    submittedAt: byId.get(turn.id)?.createdAt || turn.execution?.startedAt || turn.createdAt,
    supplements: [],
  }));
  const ids = new Set(turns.map((turn) => turn.id));
  for (const task of scoped) {
    if (task.parentId || ids.has(task.id)) continue;
    if (!['running', 'stopping', 'done'].includes(task.status) && !incomplete(task)) continue;
    entries.push({ turn: taskTurn(task), task, submittedAt: task.createdAt, supplements: [] });
    ids.add(task.id);
  }
  for (const entry of entries) {
    const saved = new Set((entry.turn.supplements || []).map((s) => s.id));
    entry.supplements = scoped.filter(
      (task) => task.parentId === entry.turn.id && !saved.has(task.id),
    );
  }
  for (const task of scoped) {
    if (task.parentId && !ids.has(task.parentId) && !represented.has(task.id) && incomplete(task))
      entries.push({ turn: taskTurn(task), task, submittedAt: task.createdAt, supplements: [] });
  }
  return entries.sort(
    (a, b) => (Date.parse(a.submittedAt) || 0) - (Date.parse(b.submittedAt) || 0),
  );
}
