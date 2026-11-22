import { fail } from './accounts.mjs';

const terminal = new Set(['succeeded', 'failed', 'unknown', 'cancelled']);

/**
 * Dispatches a persisted SuperAgent task to a configured runtime adapter.
 * Adapters own the actual Pi/DPH/Remote transport. The dispatcher only
 * controls the Leader -> subagent lifecycle and never retries an unknown
 * side effect.
 */
export function createSubagentDispatcher({ ledger, adapters = {} } = {}) {
  if (!ledger || typeof ledger.get !== 'function' || typeof ledger.report !== 'function') throw new TypeError('subagent dispatcher requires a task ledger');
  const inFlight = new Map();

  function adapterFor(runtime) {
    const adapter = adapters[runtime];
    return adapter && typeof adapter.start === 'function' ? adapter : null;
  }

  async function dispatch(owner, taskId) {
    const key = `${owner}:${taskId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = ledger.get(owner, taskId);
    if (!task) throw fail(404, '委派任务不存在。');
    if (terminal.has(task.status)) return task;
    const adapter = adapterFor(task.runtime);
    if (!adapter) return task;
    const promise = (async () => {
      let current = ledger.get(owner, taskId);
      if (!current || terminal.has(current.status)) return current;
      if (current.status === 'queued') current = ledger.report(owner, taskId, { status: 'running', revision: current.revision, progress: current.progress });
      const report = (patch) => {
        const latest = ledger.get(owner, taskId);
        if (!latest || terminal.has(latest.status)) return latest;
        return ledger.report(owner, taskId, { ...patch, revision: latest.revision });
      };
      try {
        const result = await adapter.start({ owner, task: current, report });
        const latest = ledger.get(owner, taskId);
        if (!latest || terminal.has(latest.status)) return latest;
        if (result?.status && terminal.has(result.status)) return ledger.report(owner, taskId, { ...result, revision: latest.revision });
        return latest;
      } catch (error) {
        const latest = ledger.get(owner, taskId);
        if (!latest || terminal.has(latest.status)) return latest;
        const reason = error instanceof Error ? error.message : 'subagent 执行失败';
        return ledger.report(owner, taskId, { status: 'unknown', revision: latest.revision, report: reason });
      }
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  async function stop(owner, taskId) {
    const task = ledger.get(owner, taskId);
    if (!task) throw fail(404, '委派任务不存在。');
    if (terminal.has(task.status)) return task;
    await adapters[task.runtime]?.stop?.({ owner, task });
    const latest = ledger.get(owner, taskId);
    return latest && !terminal.has(latest.status) ? ledger.stop(owner, taskId, latest.revision) : latest;
  }

  return Object.freeze({ dispatch, stop, inFlight: () => inFlight.size });
}
