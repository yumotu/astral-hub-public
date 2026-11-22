import { normalizeAgentEvent, projectWorkbenchSnapshot } from './agent-workbench.mjs';

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty text`);
  return value.trim();
}

function id(value, field) {
  return text(value || crypto.randomUUID(), field);
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

/**
 * Small event-sourced P1 core. It is intentionally in-memory and side-effect
 * free. Persistence, authorization and real executors are later adapters.
 */
export function createPersonalAgentStore({ ownerId = 'demo-owner', clock = Date.now, events = [] } = {}) {
  const owner = text(ownerId, 'ownerId');
  const log = events.map(normalizeAgentEvent).filter((item) => item.ownerId === owner);
  const eventIds = new Set(log.map((item) => item.id));
  const operations = new Map();

  function append(input, operationId) {
    if (operationId && operations.has(operationId)) return operations.get(operationId);
    const item = normalizeAgentEvent({
      id: id(input.id, 'event.id'),
      ownerId: owner,
      occurredAt: input.occurredAt || nowIso(clock),
      ...input,
    });
    if (!eventIds.has(item.id)) {
      log.push(item);
      eventIds.add(item.id);
    }
    if (operationId) operations.set(operationId, item);
    return item;
  }

  function snapshot() {
    return projectWorkbenchSnapshot(log, { ownerId: owner });
  }

  function createGoal(input, operationId) {
    const goalId = id(input.goalId, 'goalId');
    return append({
      id: id(operationId ? `goal-created:${operationId}` : undefined, 'event.id'),
      type: 'goal.created', source: 'planner', sourceId: goalId,
      payload: { goalId, title: text(input.title, 'goal.title'), status: 'planned', progress: 0, conversationId: text(input.conversationId, 'goal.conversationId'), engine: text(input.engine || 'Pi', 'goal.engine') },
    }, operationId);
  }

  function progressGoal(input, operationId) {
    return append({
      id: id(operationId ? `goal-progress:${operationId}` : undefined, 'event.id'),
      type: 'goal.progress', source: 'planner', sourceId: text(input.goalId, 'goalId'),
      payload: { goalId: text(input.goalId, 'goalId'), progress: Math.max(0, Math.min(100, Number(input.progress) || 0)), ...(input.step ? { step: text(input.step, 'goal.step') } : {}), ...(input.report ? { report: text(input.report, 'goal.report') } : {}) },
    }, operationId);
  }

  function createTask(input, operationId) {
    const taskId = id(input.taskId, 'taskId');
    return append({
      id: id(operationId ? `task-created:${operationId}` : undefined, 'event.id'),
      type: 'task.created', source: 'planner', sourceId: taskId,
      payload: { taskId, title: text(input.title, 'task.title'), status: 'planned', progress: 0, ...(input.goalId ? { goalId: text(input.goalId, 'task.goalId') } : {}), conversationId: text(input.conversationId, 'task.conversationId'), engine: text(input.engine || 'Pi', 'task.engine') },
    }, operationId);
  }

  function reportTask(input, operationId) {
    return append({
      id: id(operationId ? `task-progress:${operationId}` : undefined, 'event.id'),
      type: 'task.progress', source: 'executor', sourceId: text(input.taskId, 'taskId'),
      payload: { taskId: text(input.taskId, 'taskId'), status: input.status || 'running', progress: Math.max(0, Math.min(100, Number(input.progress) || 0)), ...(input.step ? { step: text(input.step, 'task.step') } : {}) },
    }, operationId);
  }

  function startRun(input, operationId) {
    const runId = id(input.runId, 'runId');
    return append({
      id: id(operationId ? `run-started:${operationId}` : undefined, 'event.id'),
      type: 'run.started', source: 'executor', sourceId: runId,
      payload: { runId, taskId: text(input.taskId, 'run.taskId'), conversationId: text(input.conversationId, 'run.conversationId'), engine: text(input.engine || 'Pi', 'run.engine'), status: 'streaming', progress: 0 },
    }, operationId);
  }

  function reportRun(input, operationId) {
    return append({
      id: id(operationId ? `run-reported:${operationId}` : undefined, 'event.id'),
      type: input.unknown ? 'run.unknown_result' : 'run.reported', source: 'executor', sourceId: text(input.runId, 'runId'),
      payload: { runId: text(input.runId, 'runId'), taskId: text(input.taskId, 'run.taskId'), status: input.unknown ? 'unknown_result' : input.status || 'streaming', progress: Math.max(0, Math.min(100, Number(input.progress) || 0)), ...(input.report ? { report: text(input.report, 'run.report') } : {}) },
    }, operationId);
  }

  function createAttention(input, operationId) {
    const attentionId = id(input.attentionId, 'attentionId');
    return append({
      id: id(operationId ? `attention-created:${operationId}` : undefined, 'event.id'),
      type: 'attention.created', source: text(input.source || 'agent', 'attention.source'), sourceId: attentionId,
      payload: { attentionId, kind: text(input.kind || 'user', 'attention.kind'), title: text(input.title, 'attention.title'), status: '待决定', question: text(input.question, 'attention.question') },
    }, operationId);
  }

  function resolveAttention(input, operationId) {
    return append({
      id: id(operationId ? `attention-resolved:${operationId}` : undefined, 'event.id'),
      type: 'attention.resolved', source: 'user', sourceId: text(input.attentionId, 'attentionId'),
      payload: { attentionId: text(input.attentionId, 'attentionId'), status: 'resolved', answer: text(input.answer, 'attention.answer') },
    }, operationId);
  }

  return Object.freeze({
    ownerId: owner,
    append,
    snapshot,
    events: () => log.map((item) => structuredClone(item)),
    createGoal,
    progressGoal,
    createTask,
    reportTask,
    startRun,
    reportRun,
    createAttention,
    resolveAttention,
  });
}
