// P2 synthetic DPH adapter. The real DPH transport will implement the same
// boundary later. This adapter only emits domain events into the local store.

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty text`);
  return value.trim();
}

function boundedProgress(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export function createDphExecutorAdapter({ store } = {}) {
  if (!store || typeof store.startRun !== 'function' || typeof store.snapshot !== 'function') {
    throw new TypeError('DPH adapter requires a personal agent store');
  }

  function start(input, operationId) {
    return store.startRun({
      runId: text(input.runId, 'runId'),
      taskId: text(input.taskId, 'taskId'),
      conversationId: text(input.conversationId, 'conversationId'),
      engine: 'DPH',
    }, operationId);
  }

  function progress(input, operationId) {
    const runId = text(input.runId, 'runId');
    const taskId = text(input.taskId, 'taskId');
    const progressValue = boundedProgress(input.progress);
    store.reportRun({ runId, taskId, progress: progressValue, report: input.report }, operationId ? `${operationId}:run` : undefined);
    return store.reportTask({ taskId, progress: progressValue, status: progressValue >= 100 ? 'succeeded' : 'running', step: input.step }, operationId ? `${operationId}:task` : undefined);
  }

  function waitForUser(input, operationId) {
    return store.createAttention({
      attentionId: text(input.attentionId, 'attentionId'),
      kind: 'dph',
      source: 'dph',
      title: text(input.title, 'attention.title'),
      question: text(input.question, 'attention.question'),
    }, operationId);
  }

  function finish(input, operationId) {
    const runId = text(input.runId, 'runId');
    const taskId = text(input.taskId, 'taskId');
    const progressValue = boundedProgress(input.progress ?? 100);
    store.reportRun({ runId, taskId, progress: progressValue, status: 'finished', report: input.report }, operationId ? `${operationId}:run` : undefined);
    return store.reportTask({ taskId, progress: progressValue, status: 'succeeded', step: '已完成，等待验收' }, operationId ? `${operationId}:task` : undefined);
  }

  function unknown(input, operationId) {
    return store.reportRun({
      runId: text(input.runId, 'runId'),
      taskId: text(input.taskId, 'taskId'),
      progress: boundedProgress(input.progress),
      unknown: true,
      report: input.report || '传输中断，结果需要核对',
    }, operationId);
  }

  return Object.freeze({ start, progress, waitForUser, finish, unknown, snapshot: store.snapshot });
}
