import { assistantArtifactRules } from '../shared/assistant-artifacts.mjs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { createAgentBindings } from './agent-bindings.mjs';
import { createDshAppTools } from './dsh-app-tools.mjs';
import { createDshFiles } from './dsh-files.mjs';
import { createDshWorkbench } from './dsh-workbench.mjs';
import { createDshExtensions } from './dsh-extensions.mjs';
import { agentCapabilities, agentRunState } from '../shared/agent-runtime.mjs';
import {
  applyDshFrame,
  emptyDshSession,
  dshSessionView,
  prependDshPage,
} from '../shared/dsh-session.mjs';

const uuid = z.string().uuid();
const nativeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const openSchema = z
  .object({
    id: uuid,
    connectionId: uuid,
    workspaceId: nativeId,
    sessionId: nativeId.optional(),
  })
  .strict();
const promptSchema = z
  .object({
    id: uuid,
    text: z.string().trim().min(1).max(8000),
    mode: z.enum(['queue', 'steer']).default('queue'),
    attachments: z.array(uuid).max(8).default([]),
  })
  .strict();
const actionId = z.object({ id: uuid }).strict();
export function createDshConversations(
  db,
  {
    body,
    connection,
    catalogue,
    live,
    rate,
    appTools = {},
    files = () => null,
    unified,
    now = Date.now,
  },
) {
  const bindings = createAgentBindings(db),
    watching = new Map(),
    syncing = new Map(),
    busy = new Map();
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_conversations(
    owner TEXT NOT NULL,id TEXT NOT NULL,connection_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
    session_id TEXT,state TEXT NOT NULL,snapshot TEXT NOT NULL,stop_cursor INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,title TEXT,pinned_at TEXT,archived_at TEXT,
    PRIMARY KEY(owner,id),UNIQUE(owner,connection_id,session_id));
    CREATE TABLE IF NOT EXISTS dsh_actions(
    owner TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,kind TEXT NOT NULL,
    digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,reference TEXT,
    PRIMARY KEY(owner,id));`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS assistant_dsh_inputs(owner TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,input TEXT NOT NULL,PRIMARY KEY(owner,id));`,
  );
  if (
    !db
      .prepare('PRAGMA table_info(dsh_conversations)')
      .all()
      .some((c) => c.name === 'app_tools')
  )
    db.exec('ALTER TABLE dsh_conversations ADD COLUMN app_tools INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE dsh_actions SET state='unknown' WHERE state='sending'");
  db.exec("UPDATE dsh_conversations SET state='unknown' WHERE state='creating'");
  const key = (owner, id) => JSON.stringify([owner, id]);
  const saved = (owner, id) =>
    db.prepare('SELECT * FROM dsh_conversations WHERE owner=? AND id=?').get(owner, id);
  function row(owner, id) {
    if (closed) throw fail(409, 'DSH 会话服务已关闭。');
    const value = saved(owner, id);
    if (!value) throw fail(404, 'DSH 对话不存在。');
    return value;
  }
  function stateOf(r) {
    return JSON.parse(r.snapshot);
  }
  function target(owner, r) {
    const connection = live(owner, r.connection_id);
    if (connection.state !== 'ready' || !r.session_id || r.state !== 'ready')
      throw fail(409, 'DSH 对话未就绪，未知创建结果不会重试。');
    const runtime = bindings.get(owner, 'remote', r.id);
    if (
      !runtime ||
      runtime.sessionKey !== r.session_id ||
      runtime.projectId !== r.workspace_id ||
      runtime.connectionId !== r.connection_id
    )
      throw fail(409, 'DSH 会话绑定不符。');
    return runtime;
  }
  const software = createDshAppTools(db, {
    body,
    now,
    ...appTools,
    engine: appTools.engine || (() => null),
    sessionActive: appTools.sessionActive || (() => false),
    fileBridge: () => attachments,
    targetActive(owner, id, connectionId, sessionId) {
      try {
        const r = row(owner, id);
        target(owner, r);
        return (
          r.connection_id === connectionId &&
          r.session_id === sessionId &&
          r.app_tools === 1 &&
          r.stop_cursor === null &&
          stateOf(r).connection === 'connected'
        );
      } catch {
        return false;
      }
    },
  });
  const attachments = createDshFiles(db, {
    files,
    now,
    task: (ctx) => software.task(ctx),
    active: (ctx) => software.active(ctx),
    sessionActive: (actor) =>
      !!actor.sessionHash && !!appTools.sessionActive?.(actor.id, actor.sessionHash),
  });
  const persist = (r, state, stopCursor = r.stop_cursor) => {
    if (closed) return;
    db.prepare(
      'UPDATE dsh_conversations SET snapshot=?,stop_cursor=?,updated_at=? WHERE owner=? AND id=?',
    ).run(JSON.stringify(state), stopCursor, new Date(now()).toISOString(), r.owner, r.id);
  };
  function apply(owner, id, generation, frame) {
    if (closed || watching.get(key(owner, id)) !== generation) return;
    const r = row(owner, id);
    live(owner, r.connection_id);
    const state = applyDshFrame(stateOf(r), frame, r.session_id, now());
    // A stop admission only becomes stopped when the host reports a newer
    // terminal turn. A stale baseline cannot satisfy a new stop request.
    const terminal =
      r.stop_cursor !== null &&
      state.events.findLast((e) => e.seq > r.stop_cursor && e.type === 'turn/end');
    persist(r, state, terminal ? null : r.stop_cursor);
    software.observe(owner, id, state);
    const receipts = new Set(
      [
        ...state.events.filter((e) => e.type === 'user/message').map((e) => e.data.source?.rpcId),
        ...(state.projections.inbox || []).map((e) => e.rpcId),
      ].filter(Boolean),
    );
    for (const requestId of receipts)
      db.prepare(
        "UPDATE dsh_actions SET state='observed' WHERE owner=? AND id=? AND conversation_id=? AND kind='prompt' AND state IN ('sending','unknown','accepted')",
      ).run(owner, requestId, id);
    if (frame.type === 'interaction-resolved')
      db.prepare(
        "UPDATE dsh_actions SET state='observed' WHERE owner=? AND conversation_id=? AND kind='respond' AND reference=?",
      ).run(owner, id, frame.id);
  }
  async function ensure(owner, id) {
    const r = row(owner, id);
    target(owner, r);
    const { client } = await connection(owner, r.connection_id);
    target(owner, row(owner, id));
    if (typeof client.chat !== 'function') throw fail(503, '此DSH连接尚未提供聊天接口。');
    const k = key(owner, id),
      old = watching.get(k);
    if (old?.client === client) {
      await old.opened;
      target(owner, row(owner, id));
      workbench.connected(owner, r.connection_id, client.chat());
      return { r: row(owner, id), chat: client.chat() };
    }
    if ([...watching.values()].filter((v) => v.owner === owner).length >= 16 || watching.size >= 64)
      throw fail(429, '当前打开的DSH会话较多，请先断开不使用的连接。');
    const generation = { client, owner, connectionId: r.connection_id };
    watching.set(k, generation);
    generation.opened = client.chat().watch(r.session_id, (frame) => {
      try {
        apply(owner, id, generation, frame);
      } catch (error) {
        disconnect(owner, r.connection_id);
        void client.close().catch(() => {});
        throw error;
      }
    });
    try {
      await generation.opened;
    } catch (error) {
      if (watching.get(k) === generation) {
        watching.delete(k);
        persist(r, applyDshFrame(stateOf(row(owner, id)), { type: 'disconnected' }, r.session_id));
      }
      throw error;
    }
    target(owner, row(owner, id));
    workbench.connected(owner, r.connection_id, client.chat());
    return { r: row(owner, id), chat: client.chat() };
  }
  function disconnect(owner, connectionId) {
    if (closed) return;
    for (const [k, watch] of watching)
      if (watch.owner === owner && watch.connectionId === connectionId) watching.delete(k);
    for (const r of db
      .prepare('SELECT * FROM dsh_conversations WHERE owner=? AND connection_id=?')
      .all(owner, connectionId)) {
      workbench.revoke(owner, r.id);
      software.revoke(owner, r.id);
      persist(r, applyDshFrame(stateOf(r), { type: 'disconnected' }, r.session_id));
    }
  }
  // A process restart preserves native history, but never restores old live
  // question/approval handles or claims that a task has stopped.
  for (const r of db.prepare("SELECT * FROM dsh_conversations WHERE state='ready'").all())
    persist(r, applyDshFrame(stateOf(r), { type: 'disconnected' }, r.session_id));
  function view(r) {
    const state = stateOf(r),
      value = dshSessionView(state, { stopPending: r.stop_cursor !== null });
    const confirmations = software.pending(r.owner, r.id);
    if (confirmations.length && value.status === 'running') {
      value.phase = '等待你的确认';
      value.uiRequests.push(...confirmations.map((p) => ({ id: p.id, status: 'pending' })));
    }
    const actions = db
      .prepare(
        'SELECT id,kind,state,reference FROM dsh_actions WHERE owner=? AND conversation_id=? ORDER BY created_at DESC LIMIT 30',
      )
      .all(r.owner, r.id);
    const messages = value.messages.map((m) => {
      const original =
        m.role === 'user' &&
        m.rpcId &&
        db
          .prepare(
            'SELECT input FROM assistant_dsh_inputs WHERE owner=? AND id=? AND conversation_id=?',
          )
          .get(r.owner, m.rpcId, r.id);
      const task = m.role === 'user' && m.rpcId && software.task({ owner: r.owner, task: m.rpcId });
      return original
        ? { ...m, text: original.input }
        : task?.conversation_id === r.id
          ? { ...m, text: task.input }
          : m;
    });
    return {
      id: r.id,
      connectionId: r.connection_id,
      projectId: r.workspace_id,
      sessionId: r.session_id,
      state: r.state,
      title:
        r.title ||
        state.projections.title ||
        messages.find((m) => m.role === 'user')?.text.slice(0, 80) ||
        'DSH 新对话',
      runtime: bindings.get(r.owner, 'remote', r.id),
      ...value,
      ...attachments.messages(r.owner, r.id),
      messages,
      runState: agentRunState(value),
      capabilities: agentCapabilities(
        {
          streaming: true,
          thinking: true,
          steer: true,
          attachments: software.enabled && r.app_tools === 1,
          questions: true,
          stop: true,
          appFunctions:
            software.enabled &&
            r.app_tools === 1 &&
            software.tasks(r.owner, r.id).some((t) => t.state !== 'binding'),
        },
        value.connection === 'connected' ? '' : '请恢复DSH主机连接后使用。',
      ),
      appTools: {
        available: software.enabled,
        enabled: r.app_tools === 1,
        tasks: software.tasks(r.owner, r.id),
      },
      fileLimits: {
        upload: 50 * 1024 * 1024,
        downloadToHost: 20 * 1024 * 1024,
        export: 10 * 1024 * 1024,
        exportTotal: 20 * 1024 * 1024,
      },
      actions,
      pinnedAt: r.pinned_at,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  function recordAction(owner, id, conversationId, kind, input) {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = db.prepare('SELECT * FROM dsh_actions WHERE owner=? AND id=?').get(owner, id);
    if (old) {
      if (old.conversation_id !== conversationId || old.kind !== kind || old.digest !== digest)
        throw fail(409, '操作编号已被其他内容使用。');
      return old;
    }
    db.prepare('INSERT INTO dsh_actions VALUES(?,?,?,?,?,?,NULL,?,?)').run(
      owner,
      id,
      conversationId,
      kind,
      digest,
      'sending',
      new Date(now()).toISOString(),
      kind === 'respond' ? input.interactionId : null,
    );
    return null;
  }
  async function action(owner, id, operationId, kind, input, run) {
    const old = recordAction(owner, operationId, id, kind, input);
    if (old) return { id: operationId, state: old.state };
    try {
      const result = await run();
      if (closed) return { id: operationId, state: 'unknown' };
      target(owner, row(owner, id));
      db.prepare(
        "UPDATE dsh_actions SET state=CASE WHEN state='observed' THEN state ELSE 'accepted' END,result=? WHERE owner=? AND id=?",
      ).run(JSON.stringify(result), owner, operationId);
      return { id: operationId, state: 'accepted' };
    } catch (error) {
      if (!closed)
        db.prepare('UPDATE dsh_actions SET state=? WHERE owner=? AND id=? AND state<>?').run(
          error.remoteRejected ||
            error.localRejected ||
            error.status === 400 ||
            error.name === 'ZodError'
            ? 'rejected'
            : 'unknown',
          owner,
          operationId,
          'observed',
        );
      throw error;
    }
  }
  const workbench = createDshWorkbench({
    body,
    ensure,
    target,
    row,
    view,
    action,
    rate,
    now,
    active: (actor) => !!appTools.sessionActive?.(actor.id, actor.sessionHash),
  });
  const extensions = createDshExtensions({
    db,
    body,
    ensure,
    target,
    row,
    action,
    rate,
    now,
    active: (actor) => !!appTools.sessionActive?.(actor.id, actor.sessionHash),
  });
  return {
    disconnect,
    appActive: (ctx) => software.active(ctx),
    before: (...args) => software.before(...args),
    revokeAccount: (owner) => {
      software.revoke(owner);
      workbench.revoke(owner);
      extensions.revoke(owner);
    },
    extensions,
    extensionActor(ctx, actor) {
      const task = software.task(ctx);
      if (!task || task.conversation_id !== ctx.conversation || !software.active(ctx))
        throw fail(403, '此任务的软件功能授权已失效。');
      return { ...actor, sessionHash: task.session_hash };
    },
    fileCatalog: (ctx) => attachments.catalog(ctx),
    fileRead: (ctx, p) => attachments.read(ctx, p),
    read(owner, id) {
      if (id) return { conversation: view(row(owner, uuid.parse(id))) };
      return {
        conversations: db
          .prepare(
            'SELECT id,connection_id AS connectionId,workspace_id AS projectId,state,updated_at AS updatedAt FROM dsh_conversations WHERE owner=? ORDER BY updated_at DESC LIMIT 100',
          )
          .all(owner),
      };
    },
    async handle(req, url, json, actor, res) {
      const base = '/api/agent/remote/conversations';
      if (!url.pathname.startsWith(base)) return false;
      const owner = actor.id;
      if (url.pathname === base && req.method === 'GET') {
        rate(owner, 'conversations', 120);
        const items = db
          .prepare(
            'SELECT * FROM dsh_conversations WHERE owner=? ORDER BY updated_at DESC LIMIT 1000',
          )
          .all(owner);
        json(200, {
          conversations: items.map((r) => {
            const v = view(r);
            return {
              id: v.id,
              title: v.title,
              connectionId: v.connectionId,
              projectId: v.projectId,
              sessionId: v.sessionId,
              state: v.state,
              updatedAt: v.updatedAt,
              runState: v.runState,
              pinnedAt: v.pinnedAt,
              archivedAt: v.archivedAt,
            };
          }),
        });
        return true;
      }
      if (url.pathname === base && req.method === 'POST') {
        rate(owner, 'conversation-open', 30);
        const p = openSchema.parse(await body(req));
        const old = saved(owner, p.id);
        if (old) {
          if (
            old.connection_id !== p.connectionId ||
            old.workspace_id !== p.workspaceId ||
            (p.sessionId && p.sessionId !== old.session_id)
          )
            throw fail(409, '对话已绑定其他主机或项目。');
          json(200, { conversation: view(old) });
          return true;
        }
        const catalog = await catalogue(owner, p.connectionId);
        if (!catalog.workspaces.some((w) => w.id === p.workspaceId))
          throw fail(404, 'DSH工作区不可用。');
        if (
          p.sessionId &&
          !catalog.sessions.some(
            (s) => s.id === p.sessionId && s.workspaceIds.includes(p.workspaceId),
          )
        )
          throw fail(403, '此会话不属于已选择的工作区。');
        const stamp = new Date(now()).toISOString(),
          native = p.sessionId || p.id;
        if (
          db
            .prepare(
              'SELECT 1 FROM dsh_conversations WHERE owner=? AND connection_id=? AND session_id=?',
            )
            .get(owner, p.connectionId, native)
        )
          throw fail(409, '此原生会话已在星屿中关联。');
        db.prepare(
          'INSERT INTO dsh_conversations(owner,id,connection_id,workspace_id,session_id,state,snapshot,stop_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)',
        ).run(
          owner,
          p.id,
          p.connectionId,
          p.workspaceId,
          native,
          p.sessionId ? 'ready' : 'creating',
          JSON.stringify(emptyDshSession()),
          stamp,
          stamp,
        );
        if (p.sessionId)
          bindings.bind(owner, 'remote', p.id, {
            version: 1,
            backend: 'dsh',
            transport: 'dsh-remote',
            location: catalog.host.location,
            deviceId: catalog.host.deviceId,
            connectionId: p.connectionId,
            projectId: p.workspaceId,
            sessionKey: p.sessionId,
          });
        try {
          const { client, peer } = await connection(owner, p.connectionId);
          let sessionId = native;
          if (!p.sessionId) {
            const result = await client.chat().create(p.workspaceId, native);
            sessionId = nativeId.parse(result?.sessionId);
          }
          live(owner, p.connectionId);
          const runtime = {
            version: 1,
            backend: 'dsh',
            transport: 'dsh-remote',
            location: peer.location,
            deviceId: peer.deviceId,
            connectionId: p.connectionId,
            projectId: p.workspaceId,
            sessionKey: sessionId,
          };
          bindings.bind(owner, 'remote', p.id, runtime);
          db.prepare(
            "UPDATE dsh_conversations SET session_id=?,state='ready' WHERE owner=? AND id=?",
          ).run(sessionId, owner, p.id);
          await ensure(owner, p.id);
        } catch (error) {
          if (!closed)
            db.prepare(
              "UPDATE dsh_conversations SET state='unknown' WHERE owner=? AND id=? AND state='creating'",
            ).run(owner, p.id);
          throw error;
        }
        json(201, { conversation: view(row(owner, p.id)) });
        return true;
      }
      const fileRoute = url.pathname.match(
        /^\/api\/agent\/remote\/conversations\/([^/]+)\/files(?:\/[^/]+)?$/,
      );
      if (fileRoute) {
        const current = row(owner, uuid.parse(fileRoute[1]));
        const kind =
          req.method === 'POST'
            ? 'file-upload'
            : req.method === 'DELETE'
              ? 'file-delete'
              : 'file-read';
        rate(owner, kind, req.method === 'POST' ? 20 : req.method === 'DELETE' ? 60 : 120);
        return attachments.handle(req, url, json, actor, current, res);
      }
      const workbenchRoute = url.pathname.match(
        /^\/api\/agent\/remote\/conversations\/([^/]+)\/(controls|terminals)(?:\/|$)/,
      );
      if (workbenchRoute)
        return workbench.handle(req, url, json, actor, row(owner, uuid.parse(workbenchRoute[1])));
      const extensionRoute = url.pathname.match(
        /^\/api\/agent\/remote\/conversations\/([^/]+)\/extensions(?:\/|$)/,
      );
      if (extensionRoute)
        return extensions.handle(req, url, json, actor, uuid.parse(extensionRoute[1]));
      const match = url.pathname.match(
        /^\/api\/agent\/remote\/conversations\/([^/]+)(?:\/(prompt|stop|respond|history|tools))?$/,
      );
      if (!match) return false;
      const id = uuid.parse(match[1]),
        r = row(owner, id);
      if (req.method === 'POST' && match[2] === 'tools') {
        rate(owner, 'software-tools', 30);
        const p = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(await body(req));
        if (p.enabled && !software.enabled) throw fail(503, '服务器尚未配置DSH软件工具入口。');
        if (busy.has(key(owner, id))) throw fail(409, '此对话正在提交消息，请等待提交结束。');
        if (p.enabled) target(owner, r);
        db.prepare('UPDATE dsh_conversations SET app_tools=? WHERE owner=? AND id=?').run(
          p.enabled ? 1 : 0,
          owner,
          id,
        );
        if (!p.enabled) software.revoke(owner, id);
        json(200, { conversation: view(row(owner, id)) });
        return true;
      }
      if (req.method === 'PATCH' && !match[2]) {
        rate(owner, 'metadata', 60);
        const patch = z
            .object({
              title: z.string().trim().min(1).max(120).optional(),
              pinned: z.boolean().optional(),
              archived: z.boolean().optional(),
            })
            .strict()
            .parse(await body(req)),
          stamp = new Date(now()).toISOString();
        db.prepare(
          'UPDATE dsh_conversations SET title=?,pinned_at=?,archived_at=? WHERE owner=? AND id=?',
        ).run(
          patch.title ?? r.title,
          patch.pinned === undefined ? r.pinned_at : patch.pinned ? stamp : null,
          patch.archived === undefined ? r.archived_at : patch.archived ? stamp : null,
          owner,
          id,
        );
        await unified?.()?.nativePatch(actor, { origin: 'remote', nativeId: id }, patch);
        json(200, { conversation: view(row(owner, id)) });
        return true;
      }
      if (req.method === 'GET' && !match[2]) {
        rate(owner, 'snapshot', 240);
        // Read/reconnect never replays an action. Cached history is available
        // even if credentials were revoked or the remote host is offline.
        let warning = '';
        if (r.state === 'ready') {
          // Reconnecting a native transport can take much longer than a read.
          // Share one reconnect and return the durable snapshot promptly;
          // only the background follow updates it, never a replayed prompt.
          const k = key(owner, id);
          let pending = syncing.get(k);
          if (!pending) {
            pending = ensure(owner, id)
              .then(
                () => true,
                () => false,
              )
              .finally(() => {
                if (syncing.get(k) === pending) syncing.delete(k);
              });
            syncing.set(k, pending);
          }
          let timer;
          try {
            const connected = await Promise.race([
              pending,
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), 1000);
              }),
            ]);
            if (!connected) warning = '正在重新连接，先显示已保存的记录。';
          } finally {
            clearTimeout(timer);
          }
        }
        json(200, { conversation: view(row(owner, id)), warning });
        return true;
      }
      if (req.method === 'POST' && match[2] === 'history') {
        rate(owner, 'history', 30);
        z.object({})
          .strict()
          .parse(await body(req));
        const { r: current, chat } = await ensure(owner, id),
          state = stateOf(current);
        const first = state.events[0]?.seq;
        if (state.hasMore && first !== undefined) {
          const page = await chat.page(current.session_id, first, state.cursor);
          target(owner, row(owner, id));
          const latest = row(owner, id),
            next = stateOf(latest);
          if (next.events[0]?.seq !== first) throw fail(409, '历史窗口已更新，请重试读取。');
          persist(latest, prependDshPage(next, page));
        }
        json(200, { conversation: view(row(owner, id)) });
        return true;
      }
      if (req.method !== 'POST' || !['prompt', 'stop', 'respond'].includes(match[2])) return false;
      rate(owner, 'chat-action', 60);
      const input = await body(req),
        op = match[2],
        p =
          op === 'prompt'
            ? promptSchema.parse(input)
            : op === 'stop'
              ? actionId.parse(input)
              : z
                  .object({
                    id: uuid,
                    interactionId: z.string().regex(/^[a-f0-9]{64}$/),
                    response: z.record(z.string(), z.unknown()),
                  })
                  .strict()
                  .parse(input);
      const lock = key(owner, id);
      if (busy.has(lock)) throw fail(409, '此对话正在提交操作，请等待结果。');
      const work = (async () => {
        const old = db.prepare('SELECT * FROM dsh_actions WHERE owner=? AND id=?').get(owner, p.id);
        if (old) {
          recordAction(owner, p.id, id, op, p);
          return { id: p.id, state: old.state };
        }
        if (op === 'prompt') unified?.()?.assertWritable(owner, { origin: 'remote', nativeId: id });
        const { r: current, chat } = await ensure(owner, id);
        if (op === 'prompt') unified?.()?.assertWritable(owner, { origin: 'remote', nativeId: id });
        if (
          op === 'respond' &&
          db
            .prepare(
              "SELECT 1 FROM dsh_actions WHERE owner=? AND conversation_id=? AND kind='respond' AND reference=? AND state IN ('sending','unknown','accepted','observed')",
            )
            .get(owner, id, p.interactionId)
        )
          throw fail(409, '该答复已提交或结果待核对，不会重复答复。');
        const nativeCommand = op === 'prompt' && p.text.trimStart().startsWith('/');
        // Harness records native Skills as user messages. Keep those commands
        // verbatim without consuming the first normal prompt's context handoff.
        const hasNormalInput = dshSessionView(stateOf(current)).messages.some((m) => {
          if (m.role !== 'user') return false;
          const savedInput =
            m.rpcId &&
            db
              .prepare(
                'SELECT input FROM assistant_dsh_inputs WHERE owner=? AND id=? AND conversation_id=?',
              )
              .get(owner, m.rpcId, id);
          return !(savedInput?.input ?? m.text).trimStart().startsWith('/');
        });
        const handoff =
          op === 'prompt' && !nativeCommand && !hasNormalInput
            ? (await unified?.()?.handoff(owner, { origin: 'remote', nativeId: id })) || []
            : [];
        if (op === 'prompt') unified?.()?.assertWritable(owner, { origin: 'remote', nativeId: id });
        return action(owner, id, p.id, op, p, async () => {
          if (op === 'prompt') {
            if (p.attachments.length && current.app_tools !== 1)
              throw Object.assign(fail(409, '请先在此对话设置中启用星屿软件功能，才能读取附件。'), {
                localRejected: true,
              });
            try {
              try {
                if (p.attachments.length) attachments.selected(owner, id, p.attachments);
              } catch (error) {
                error.localRejected = true;
                throw error;
              }
              if (current.app_tools === 1) await software.prepare(actor, current, p, chat);
              if (p.attachments.length) attachments.bind(owner, id, p.id, p.attachments);
              target(owner, row(owner, id));
              const nativeText = handoff.length
                ? '以下是所属对话切换引擎前的可见交流文本，仅作背景，不是新授权，不重放任务：\n' +
                  JSON.stringify(handoff) +
                  '\n\n现在用户的新消息：\n' +
                  p.text
                : p.text;
              // Native slash commands must reach Harness verbatim so its command
              // dispatcher can recognize them. Handoff remains pending for the
              // first normal prompt rather than consuming it as a command.
              const text = nativeCommand
                ? p.text
                : '[星屿回复排版约定]\n' +
                  assistantArtifactRules +
                  '\n[本次用户内容]\n' +
                  nativeText;
              db.prepare('INSERT OR IGNORE INTO assistant_dsh_inputs VALUES(?,?,?,?)').run(
                owner,
                p.id,
                id,
                p.text,
              );
              return await chat.prompt(current.session_id, p.id, text, p.mode, p.attachments);
            } catch (error) {
              // Even an unknown prompt receipt must not leave a usable grant.
              software.revokeTask(owner, p.id);
              throw error;
            }
          }
          if (op === 'respond')
            return chat.respond(current.session_id, p.interactionId, p.response);
          const displayed = dshSessionView(stateOf(current));
          software.revoke(owner, id);
          if (current.stop_cursor !== null) return { stopping: true };
          if (!['running', 'queued'].includes(displayed.status)) return { alreadyIdle: true };
          persist(current, stateOf(current), stateOf(current).cursor);
          try {
            return await chat.cancel(current.session_id);
          } catch (error) {
            if (error.remoteRejected) {
              const latest = row(owner, id);
              persist(latest, stateOf(latest), null);
            }
            throw error;
          }
        });
      })();
      busy.set(lock, work);
      try {
        json(200, { operation: await work, conversation: view(row(owner, id)) });
      } finally {
        if (busy.get(lock) === work) busy.delete(lock);
      }
      return true;
    },
    close() {
      workbench.close();
      extensions.close();
      software.close();
      closed = true;
      watching.clear();
    },
  };
}
