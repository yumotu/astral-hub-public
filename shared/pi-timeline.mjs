// Ordered, bounded execution trace shared by server snapshots and the web client.
export function applyPiTimeline(items = [], event = {}) {
  const next = items.map((item) => ({ ...item }));
  const last = next.at(-1);
  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    const kind = event.type === 'text_delta' ? 'text' : 'thinking';
    const delta = String(event.delta || '');
    if (!delta) return next;
    if (last?.kind === kind) last.text = (last.text + delta).slice(-48000);
    else next.push({ kind, text: delta.slice(-48000) });
  } else if (event.type === 'tool_start' && typeof event.id === 'string') {
    if (!next.some((item) => item.kind === 'tool' && item.id === event.id))
      next.push({
        kind: 'tool',
        id: event.id,
        name: String(event.name || ''),
        path: String(event.path || ''),
        status: 'running',
        ...(typeof event.command === 'string' ? { command: event.command.slice(0, 8000) } : {}),
        ...(typeof event.arguments === 'string'
          ? { arguments: event.arguments.slice(0, 12000) }
          : {}),
      });
  } else if (event.type === 'tool_output' || event.type === 'tool_end') {
    const item = next.find((item) => item.kind === 'tool' && item.id === event.id);
    if (item) {
      if (event.type === 'tool_end') item.status = event.error ? 'error' : 'done';
      for (const key of ['output', 'summary', 'projectId', 'backupId', 'sha256'])
        if (typeof event[key] === 'string')
          item[key] = event[key].slice(0, key === 'output' ? 12000 : 500);
      for (const key of ['exitCode', 'added', 'removed'])
        if (Number.isInteger(event[key])) item[key] = event[key];
      if (Array.isArray(event.todos)) item.todos = normalizeTodos(event.todos);
      if (typeof event.todoAction === 'string') item.todoAction = event.todoAction.slice(0, 30);
    }
  }
  return next.slice(-300);
}
import { normalizeTodos } from './pi-activity.mjs';

export function interruptedTools(
  task,
  reason = '任务已中断，动作是否完成需核验；不要直接重复执行。',
) {
  const settle = (item) =>
    item.status === 'running'
      ? {
          ...item,
          status: 'error',
          summary: '已中断 · 结果待核验',
          output: [item.output || '', reason].filter(Boolean).join('\n').slice(-12000),
        }
      : item;
  return {
    tools: (task.tools || []).map(settle),
    timeline: (task.timeline || []).map((item) => (item.kind === 'tool' ? settle(item) : item)),
  };
}
