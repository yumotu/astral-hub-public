// Restore readable history only. A cached host, tool choice or run state is never
// evidence of a live connection or an authorization to execute an operation.
const text = (value, limit = 64000) => (typeof value === 'string' ? value.slice(0, limit) : '');
const list = (value, limit) => (Array.isArray(value) ? value.slice(-limit) : []);
const bounded = (values, maxChars) => {
  let used = 2;
  const selected = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const cost = JSON.stringify(values[i]).length + 1;
    if (used + cost > maxChars) continue;
    used += cost;
    selected.push(values[i]);
  }
  return selected.reverse();
};
const file = (value) => ({
  id: text(value?.id, 200),
  name: text(value?.name, 500),
  bytes: Number.isSafeInteger(value?.bytes) && value.bytes >= 0 ? value.bytes : 0,
  source: 'dsh',
  ...(typeof value?.sha256 === 'string' ? { sha256: value.sha256.slice(0, 64) } : {}),
});
export const dshDisplayPath = (id) => '/@dsh-display/' + id;
export const dshDirectoryPath = '/@dsh-directory';
export function dshDisplaySnapshot(value) {
  if (!value || typeof value.id !== 'string' || !Array.isArray(value.messages)) return null;
  return {
    id: text(value.id, 200),
    title: text(value.title, 500),
    connectionId: text(value.connectionId, 200),
    projectId: text(value.projectId, 200),
    sessionId: text(value.sessionId, 200),
    updatedAt: text(value.updatedAt, 100),
    pinnedAt: typeof value.pinnedAt === 'string' ? text(value.pinnedAt, 100) : null,
    archivedAt: typeof value.archivedAt === 'string' ? text(value.archivedAt, 100) : null,
    messages: bounded(
      list(value.messages, 500)
        .filter((m) => m && ['user', 'assistant'].includes(m.role))
        .map((m) => ({
          id: text(m.id, 200),
          role: m.role,
          text: text(m.text),
          thinking: text(m.thinking),
          time: Number.isFinite(m.time) ? m.time : 0,
          ...(m.rpcId ? { rpcId: text(m.rpcId, 200) } : {}),
        })),
      512 * 1024,
    ),
    tools: bounded(
      list(value.tools, 300).map((t) => ({
        id: text(t?.id, 200),
        name: text(t?.name, 200),
        path: '.',
        arguments: text(t?.arguments),
        output: text(t?.output),
        status: ['done', 'error'].includes(t?.status) ? t.status : 'running',
        time: Number.isFinite(t?.time) ? t.time : 0,
      })),
      64 * 1024,
    ),
    inputs: Object.fromEntries(
      bounded(
        Object.entries(value.inputs || {})
          .slice(-500)
          .map(([key, files]) => [text(key, 200), list(files, 8).map(file)]),
        64 * 1024,
      ),
    ),
    artifacts: bounded(
      list(value.artifacts, 100).map((a) => ({
        taskId: text(a?.taskId, 200),
        file: file(a?.file),
      })),
      32 * 1024,
    ),
    hasMore: value.hasMore === true,
    state: 'cached',
    status: 'interrupted',
    phase: '',
    error: '',
    stopPending: false,
    connection: 'reconnecting',
    runState: { label: '正在同步最新状态', busy: false, state: 'unknown' },
    interactions: [],
    uiRequests: [],
    queue: [],
    actions: [],
    appTools: { available: false, enabled: false, tasks: [] },
  };
}
export function dshDirectorySnapshot(value) {
  const connections = list(value?.connections, 100)
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({
      id: text(c.id, 200),
      name: text(c.name, 500),
      origin: '',
      account: '',
      state: 'cached',
      host: c.host
        ? {
            deviceId: text(c.host.deviceId, 200),
            name: text(c.host.name, 500),
            location: c.host.location === 'server' ? 'server' : 'computer',
            fingerprint: '',
          }
        : null,
    }));
  return {
    connections,
    catalogues: Object.fromEntries(
      connections.flatMap((c) => {
        const catalogue = value?.catalogues?.[c.id];
        return c.host && catalogue
          ? [
              [
                c.id,
                {
                  host: c.host,
                  workspaces: list(catalogue.workspaces, 500).map((p) => ({
                    id: text(p?.id, 200),
                    name: text(p?.name, 500),
                  })),
                  sessions: [],
                },
              ],
            ]
          : [];
      }),
    ),
  };
}
