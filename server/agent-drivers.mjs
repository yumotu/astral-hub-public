import { agentOrigin, agentRuntimeSchema } from '../shared/agent-runtime.mjs';
import { fail } from './accounts.mjs';

// DSH remains disabled until its transport and tool bridge have passed acceptance.
// A flag alone never installs an adapter or falls back to another backend.
export function createAgentDrivers({ bindings, adapters = [], dshEnabled = false }) {
  const routes = new Map();
  for (const adapter of adapters) {
    const key = `${adapter.backend}:${adapter.transport}`;
    if (routes.has(key)) throw Error('Agent 适配器重复。');
    routes.set(key, adapter);
  }
  function resolve(owner, task) {
    const runtime = agentRuntimeSchema.parse(task.runtime);
    const origin = agentOrigin(runtime);
    const bound = bindings.get(owner, origin, task.conversationId);
    if (
      !bound ||
      Object.keys(runtime).some((key) => bound[key] !== runtime[key]) ||
      runtime.projectId !== (task.projectId || null) ||
      (runtime.transport === 'astral-relay' && runtime.deviceId !== task.deviceId)
    )
      throw fail(409, '任务与原 Agent 会话或执行位置不匹配。');
    if (runtime.backend === 'dsh' && !dshEnabled)
      throw fail(503, 'DSH 接入尚未启用，请使用原 Pi 对话。');
    const adapter = routes.get(`${runtime.backend}:${runtime.transport}`);
    if (!adapter) throw fail(503, '当前 Agent 执行通道尚未接入。');
    return adapter;
  }
  return {
    resolve,
    available(owner, task) {
      try {
        return resolve(owner, task).available?.(owner, task) === true;
      } catch {
        return false;
      }
    },
    invoke(method, owner, task, ...args) {
      // Fixed entry points; model input cannot call arbitrary adapter properties.
      if (!['run', 'steer', 'cancel', 'respond', 'prepareQuestionResume'].includes(method))
        throw fail(400, '未知 Agent 操作。');
      const adapter = resolve(owner, task);
      if (typeof adapter[method] !== 'function') throw fail(503, '当前 Agent 尚未提供这项操作。');
      return adapter[method](owner, task, ...args);
    },
  };
}
