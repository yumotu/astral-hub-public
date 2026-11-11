import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import {
  createRemoteIdentity,
  createRemoteServerApi,
  connectDshRemote,
  remoteOrigin,
  remoteFingerprint,
} from './dsh-remote-client.mjs';
import { agentCapabilities } from '../shared/agent-runtime.mjs';
import { createDshConversations } from './dsh-conversations.mjs';
import { managedDshSchema } from './dsh-managed.mjs';

const uuid = z.string().uuid();
const hostId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const createSchema = z
  .object({
    id: uuid,
    name: z.string().trim().min(1).max(80),
    origin: z.string().min(1).max(2048),
    account: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();
const trustSchema = z
  .object({
    deviceId: hostId,
    fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
    location: z.enum(['server', 'computer']),
  })
  .strict();
const workspace = z
  .object({
    workspaceId: hostId,
    path: z.string().max(4096),
    title: z.string().max(500),
    sessionIds: z.array(hostId).max(10000),
  })
  .passthrough();
const session = z
  .object({
    sessionId: hostId,
    updatedAt: z.number().finite().nonnegative(),
    running: z.boolean(),
    blank: z.boolean(),
    title: z.string().max(500).optional(),
    parentSessionId: hostId.optional(),
    origin: z.string().max(100).optional(),
  })
  .passthrough();

// Connections and chat have separate experiment gates until real-host acceptance.
export function createDshRemote(
  db,
  {
    token,
    body,
    enabled = false,
    chatEnabled = false,
    managed = null,
    allowedOrigins = [],
    fetch: request,
    connect = connectDshRemote,
    appTools,
    files,
    now = Date.now,
  },
) {
  const origins = new Set(allowedOrigins);
  if (managed) {
    managed = managedDshSchema.parse(managed);
    remoteOrigin(managed.origin, origins);
  }
  const key = createHash('sha256')
    .update('astral-dsh-remote-v1:' + token)
    .digest();
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_remote_connections(
    owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,origin TEXT NOT NULL,
    account TEXT NOT NULL,state TEXT NOT NULL,secret TEXT,revision INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner,id));`);
  // An unknown registration outcome never starts again after restart.
  db.exec("UPDATE dsh_remote_connections SET state='interrupted' WHERE state='authorizing'");
  const active = new Map(),
    refreshing = new Map(),
    rates = new Map(),
    catalogues = new Map();
  const lifetime = new AbortController();
  let closed = false;
  const conversations = createDshConversations(db, {
    body,
    connection,
    catalogue,
    live,
    rate,
    now,
    appTools,
    files,
  });
  const rowFor = (owner, id) =>
    db
      .prepare('SELECT * FROM dsh_remote_connections WHERE owner=? AND id=? AND revoked=0')
      .get(owner, id);
  const index = (owner, id) => JSON.stringify([owner, id]);
  function rate(owner, bucket, maximum) {
    const key = owner + ':' + bucket,
      time = now(),
      entry = rates.get(key);
    if (entry && entry.until > time) {
      if (++entry.count > maximum) throw fail(429, 'Remote 请求较多，请稍后再试。');
    } else rates.set(key, { count: 1, until: time + 60000 });
    if (rates.size > 2000)
      for (const [key, entry] of rates) if (entry.until <= time) rates.delete(key);
  }
  function seal(owner, id, value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }
  function open(row) {
    try {
      const [iv, tag, data] = row.secret.split('.').map((v) => Buffer.from(v, 'base64url'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([row.owner, row.id])));
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
    } catch {
      throw fail(409, 'Remote 凭据无法读取，请重新建立连接。');
    }
  }
  function live(owner, id, revision) {
    if (closed) throw fail(409, 'Remote 连接服务已关闭。');
    const row = rowFor(owner, id);
    if (!row) throw fail(404, 'Remote 连接不存在或已撤销。');
    if (revision !== undefined && row.revision !== revision)
      throw fail(409, 'Remote 连接已变化，请刷新后重试。');
    remoteOrigin(row.origin, origins);
    return row;
  }
  const view = (row) => ({
    id: row.id,
    name: row.name,
    origin: row.origin,
    account: row.account,
    state: row.state,
    revision: row.revision,
    host:
      row.state === 'ready'
        ? (() => {
            const value = open(row).peer;
            return value
              ? {
                  deviceId: value.deviceId,
                  name: value.name,
                  fingerprint: remoteFingerprint(value.publicKey),
                  location: value.location,
                }
              : null;
          })()
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const api = (row) =>
    createRemoteServerApi({
      origin: row.origin,
      allowedOrigins: origins,
      fetch: (url, init) =>
        (request || fetch)(url, {
          ...init,
          signal: AbortSignal.any([lifetime.signal, init.signal]),
        }),
    });
  async function credential(owner, id) {
    const row = live(owner, id);
    if (row.state !== 'ready') throw fail(409, 'Remote 设备授权尚未完成，请重新建立连接。');
    const value = open(row);
    if (value.tokens.refreshTokenExpiresAt <= now())
      throw fail(403, 'Remote 设备授权已过期，请重新连接。');
    if (value.tokens.accessTokenExpiresAt > now() + 30000) return { row, value };
    const key = index(owner, id);
    if (!refreshing.has(key)) {
      const pending = (async () => {
        const tokens = await api(row).refresh(value.identity, value.tokens);
        live(owner, id, row.revision);
        db.prepare(
          'UPDATE dsh_remote_connections SET secret=?,updated_at=? WHERE owner=? AND id=? AND revision=? AND revoked=0',
        ).run(
          seal(owner, id, { ...value, tokens }),
          new Date(now()).toISOString(),
          owner,
          id,
          row.revision,
        );
      })();
      refreshing.set(key, pending);
      void pending
        .finally(() => {
          if (refreshing.get(key) === pending) refreshing.delete(key);
        })
        .catch(() => {});
    }
    await refreshing.get(key);
    const next = live(owner, id, row.revision);
    return { row: next, value: open(next) };
  }
  async function connection(owner, id) {
    const saved = await credential(owner, id);
    if (!saved.value.peer) throw fail(409, '请先核对并信任目标主机身份。');
    const { row, value } = saved,
      key = index(owner, id);
    const existing = active.get(key);
    if (existing?.revision === row.revision) return existing.promise;
    if (existing) await existing.close();
    if (active.size >= 64) throw fail(429, 'DSH活动连接较多，请先断开不使用的连接。');
    const controller = new AbortController();
    const stopWithService = () => controller.abort();
    lifetime.signal.addEventListener('abort', stopWithService, { once: true });
    const entry = {
      revision: row.revision,
      close: async () => {
        lifetime.signal.removeEventListener('abort', stopWithService);
        controller.abort();
        const established = await entry.promise.catch(() => null);
        await established?.client.close();
        if (active.get(key) === entry) active.delete(key);
      },
    };
    entry.promise = (async () => {
      const peer = await api(row).peer(value.tokens, value.peer.deviceId, controller.signal);
      live(owner, id, row.revision);
      if (peer.publicKey !== value.peer.publicKey || peer.membershipId !== value.peer.membershipId)
        throw fail(409, 'Remote 主机身份或账号授权已变化，请重新核对。');
      const { location: ignored, ...trusted } = value.peer;
      const client = await connect({
        origin: row.origin,
        allowedOrigins: origins,
        identity: value.identity,
        tokens: value.tokens,
        peer: trusted,
        signal: controller.signal,
      });
      try {
        live(owner, id, row.revision);
        controller.signal.throwIfAborted();
      } catch (error) {
        await client.close();
        throw error;
      }
      client.onClose?.(() => {
        conversations.disconnect(owner, id);
        lifetime.signal.removeEventListener('abort', stopWithService);
        if (active.get(key) === entry) active.delete(key);
      });
      return { client, row, peer: value.peer };
    })();
    active.set(key, entry);
    void entry.promise.catch(() => {
      lifetime.signal.removeEventListener('abort', stopWithService);
      if (active.get(key) === entry) active.delete(key);
    });
    return entry.promise;
  }
  async function catalogue(owner, id) {
    const { client, row, peer } = await connection(owner, id);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 20000);
    let source;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(fail(504, 'DSH 目录读取超时，请重新查询。')),
        { once: true },
      );
    });
    try {
      source = await Promise.race([client.workspaces(controller.signal), aborted]);
      const iterator = source[Symbol.asyncIterator]();
      const first = await Promise.race([iterator.next(), aborted]);
      if (first.done || first.value?.type !== 'baseline') throw fail(502, 'DSH 工作区快照无效。');
      const spaces = z.array(workspace).max(2000).parse(first.value.value?.items);
      if (new Set(spaces.map((row) => row.workspaceId)).size !== spaces.length)
        throw fail(502, 'DSH 工作区编号重复。');
      const data = await client.sessions(controller.signal);
      const sessions = z.array(session).max(10000).parse(data.items);
      if (new Set(sessions.map((row) => row.sessionId)).size !== sessions.length)
        throw fail(502, 'DSH 会话编号重复。');
      live(owner, id, row.revision);
      const ids = new Set(spaces.flatMap((row) => row.sessionIds));
      return {
        host: { deviceId: peer.deviceId, name: peer.name, location: peer.location },
        workspaces: spaces.map(({ workspaceId, title }) => ({ id: workspaceId, name: title })),
        sessions: sessions
          .filter(
            (row) => ids.has(row.sessionId) && !row.parentSessionId && row.origin !== 'subagent',
          )
          .map(({ sessionId, title, updatedAt, running, blank, projections }) => ({
            id: sessionId,
            title:
              typeof projections?.values?.title === 'string'
                ? projections.values.title.slice(0, 500)
                : title || 'DSH 对话',
            updatedAt,
            running,
            blank,
            workspaceIds: spaces
              .filter((space) => space.sessionIds.includes(sessionId))
              .map((space) => space.workspaceId),
          })),
        agent: {
          backend: 'dsh',
          transport: 'dsh-remote',
          // Catalogue success does not advertise mutation/attachment support.
          capabilities: agentCapabilities({}, 'DSH 聊天接入仍在验收，当前仅提供目录读取。'),
        },
      };
    } finally {
      clearTimeout(deadline);
      await source?.close().catch(() => {});
      controller.abort();
    }
  }
  function managedActor(actor) {
    if (!managed || actor.role !== 'owner' || actor.id !== managed.owner)
      throw fail(403, '此服务器DSH工作区仅向配置的管理员开放。');
    if (
      !actor.sessionHash ||
      !db
        .prepare(
          "SELECT 1 FROM sessions JOIN users ON users.id=sessions.user_id WHERE user_id=? AND hash=? AND expires>? AND users.role='owner'",
        )
        .get(actor.id, actor.sessionHash, now())
    )
      throw fail(403, '当前登录授权已失效，请重新登录。');
  }
  async function managedConnection(actor, id) {
    managedActor(actor);
    const existing = db
      .prepare(
        'SELECT * FROM dsh_remote_connections WHERE owner=? AND origin=? AND revoked=0 ORDER BY created_at LIMIT 1',
      )
      .get(actor.id, managed.origin);
    if (existing) {
      const current = view(existing);
      if (
        current.state === 'ready' &&
        current.host?.deviceId === managed.deviceId &&
        current.host.fingerprint === managed.fingerprint
      )
        return current;
      throw fail(409, '原服务器关联结果需核对，请先移除该记录；不会自动重复授权。');
    }
    if (db.prepare('SELECT 1 FROM dsh_remote_connections WHERE owner=? AND id=?').get(actor.id, id))
      throw fail(409, '此关联编号已使用，请查看原记录。');
    const identity = createRemoteIdentity(),
      stamp = new Date(now()).toISOString();
    db.prepare('INSERT INTO dsh_remote_connections VALUES(?,?,?,?,?,?,?,1,0,?,?)').run(
      actor.id,
      id,
      managed.name,
      managed.origin,
      managed.account,
      'authorizing',
      seal(actor.id, id, { identity }),
      stamp,
      stamp,
    );
    const row = live(actor.id, id);
    try {
      const { account, tokens } = await api(row).authorize(
        identity,
        managed.account,
        managed.password,
      );
      managedActor(actor);
      live(actor.id, id, 1);
      const peer = await api(row).peer(tokens, managed.deviceId);
      managedActor(actor);
      live(actor.id, id, 1);
      if (remoteFingerprint(peer.publicKey) !== managed.fingerprint)
        throw fail(409, '服务器DSH主机身份已变化，请管理员检查部署，不会自动信任新身份。');
      db.prepare(
        "UPDATE dsh_remote_connections SET state='ready',account=?,secret=?,revision=2,updated_at=? WHERE owner=? AND id=? AND revision=1 AND revoked=0",
      ).run(
        account,
        seal(actor.id, id, { identity, tokens, peer: { ...peer, location: 'server' } }),
        new Date(now()).toISOString(),
        actor.id,
        id,
      );
      return view(live(actor.id, id, 2));
    } catch (error) {
      if (!closed)
        db.prepare(
          "UPDATE dsh_remote_connections SET state='error',secret=NULL,updated_at=? WHERE owner=? AND id=? AND revision=1 AND revoked=0",
        ).run(new Date(now()).toISOString(), actor.id, id);
      throw error;
    }
  }
  return {
    before: (...args) => (enabled && chatEnabled ? conversations.before(...args) : false),
    appActive: (ctx) => enabled && chatEnabled && conversations.appActive(ctx),
    revokeAccount: (owner) => conversations.revokeAccount(owner),
    fileCatalog: (ctx) => conversations.fileCatalog(ctx),
    fileRead: (ctx, p) => conversations.fileRead(ctx, p),
    conversations: (owner, id) => conversations.read(owner, id),
    status(owner) {
      return {
        enabled,
        chatAvailable: enabled && chatEnabled,
        managedServer:
          enabled && chatEnabled && managed?.owner === owner ? { name: managed.name } : null,
        reason: enabled
          ? chatEnabled
            ? ''
            : 'DSH Remote 聊天仍在验收，当前只提供连接目录。'
          : 'DSH Remote 接入尚未启用。',
        connections: db
          .prepare(
            'SELECT id,name,state FROM dsh_remote_connections WHERE owner=? AND revoked=0 ORDER BY created_at',
          )
          .all(owner),
      };
    },
    async handle(req, url, json, actor, res) {
      if (!url.pathname.startsWith('/api/agent/remote')) return false;
      if (!actor?.id) throw fail(403, '请先使用独立账号登录。');
      if (url.pathname === '/api/agent/remote/status' && req.method === 'GET') {
        json(200, {
          ...this.status(actor.id),
          allowedOrigins: [...origins].filter((origin) => origin !== managed?.origin),
        });
        return true;
      }
      if (!enabled) throw fail(503, 'DSH Remote 接入尚未启用。');
      if (url.pathname === '/api/agent/remote/managed/connect' && req.method === 'POST') {
        if (!chatEnabled) throw fail(503, 'DSH Remote 聊天尚未启用。');
        managedActor(actor);
        rate(actor.id, 'managed', 5);
        const { id } = z
          .object({ id: uuid })
          .strict()
          .parse(await body(req));
        json(200, { connection: await managedConnection(actor, id) });
        return true;
      }
      if (url.pathname.startsWith('/api/agent/remote/conversations') && !chatEnabled)
        throw fail(503, 'DSH Remote 聊天尚未启用。');
      if (await conversations.handle(req, url, json, actor, res)) return true;
      const base = '/api/agent/remote/connections';
      if (url.pathname === base) {
        if (req.method === 'GET') {
          rate(actor.id, 'read', 120);
          json(200, {
            connections: db
              .prepare(
                'SELECT * FROM dsh_remote_connections WHERE owner=? AND revoked=0 ORDER BY created_at',
              )
              .all(actor.id)
              .map(view),
          });
          return true;
        }
        if (req.method === 'POST') {
          rate(actor.id, 'authorize', 5);
          const p = createSchema.parse(await body(req));
          const origin = remoteOrigin(p.origin, origins);
          if (managed?.origin === origin)
            throw fail(403, '请使用服务器DSH关联入口；此来源不接受手工凭据。');
          if (
            db
              .prepare('SELECT 1 FROM dsh_remote_connections WHERE owner=? AND id=?')
              .get(actor.id, p.id)
          )
            throw fail(409, '此连接编号已使用，请查看原记录，不会重复授权。');
          if (
            db
              .prepare('SELECT count(*) n FROM dsh_remote_connections WHERE owner=? AND revoked=0')
              .get(actor.id).n >= 20
          )
            throw fail(429, '请先移除不需要的 Remote 连接。');
          const identity = createRemoteIdentity(),
            stamp = new Date(now()).toISOString();
          db.prepare('INSERT INTO dsh_remote_connections VALUES(?,?,?,?,?,?,?,1,0,?,?)').run(
            actor.id,
            p.id,
            p.name,
            origin,
            p.account,
            'authorizing',
            seal(actor.id, p.id, { identity }),
            stamp,
            stamp,
          );
          const row = live(actor.id, p.id);
          try {
            const { account, tokens } = await api(row).authorize(identity, p.account, p.password);
            live(actor.id, p.id, 1);
            db.prepare(
              "UPDATE dsh_remote_connections SET state='ready',account=?,secret=?,updated_at=? WHERE owner=? AND id=? AND revoked=0 AND revision=1",
            ).run(
              account,
              seal(actor.id, p.id, { identity, tokens }),
              new Date(now()).toISOString(),
              actor.id,
              p.id,
            );
            json(201, { connection: view(live(actor.id, p.id)) });
          } catch (error) {
            if (!closed)
              db.prepare(
                "UPDATE dsh_remote_connections SET state='error',updated_at=? WHERE owner=? AND id=? AND revoked=0 AND revision=1",
              ).run(new Date(now()).toISOString(), actor.id, p.id);
            throw error;
          }
          return true;
        }
      }
      const match = url.pathname.match(
        /^\/api\/agent\/remote\/connections\/([^/]+)(?:\/(hosts|identity|trust|catalogue))?$/,
      );
      if (!match) return false;
      const id = uuid.parse(match[1]),
        owner = actor.id;
      live(owner, id);
      if (!match[2] && req.method === 'DELETE') {
        rate(owner, 'remove', 30);
        db.prepare(
          'UPDATE dsh_remote_connections SET revoked=1,secret=NULL,revision=revision+1 WHERE owner=? AND id=?',
        ).run(owner, id);
        conversations.disconnect(owner, id);
        await active.get(index(owner, id))?.close();
        json(200, { ok: true });
        return true;
      }
      if (req.method === 'GET' && ['hosts', 'identity'].includes(match[2])) {
        rate(owner, 'discovery', 30);
        const { row, value } = await credential(owner, id);
        const result =
          match[2] === 'hosts'
            ? { hosts: await api(row).hosts(value.tokens) }
            : await api(row).peer(value.tokens, hostId.parse(url.searchParams.get('deviceId')));
        live(owner, id, row.revision);
        json(
          200,
          match[2] === 'identity'
            ? {
                deviceId: result.deviceId,
                name: result.name,
                fingerprint: remoteFingerprint(result.publicKey),
              }
            : result,
        );
        return true;
      }
      if (match[2] === 'trust' && req.method === 'POST') {
        rate(owner, 'trust', 10);
        const p = trustSchema.parse(await body(req));
        const { row, value } = await credential(owner, id);
        const peer = await api(row).peer(value.tokens, p.deviceId);
        live(owner, id, row.revision);
        if (remoteFingerprint(peer.publicKey) !== p.fingerprint)
          throw fail(409, 'Remote 主机指纹不一致，请重新核对。');
        if (value.peer) {
          if (
            value.peer.deviceId !== peer.deviceId ||
            value.peer.publicKey !== peer.publicKey ||
            value.peer.membershipId !== peer.membershipId ||
            value.peer.location !== p.location
          )
            throw fail(409, '此连接已绑定另一主机，请建立新连接。');
          json(200, { connection: view(row) });
          return true;
        }
        const saved = db
          .prepare(
            'UPDATE dsh_remote_connections SET secret=?,revision=revision+1,updated_at=? WHERE owner=? AND id=? AND revision=? AND revoked=0',
          )
          .run(
            seal(owner, id, { ...value, peer: { ...peer, location: p.location } }),
            new Date(now()).toISOString(),
            owner,
            id,
            row.revision,
          );
        if (saved.changes !== 1) throw fail(409, 'Remote 连接已变化，请重新核对。');
        json(200, { connection: view(live(owner, id)) });
        return true;
      }
      if (match[2] === 'catalogue' && req.method === 'GET') {
        rate(owner, 'catalogue', 30);
        const key = index(owner, id);
        if (!catalogues.has(key)) {
          const pending = catalogue(owner, id);
          catalogues.set(key, pending);
          void pending
            .finally(() => {
              if (catalogues.get(key) === pending) catalogues.delete(key);
            })
            .catch(() => {});
        }
        json(200, await catalogues.get(key));
        return true;
      }
      return false;
    },
    async close() {
      closed = true;
      conversations.close();
      lifetime.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.close()));
      active.clear();
    },
  };
}
