// Presentation adapters for actual Pi tool results and stream telemetry.
const todoNames = new Set(['todo', 'todos', 'todowrite', 'todo_write', 'update_plan']);
export const isTodoTool = (name) => todoNames.has(String(name).toLowerCase());
export function normalizeTodos(value) {
  if (!Array.isArray(value)) return null;
  const items = value.slice(0, 100).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const text = item.text ?? item.content ?? item.step;
    if (typeof text !== 'string' || !text.trim()) return [];
    const states = {
      pending: 'pending',
      todo: 'pending',
      in_progress: 'running',
      running: 'running',
      completed: 'done',
      done: 'done',
      cancelled: 'cancelled',
    };
    const status =
      (Object.hasOwn(states, item.status) ? states[item.status] : null) ||
      (typeof item.done === 'boolean' ? (item.done ? 'done' : 'pending') : null);
    if (!status) return [];
    return [
      { id: String(item.id ?? index + 1).slice(0, 160), text: text.trim().slice(0, 2000), status },
    ];
  });
  return value.length && !items.length ? null : items;
}
export function todoSnapshot(tool) {
  if (!isTodoTool(tool.name) || tool.status === 'error' || tool.status === 'running') return null;
  if (Array.isArray(tool.todos)) return normalizeTodos(tool.todos);
  const output = String(tool.output || '');
  try {
    const data = JSON.parse(output);
    const list = normalizeTodos(data.todos ?? data.plan);
    if (list) return list;
  } catch {}
  // Compatibility with Pi's original todo extension and pre-upgrade histories.
  const rows = output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*\[([ xX~✓])\]\s*#([^:：]+)[:：]\s*(.+)$/);
    return match
      ? [
          {
            id: match[2].trim(),
            text: match[3],
            status: /[xX✓]/.test(match[1]) ? 'done' : match[1] === '~' ? 'running' : 'pending',
          },
        ]
      : [];
  });
  if (rows.length) return normalizeTodos(rows);
  return /^No todos\s*$/i.test(output.trim()) ? [] : null;
}
export function latestTodo(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const list = todoSnapshot(items[i]);
    if (list !== null) return { items: list, source: items[i] };
  }
  return null;
}
// History can outlive the task cache; a task without a new snapshot must not erase it.
export function conversationTodo(turns, tasks, conversationId) {
  const records = [
    ...turns,
    ...tasks.filter((task) => task.conversationId === conversationId && !task.parentId),
  ];
  const timestamp = (record) =>
    Date.parse(
      record.execution?.finishedAt ||
        record.finishedAt ||
        record.startedAt ||
        record.execution?.startedAt ||
        record.createdAt,
    ) || 0;
  records.sort((a, b) => timestamp(a) - timestamp(b));
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const snapshot = latestTodo(record.timeline || []) ?? latestTodo(record.tools || []);
    if (snapshot !== null) return snapshot;
  }
  return null;
}
export function groupActivities(items, showThinking) {
  const groups = [];
  for (const [index, item] of items.entries()) {
    if (item.kind === 'thinking' && !showThinking) continue;
    if (item.kind === 'text') groups.push({ kind: 'text', text: item.text, key: index });
    else {
      let group = groups.at(-1);
      if (group?.kind !== 'process')
        groups.push((group = { kind: 'process', items: [], key: index }));
      group.items.push(item);
    }
  }
  return groups;
}
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;
export function applyRunMetrics(previous, event) {
  const next = { ...previous };
  if (event.type === 'response_start') next.modelTurns = (next.modelTurns || 0) + 1;
  if (event.type === 'tool_start') next.toolCalls = (next.toolCalls || 0) + 1;
  if (event.type === 'usage') {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
      if (finite(event.usage?.[key])) next[key] = (next[key] || 0) + event.usage[key];
    if (finite(event.responseMs)) next.responseMs = (next.responseMs || 0) + event.responseMs;
  }
  return next;
}
export function metricValues(metrics) {
  if (!metrics) return {};
  const total = ['input', 'output', 'cacheRead', 'cacheWrite'].filter((k) => finite(metrics[k]));
  const input = (metrics.input || 0) + (metrics.cacheRead || 0) + (metrics.cacheWrite || 0);
  return {
    totalTokens: total.length ? total.reduce((sum, k) => sum + metrics[k], 0) : undefined,
    tokensPerSecond:
      finite(metrics.output) && metrics.responseMs > 0
        ? metrics.output / (metrics.responseMs / 1000)
        : undefined,
    cacheHit:
      finite(metrics.cacheRead) && input > 0 ? (metrics.cacheRead / input) * 100 : undefined,
  };
}
export function activityTarget(item) {
  let args = {};
  try {
    const parsed = JSON.parse(item.arguments || '{}');
    if (parsed && typeof parsed === 'object') args = parsed;
  } catch {}
  const value =
    args.query ??
    args.search ??
    args.url ??
    args.urls?.[0] ??
    item.command ??
    (item.path !== '.' ? item.path : '') ??
    '';
  const label = String(value).replace(/\s+/g, ' ').slice(0, 500);
  let url;
  try {
    const parsed = new URL(label);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
      url = parsed.href;
  } catch {}
  return { label, url };
}
