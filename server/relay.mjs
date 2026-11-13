import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { digest, fail } from './accounts.mjs';
import { createRelayWorkspace } from './relay-workspace.mjs';
const uuid = z.string().uuid(),
  access = z.enum(['read', 'edit']);
const PROJECT_MODEL_MAX_BYTES = 16 * 1024 * 1024;
export function createRelay(db, { body, config, options = {} }) {
  const now = options.now ?? Date.now,
    providerFetch = options.relayFetch ?? config.fetch;
  db.exec(`CREATE TABLE IF NOT EXISTS relay_pairings(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS relay_devices(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,root_label TEXT NOT NULL,allow_write INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS relay_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,input TEXT NOT NULL,access TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER,output TEXT NOT NULL DEFAULT '',tools TEXT NOT NULL DEFAULT '[]',error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS relay_queue ON relay_jobs(device_id,status,created_at);`);
  const deviceColumns = new Set(
    db
      .prepare('PRAGMA table_info(relay_devices)')
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of [
    ['agent_version', 'TEXT'],
    ['capabilities', "TEXT NOT NULL DEFAULT '[]'"],
  ])
    if (!deviceColumns.has(name)) db.exec(`ALTER TABLE relay_devices ADD COLUMN ${name} ${type}`);
  const rate = new Map(),
    controllers = new Map();
  function limit(key, max, span = 60000) {
    const time = now(),
      old = rate.get(key);
    if (old && old.until > time) {
      if (old.n >= max) throw fail(429, '请求较多，请稍后再试。');
      old.n++;
    } else rate.set(key, { n: 1, until: time + span });
    if (rate.size > 2000) for (const [k, v] of rate) if (v.until <= time) rate.delete(k);
  }
  function sweep() {
    db.prepare(
      "UPDATE relay_jobs SET status='interrupted',error='执行器失联，任务不会自动重复执行。',updated_at=? WHERE status='running' AND lease_until<=?",
    ).run(new Date(now()).toISOString(), now());
    for (const [id, controller] of controllers) {
      const j = db.prepare('SELECT status,lease_until FROM relay_jobs WHERE id=?').get(id);
      if (!j || j.status !== 'running' || j.lease_until <= now()) controller.abort();
    }
  }
  function authenticate(req) {
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const d = db
      .prepare('SELECT * FROM relay_devices WHERE token_hash=? AND revoked=0 AND expires>?')
      .get(digest(raw), now());
    if (!d) throw fail(401, '设备未配对、授权已撤销或已过期。');
    return d;
  }
  const deviceView = (d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    rootLabel: d.root_label,
    allowWrite: !!d.allow_write,
    lastSeen: new Date(d.last_seen).toISOString(),
    online: now() - d.last_seen < 45000,
    createdAt: d.created_at,
    agentVersion: d.agent_version || null,
    capabilities: JSON.parse(d.capabilities || '[]'),
  });
  const jobView = (j) =>
    j && {
      id: j.id,
      deviceId: j.device_id,
      input: j.input,
      access: j.access,
      status: j.status,
      output: j.output,
      tools: JSON.parse(j.tools),
      error: j.error,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  function ownedDevice(id, owner) {
    const d = db
      .prepare('SELECT * FROM relay_devices WHERE id=? AND owner=? AND revoked=0')
      .get(id, owner);
    if (!d) throw fail(404, '设备不存在。');
    return d;
  }
  function deviceJob(device, id) {
    const j = db.prepare('SELECT * FROM relay_jobs WHERE id=? AND device_id=?').get(id, device.id);
    if (!j) throw fail(404, '任务不存在。');
    return j;
  }
  function cancel(id) {
    const j = db.prepare('SELECT status,project_id,state FROM relay_jobs WHERE id=?').get(id);
    if (j?.status === 'running' && j.project_id) {
      const state = JSON.parse(j.state || '{}');
      state.stop = { requestedAt: new Date(now()).toISOString(), acknowledgedAt: null };
      state.uiRevision = (state.uiRevision || 0) + 1;
      db.prepare('UPDATE relay_jobs SET state=? WHERE id=?').run(JSON.stringify(state), id);
    }
    db.prepare(
      "UPDATE relay_jobs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')",
    ).run(new Date(now()).toISOString(), id);
    controllers.get(id)?.abort();
  }
  const workspace = createRelayWorkspace(db, {
    body,
    now,
    limit,
    ownedDevice,
    cancel,
    model: config.model,
    notifications: options.notifications,
    chatFiles: options.chatFiles,
    draftComputerPlugin: options.draftComputerPlugin,
    onlinePackages: options.onlinePackages,
    appFunctions: options.appFunctions,
    unified: options.unified,
  });
  const leaseTimer = setInterval(() => {
    sweep();
    workspace.sweep();
  }, 5000);
  leaseTimer.unref();
  function activeModelJob(device, id) {
    const j = deviceJob(device, id);
    if (j.status !== 'running' || j.lease_until <= now())
      throw fail(403, '只有正在执行的任务可以调用模型。');
    workspace.computer.allowed(j);
    return j;
  }
  return {
    unified: workspace.computer.unified,
    schedule: (run) => workspace.computer.schedule(run),
    async before(req, url, res, json) {
      const path = url.pathname;
      if (path === '/api/relay/device/enroll' && req.method === 'POST') {
        limit('enroll:' + req.socket.remoteAddress, 10);
        const p = z
          .object({
            code: z.string().min(20).max(100),
            name: z.string().trim().min(1).max(60),
            platform: z.enum(['darwin', 'win32', 'linux']),
            rootLabel: z.string().trim().min(1).max(100),
            allowWrite: z.boolean(),
          })
          .strict()
          .parse(await body(req));
        const invitation = db
          .prepare('SELECT * FROM relay_pairings WHERE hash=? AND expires>?')
          .get(digest(p.code), now());
        if (!invitation) throw fail(403, '配对码无效或已过期。');
        const id = randomUUID(),
          token = randomBytes(32).toString('base64url');
        db.exec('BEGIN IMMEDIATE');
        try {
          const used = db.prepare('DELETE FROM relay_pairings WHERE hash=?').run(digest(p.code));
          if (used.changes !== 1) throw fail(403, '配对码已经使用。');
          db.prepare(
            'INSERT INTO relay_devices(id,owner,name,platform,root_label,allow_write,token_hash,expires,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            invitation.owner,
            p.name,
            p.platform,
            p.rootLabel,
            Number(p.allowWrite),
            digest(token),
            now() + 90 * 86400000,
            now(),
            new Date(now()).toISOString(),
          );
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        json(201, {
          deviceId: id,
          token,
          model: config.model,
          expiresAt: new Date(now() + 90 * 86400000).toISOString(),
        });
        return true;
      }
      if (!path.startsWith('/api/relay/device/') && path !== '/api/relay/provider/chat/completions')
        return false;
      const d = authenticate(req);
      sweep();
      if (await workspace.before(req, url, json, d, res)) return true;
      if (path === '/api/relay/device/poll' && req.method === 'GET') {
        limit('poll:' + d.id, 40);
        db.prepare('UPDATE relay_devices SET last_seen=? WHERE id=?').run(now(), d.id);
        const running = db
          .prepare("SELECT 1 FROM relay_jobs WHERE device_id=? AND status='running'")
          .get(d.id);
        if (running) {
          json(200, { job: null });
          return true;
        }
        const job = db
          .prepare(
            "SELECT * FROM relay_jobs WHERE device_id=? AND status='queued' AND project_id IS NULL ORDER BY created_at,rowid LIMIT 1",
          )
          .get(d.id);
        if (job) {
          const claimed = db
            .prepare(
              "UPDATE relay_jobs SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='queued'",
            )
            .run(now() + 45000, new Date(now()).toISOString(), job.id);
          if (claimed.changes === 1) {
            json(200, {
              job: { id: job.id, input: job.input, access: job.access, model: config.model },
            });
            return true;
          }
        }
        json(200, { job: null });
        return true;
      }
      if (path === '/api/relay/device/heartbeat' && req.method === 'POST') {
        const p = z
            .object({ jobId: uuid })
            .strict()
            .parse(await body(req)),
          j = deviceJob(d, p.jobId);
        try {
          workspace.computer.allowed(j);
        } catch (e) {
          cancel(j.id);
        }
        db.prepare('UPDATE relay_devices SET last_seen=? WHERE id=?').run(now(), d.id);
        if (j.status === 'running')
          db.prepare('UPDATE relay_jobs SET lease_until=? WHERE id=?').run(now() + 45000, j.id);
        const latest = deviceJob(d, p.jobId);
        json(200, {
          cancelled: latest.status !== 'running',
          controls: workspace.computer.controls(latest),
        });
        return true;
      }
      if (path === '/api/relay/device/result' && req.method === 'POST') {
        const p = z
          .object({
            jobId: uuid,
            status: z.enum(['done', 'error', 'cancelled']),
            output: z.string().max(48000),
            tools: z
              .array(
                z
                  .object({
                    id: z.string().max(200),
                    name: z.string().max(50),
                    path: z.string().max(500),
                    status: z.enum(['done', 'error', 'running']),
                    summary: z.string().max(1000).optional(),
                    backupId: uuid.optional(),
                    sha256: z.string().max(64).optional(),
                    bytes: z.number().nonnegative().optional(),
                  })
                  .strict(),
              )
              .max(12),
            error: z.string().max(1000).nullable().optional(),
          })
          .strict()
          .parse(await body(req));
        const j = deviceJob(d, p.jobId);
        if (j.status === 'running')
          db.prepare(
            'UPDATE relay_jobs SET status=?,output=?,tools=?,error=?,updated_at=? WHERE id=?',
          ).run(
            p.status,
            p.output,
            JSON.stringify(p.tools),
            p.error || null,
            new Date(now()).toISOString(),
            j.id,
          );
        json(200, { status: deviceJob(d, j.id).status });
        return true;
      }
      if (path === '/api/relay/provider/chat/completions' && req.method === 'POST') {
        const id = uuid.parse(req.headers['x-astral-job']);
        let j = activeModelJob(d, id);
        if (!config.apiKey) throw fail(503, '服务器未配置 DeepSeek。');
        limit('model:' + d.id, j.project_id ? 120 : 12);
        limit('model:all', j.project_id ? 240 : 30);
        const p = await body(
          req,
          j.project_id
            ? {
                maxBytes: PROJECT_MODEL_MAX_BYTES,
                tooLargeMessage:
                  '远程电脑模型请求超过 16 MiB，请压缩对话上下文或减少本轮图片后再发送。原会话已保留。',
              }
            : undefined,
        );
        // A large/slow upload must not outlive stop, lease expiry or revocation.
        j = activeModelJob(authenticate(req), id);
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          !Array.isArray(p.messages) ||
          !p.messages.length
        )
          throw fail(400, '模型请求格式不正确：messages 必须是非空数组。');
        // Native project context is bounded by UTF-8 request bytes, not turns.
        // Retain the smaller envelope for the legacy one-shot executor.
        if (!j.project_id && (p.messages.length > 100 || JSON.stringify(p).length > 300000))
          throw fail(413, '旧版电脑模型请求过大，请减少上下文或更新电脑执行器。');
        if (controllers.has(id)) throw fail(429, '本任务已有模型请求。');
        const controller = new AbortController();
        controllers.set(id, controller);
        const timer = setTimeout(() => controller.abort(), 180000);
        const close = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.on('close', close);
        const usageId = options.usage?.start({
          owner: j.owner,
          model: config.model,
          source: j.project_id ? 'computer' : 'computer-legacy',
          reference: j.id,
        });
        let reported = false;
        try {
          const response = await providerFetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...p,
              model: config.model,
              ...(p.stream ? { stream_options: { include_usage: true } } : {}),
              max_tokens: j.project_id
                ? Math.max(
                    1,
                    Math.min(16384, Number.isInteger(p.max_tokens) ? p.max_tokens : 16384),
                  )
                : 3000,
              thinking: {
                type:
                  j.project_id && j.thinking_level && j.thinking_level !== 'off'
                    ? 'enabled'
                    : 'disabled',
              },
              reasoning_effort:
                j.project_id && j.thinking_level && j.thinking_level !== 'off'
                  ? j.thinking_level
                  : 'none',
            }),
            signal: controller.signal,
            redirect: 'error',
          });
          if (!response.ok) throw fail(502, '服务器模型请求失败。');
          res.writeHead(200, {
            'Content-Type': p.stream
              ? 'text/event-stream; charset=utf-8'
              : 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          });
          const decoder = new TextDecoder();
          let pending = '';
          const observe = (value) => {
            if (value?.usage) {
              options.usage?.finish(usageId, value.usage);
              reported = true;
            }
          };
          async function* measured() {
            for await (const bytes of response.body) {
              pending += decoder.decode(bytes, { stream: true });
              if (p.stream) {
                let end;
                while ((end = pending.indexOf('\n')) >= 0) {
                  const line = pending.slice(0, end).trim();
                  pending = pending.slice(end + 1);
                  if (line.startsWith('data:'))
                    try {
                      observe(JSON.parse(line.slice(5)));
                    } catch {}
                }
              }
              if (pending.length > 2 * 1024 * 1024) pending = '';
              yield bytes;
            }
            pending += decoder.decode();
            if (!p.stream)
              try {
                observe(JSON.parse(pending));
              } catch {}
          }
          await pipeline(Readable.from(measured()), res);
        } catch (e) {
          if (res.headersSent) res.destroy();
          else throw fail(502, '模型请求中断或失败。');
        } finally {
          if (!reported) options.usage?.finish(usageId, null);
          clearTimeout(timer);
          controllers.delete(id);
          res.off('close', close);
        }
        return true;
      }
      throw fail(404, '设备接口不存在。');
    },
    async after(req, url, json, actor) {
      const path = url.pathname;
      if (!path.startsWith('/api/relay/')) return false;
      if (!actor?.id) throw fail(403, '请用独立账号管理自己的电脑连接。');
      sweep();
      workspace.sweep();
      workspace.computer.sweep();
      if (await workspace.after(req, url, json, actor)) return true;
      if (path === '/api/relay/devices' && req.method === 'GET') {
        json(200, {
          devices: db
            .prepare(
              'SELECT * FROM relay_devices WHERE owner=? AND revoked=0 ORDER BY created_at DESC',
            )
            .all(actor.id)
            .map(deviceView),
        });
        return true;
      }
      if (path === '/api/relay/pairing' && req.method === 'POST') {
        limit('pairing:' + actor.id, 5);
        if (
          db
            .prepare('SELECT COUNT(*) AS n FROM relay_devices WHERE owner=? AND revoked=0')
            .get(actor.id).n >= 10
        )
          throw fail(429, '最多配对十台设备，请先撤销旧设备。');
        db.prepare('DELETE FROM relay_pairings WHERE expires<=?').run(now());
        const code = randomBytes(16).toString('hex'),
          expires = now() + 10 * 60000;
        db.prepare('INSERT INTO relay_pairings VALUES(?,?,?)').run(digest(code), actor.id, expires);
        json(201, { code, expiresAt: new Date(expires).toISOString() });
        return true;
      }
      const device = path.match(/^\/api\/relay\/devices\/([^/]+)$/);
      if (device && req.method === 'DELETE') {
        const d = ownedDevice(uuid.parse(device[1]), actor.id);
        db.prepare('UPDATE relay_devices SET revoked=1 WHERE id=?').run(d.id);
        workspace.revoke(d.id);
        for (const j of db
          .prepare("SELECT id FROM relay_jobs WHERE device_id=? AND status IN ('queued','running')")
          .all(d.id))
          cancel(j.id);
        json(200, { ok: true });
        return true;
      }
      if (path === '/api/relay/jobs') {
        if (req.method === 'GET') {
          const id = uuid.parse(url.searchParams.get('deviceId'));
          ownedDevice(id, actor.id);
          json(200, {
            jobs: db
              .prepare(
                'SELECT * FROM relay_jobs WHERE owner=? AND device_id=? AND project_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 50',
              )
              .all(actor.id, id)
              .map(jobView),
          });
          return true;
        }
        if (req.method === 'POST') {
          limit('dispatch:' + actor.id, 10);
          const p = z
              .object({
                id: uuid,
                deviceId: uuid,
                input: z.string().trim().min(1).max(8000),
                access,
              })
              .strict()
              .parse(await body(req)),
            d = ownedDevice(p.deviceId, actor.id);
          if (p.access === 'edit' && !d.allow_write) throw fail(403, '目标电脑尚未允许修改文件。');
          const existing = db.prepare('SELECT * FROM relay_jobs WHERE id=?').get(p.id);
          if (existing) {
            if (
              existing.owner !== actor.id ||
              existing.device_id !== p.deviceId ||
              existing.input !== p.input ||
              existing.access !== p.access
            )
              throw fail(409, '任务编号已经使用。');
            json(200, { job: jobView(existing) });
            return true;
          }
          if (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM relay_jobs WHERE device_id=? AND status IN ('queued','running')",
              )
              .get(d.id).n >= 5
          )
            throw fail(429, '目标设备等待中的任务较多。');
          const time = new Date(now()).toISOString();
          db.prepare(
            "INSERT INTO relay_jobs(id,owner,device_id,input,access,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
          ).run(p.id, actor.id, p.deviceId, p.input, p.access, time, time);
          json(201, { job: jobView(db.prepare('SELECT * FROM relay_jobs WHERE id=?').get(p.id)) });
          return true;
        }
      }
      const job = path.match(/^\/api\/relay\/jobs\/([^/]+)\/cancel$/);
      if (job && req.method === 'POST') {
        const id = uuid.parse(job[1]),
          j = db.prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=?').get(id, actor.id);
        if (!j) throw fail(404, '任务不存在。');
        cancel(id);
        json(200, { ok: true });
        return true;
      }
      throw fail(404, '中转接口不存在。');
    },
    close() {
      clearInterval(leaseTimer);
      for (const c of controllers.values()) c.abort();
    },
  };
}
