import { Readable } from 'node:stream';
import { fail } from './accounts.mjs';
import { createAgentBindings } from './agent-bindings.mjs';
import { createProjectLabels } from './project-labels.mjs';
import { createAssistanceContext } from './assistance-context.mjs';
export function unifiedAdapters(db, { community, relay, dshRemote, now = Date.now }) {
  const bindings = createAgentBindings(db),
    labels = createProjectLabels(db);
  async function request(actor, path, input, method = input ? 'POST' : 'GET') {
    const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []);
    req.method = method;
    req.headers = {};
    let code, value;
    const json = (status, data) => {
      code = status;
      value = data;
    };
    const url = new URL('http://internal' + path);
    const handled =
      (await dshRemote.handle(req, url, json, actor)) ||
      (await community.after(req, url, json, actor)) ||
      (await relay.after(req, url, json, actor));
    if (!handled || code >= 400) throw fail(code || 500, value?.error || '会话功能暂不可用。');
    return value;
  }
  const visible = createAssistanceContext(db, {
    now,
    serverProject: async (owner, id) => {
      const projects = await community.unified.projects(community.accounts.profile(owner));
      if (!projects.projects.some((p) => p.id === id)) throw fail(403, '主对话项目授权已失效。');
    },
  });
  function nativeList(actor) {
    const server = community.unified
      .list(actor)
      .map((c) => ({ ...c, origin: 'server', nativeId: c.id }));
    const computer = relay.unified
      .list(actor)
      .map((c) => ({ ...c, origin: 'computer', nativeId: c.id }));
    const remote = db
      .prepare('SELECT id FROM dsh_conversations WHERE owner=? ORDER BY updated_at DESC')
      .all(actor.id)
      .map((r) => dshRemote.conversations(actor.id, r.id).conversation)
      .map((c) => {
        const pending =
          c.actions?.some((a) => ['sending', 'unknown', 'accepted'].includes(a.state)) ||
          c.uiRequests?.some((q) => ['pending', 'responding'].includes(q.status));
        return {
          ...c,
          origin: 'remote',
          nativeId: c.id,
          runtime: bindings.get(actor.id, 'remote', c.id),
          runState: {
            ...c.runState,
            busy: !!(c.runState?.busy || pending || c.state !== 'ready'),
            label: pending ? '操作或问题结果待核对' : c.runState?.label,
          },
        };
      });
    return [...server, ...computer, ...remote];
  }
  const cachedTargets = new Map(),
    targetReads = new Map(),
    pendingReads = new Map();
  async function loadTargets(actor) {
    const items = [];
    if (community.piReady) {
      try {
        const { projects } = await community.unified.projects(actor);
        items.push(
          { origin: 'server', projectId: null, locationName: '服务器', projectName: '独立对话' },
          ...projects.map((p) => ({
            origin: 'server',
            projectId: p.id,
            locationName: '服务器',
            projectName: p.displayName || p.name || p.id,
          })),
        );
      } catch {}
    }
    for (const d of db
      .prepare('SELECT * FROM relay_devices WHERE owner=? AND revoked=0 AND expires>?')
      .all(actor.id, now())) {
      if (
        now() - d.last_seen >= 45000 ||
        !JSON.parse(d.capabilities || '[]').includes('conversation_handoff_v1')
      )
        continue;
      for (const p of labels.decorate(
        actor.id,
        d.id,
        db.prepare('SELECT * FROM relay_projects WHERE device_id=? AND revoked=0').all(d.id),
      ))
        items.push({
          origin: 'computer',
          deviceId: d.id,
          projectId: p.id,
          locationName: d.name,
          projectName: p.name,
        });
    }
    if (dshRemote.status(actor.id).chatAvailable) {
      const outcomes = await Promise.allSettled(
        dshRemote.status(actor.id).connections.map(async (c) => {
          const catalogue = await request(actor, `/api/agent/remote/connections/${c.id}/catalogue`);
          return catalogue.workspaces.map((w) => ({
            origin: 'remote',
            connectionId: c.id,
            projectId: w.id,
            locationName: catalogue.host.name,
            projectName: w.name,
          }));
        }),
      );
      for (const r of outcomes) if (r.status === 'fulfilled') items.push(...r.value);
    }
    cachedTargets.set(actor.id, items);
    targetReads.set(actor.id, now());
    return items;
  }
  async function targets(actor, { fresh = false } = {}) {
    if (fresh) return loadTargets(actor);
    if (now() - (targetReads.get(actor.id) || 0) < 15000) return cachedTargets.get(actor.id) || [];
    if (pendingReads.has(actor.id)) return pendingReads.get(actor.id);
    const read = loadTargets(actor).finally(() => pendingReads.delete(actor.id));
    pendingReads.set(actor.id, read);
    return read;
  }
  return {
    actor: (owner) => community.accounts.profile(owner),
    nativeList,
    targets,
    async remove(actor, ref) {
      return request(
        actor,
        (ref.origin === 'server' ? '/api/pi/conversations/' : '/api/relay/conversations/') +
          ref.nativeId,
        undefined,
        'DELETE',
      );
    },
    cachedTargets: (owner) => cachedTargets.get(owner) || [],
    async create(actor, target, id) {
      if (target.origin === 'computer') return relay.unified.create(actor, target, id);
      if (target.origin === 'server')
        return (
          await request(actor, '/api/pi/conversations', {
            id,
            projectId: target.projectId,
            access: 'read',
          })
        ).conversation;
      return (
        await request(actor, '/api/agent/remote/conversations', {
          id,
          connectionId: target.connectionId,
          workspaceId: target.projectId,
        })
      ).conversation;
    },
    async state(actor, ref) {
      if (ref.origin === 'server') return community.unified.state(actor, ref.nativeId);
      if (ref.origin === 'computer') return relay.unified.state(actor, ref.nativeId);
      const c = (await request(actor, `/api/agent/remote/conversations/${ref.nativeId}`))
        .conversation;
      const connection = dshRemote
        .status(actor.id)
        .connections.find((v) => v.id === c.connectionId);
      if (
        !connection ||
        connection.state !== 'ready' ||
        c.state !== 'ready' ||
        c.connection !== 'connected'
      )
        throw fail(409, 'DSH连接未就绪，请核对状态后切换。');
      const pending =
        c.actions?.some((a) => ['sending', 'unknown', 'accepted'].includes(a.state)) ||
        c.uiRequests?.some((q) => ['pending', 'responding'].includes(q.status));
      return {
        ...c.runState,
        busy: !!(c.runState?.busy || pending),
        label: pending ? '操作或问题结果待核对' : c.runState?.label,
      };
    },
    visible: (actor, ref) => visible.readNative(actor.id, { origin: ref.origin, id: ref.nativeId }),
  };
}
