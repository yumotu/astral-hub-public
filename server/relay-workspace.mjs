import { z } from 'zod';
import { createProjectLabels, projectLabelSchema } from './project-labels.mjs';
import { fail } from './accounts.mjs';
import { createRelayComputer } from './relay-computer.mjs';
import { createRelayTerminals } from './relay-terminals.mjs';
import { parseComputerPlugin, pluginPermissions } from '../shared/computer-plugin.mjs';
import { agentCapabilities } from '../shared/agent-runtime.mjs';
const pluginManifest = z.unknown().transform((v, ctx) => {
  try {
    return parseComputerPlugin(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e.message });
    return z.NEVER;
  }
});
const uuid = z.string().uuid(),
  path = z.string().min(1).max(500),
  hash = z.string().regex(/^(?:new|[a-f0-9]{64})$/);
const revision = z.union([z.literal('new'), uuid]);
const packageName = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/);
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), path }).strict(),
  z.object({ kind: z.literal('read'), path }).strict(),
  z.object({ kind: z.literal('download'), path }).strict(),
  z.object({ kind: z.literal('mkdir'), path }).strict(),
  z
    .object({ kind: z.literal('write'), path, content: z.string().max(262144), expectedHash: hash })
    .strict(),
  z.object({ kind: z.literal('restore'), backupId: uuid }).strict(),
  z.object({ kind: z.literal('plugin_list') }).strict(),
  z.object({ kind: z.literal('package_list') }).strict(),
  z
    .object({
      kind: z.literal('package_install'),
      previewId: uuid,
      expectedRevision: revision,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('package_enable'),
      name: packageName,
      enabled: z.boolean(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({ kind: z.literal('package_remove'), name: packageName, expectedRevision: revision })
    .strict(),
  z
    .object({
      kind: z.literal('package_rollback'),
      expectedRevision: revision,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plugin_register'),
      manifest: pluginManifest,
      enabled: z.boolean(),
      expectedHash: hash,
    })
    .strict(),
  z
    .object({
      kind: z.literal('plugin_remove'),
      pluginId: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
      expectedHash: hash,
    })
    .strict(),
]);
export function createRelayWorkspace(
  db,
  {
    body,
    now,
    limit,
    ownedDevice,
    cancel,
    model,
    notifications,
    chatFiles,
    draftComputerPlugin,
    onlinePackages,
    appFunctions,
  },
) {
  const labels = createProjectLabels(db);
  db.exec(`CREATE TABLE IF NOT EXISTS relay_projects(device_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,allow_write INTEGER NOT NULL,allow_execute INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,id));
 CREATE TABLE IF NOT EXISTS relay_operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,project_id TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS relay_operations_queue ON relay_operations(device_id,status,created_at);`);
  const project = (device, id) => {
    const p = db
      .prepare('SELECT * FROM relay_projects WHERE device_id=? AND id=? AND revoked=0')
      .get(device, id);
    if (!p) throw fail(404, '电脑尚未授权这个项目，或授权已撤销。');
    return p;
  };
  const projectView = (p) => ({
    id: p.id,
    name: p.name,
    readOnly: !p.allow_write,
    allowExecute: !!p.allow_execute,
    target: 'computer',
  });
  const opView = (r) => ({
    id: r.id,
    deviceId: r.device_id,
    projectId: r.project_id,
    operation: JSON.parse(r.input),
    status: r.status,
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  function sweep() {
    terminals.sweep();
    computer.sweep();
    db.prepare(
      "UPDATE relay_operations SET status='interrupted',error='执行器失联，结果未知，未自动重放。',updated_at=? WHERE status='running' AND lease_until<=?",
    ).run(new Date(now()).toISOString(), now());
  }
  function revoke(device, id) {
    const suffix = id ? ' AND project_id=?' : '';
    const args = id ? [device, id] : [device];
    db.prepare(
      "UPDATE relay_operations SET status='cancelled',error='本机项目授权已撤销。' WHERE device_id=? AND status IN ('queued','running')" +
        suffix,
    ).run(...args);
    computer.revoke(device, id);
    terminals.revoke(device, id);
  }
  const computer = createRelayComputer(db, {
    body,
    now,
    limit,
    ownedDevice,
    project,
    cancel,
    model,
    notifications,
    chatFiles,
    appFunctions,
  });
  const terminals = createRelayTerminals(db, { body, now, limit, ownedDevice, project });
  return {
    project,
    projectView,
    sweep,
    revoke,
    computer,
    async before(req, url, json, d, res) {
      if (await computer.before(req, url, json, d, res)) return true;
      if (await terminals.before(req, url, json, d)) return true;
      const route = url.pathname;
      if (route === '/api/relay/device/workspace/announce' && req.method === 'POST') {
        limit('announce:' + d.id, 30);
        const p = z
          .object({
            version: z.literal(2),
            agentVersion: z
              .string()
              .regex(/^\d+\.\d+\.\d+$/)
              .max(30)
              .optional(),
            capabilities: z
              .array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/))
              .max(64)
              .optional(),
            projects: z
              .array(
                z
                  .object({
                    id: uuid,
                    name: z.string().trim().min(1).max(100),
                    allowWrite: z.boolean(),
                    allowExecute: z.boolean(),
                  })
                  .strict(),
              )
              .max(32),
          })
          .strict()
          .parse(await body(req));
        if (new Set(p.projects.map((p) => p.id)).size !== p.projects.length)
          throw fail(400, '项目编号重复。');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE relay_devices SET agent_version=?,capabilities=? WHERE id=?').run(
            p.agentVersion || null,
            JSON.stringify([...new Set(p.capabilities || [])]),
            d.id,
          );
          const previous = db
            .prepare('SELECT * FROM relay_projects WHERE device_id=? AND revoked=0')
            .all(d.id);
          db.prepare('UPDATE relay_projects SET revoked=1 WHERE device_id=?').run(d.id);
          for (const x of p.projects)
            db.prepare(
              'INSERT INTO relay_projects VALUES(?,?,?,?,?,0) ON CONFLICT(device_id,id) DO UPDATE SET name=excluded.name,allow_write=excluded.allow_write,allow_execute=excluded.allow_execute,revoked=0',
            ).run(d.id, x.id, x.name, Number(x.allowWrite), Number(x.allowExecute));
          for (const old of previous) {
            const current = p.projects.find((p) => p.id === old.id);
            if (
              !current ||
              (old.allow_write && !current.allowWrite) ||
              (old.allow_execute && !current.allowExecute)
            )
              revoke(d.id, old.id);
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        json(200, { ok: true });
        return true;
      }
      if (route === '/api/relay/device/workspace/poll' && req.method === 'GET') {
        const batch = url.searchParams.get('batch') === '1';
        limit('workspace-poll:' + d.id, batch ? 1200 : 180);
        sweep();
        db.prepare('UPDATE relay_devices SET last_seen=? WHERE id=?').run(now(), d.id);
        const candidates = db
          .prepare(
            "SELECT * FROM relay_operations WHERE device_id=? AND status='queued' ORDER BY created_at,rowid LIMIT 20",
          )
          .all(d.id);
        const claimed = [];
        let bytes = 0;
        for (const op of candidates) {
          if (claimed.length && (!batch || bytes + op.input.length > 300000)) break;
          bytes += op.input.length;
          db.prepare(
            "UPDATE relay_operations SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='queued'",
          ).run(now() + 45000, new Date(now()).toISOString(), op.id);
          claimed.push({ id: op.id, projectId: op.project_id, ...JSON.parse(op.input) });
        }
        json(200, batch ? { operations: claimed } : { operation: claimed[0] || null });
        return true;
      }
      if (route === '/api/relay/device/workspace/operation-heartbeat' && req.method === 'POST') {
        limit('workspace-beat:' + d.id, 1200);
        const p = z
          .object({ id: uuid })
          .strict()
          .parse(await body(req));
        sweep();
        const r = db
          .prepare('SELECT * FROM relay_operations WHERE id=? AND device_id=?')
          .get(p.id, d.id);
        if (!r) throw fail(404, '电脑请求不存在。');
        let valid = r.status === 'running';
        try {
          const pr = project(d.id, r.project_id);
          if (JSON.parse(r.input).kind.startsWith('package_') && !pr.allow_execute) valid = false;
        } catch {
          valid = false;
        }
        if (valid)
          db.prepare(
            "UPDATE relay_operations SET lease_until=? WHERE id=? AND status='running'",
          ).run(now() + 45000, r.id);
        json(200, { cancelled: !valid });
        return true;
      }
      if (route === '/api/relay/device/workspace/result' && req.method === 'POST') {
        limit('workspace-result:' + d.id, 1200);
        const p = z
          .object({
            id: uuid,
            status: z.enum(['done', 'error']),
            result: z.unknown().optional(),
            error: z.string().max(1000).optional(),
          })
          .strict()
          .parse(await body(req));
        const r = db
          .prepare('SELECT * FROM relay_operations WHERE id=? AND device_id=?')
          .get(p.id, d.id);
        if (!r) throw fail(404, '文件请求不存在。');
        const result = JSON.stringify(p.result ?? null);
        if (Buffer.byteLength(result) > 1500000) throw fail(413, '文件结果过大，请缩小文件。');
        if (r.status === 'running')
          db.prepare(
            'UPDATE relay_operations SET status=?,result=?,error=?,updated_at=? WHERE id=?',
          ).run(p.status, result, p.error || null, new Date(now()).toISOString(), p.id);
        terminals.operationResult(r, p);
        json(200, {
          status: db.prepare('SELECT status FROM relay_operations WHERE id=?').get(p.id).status,
        });
        return true;
      }
      return false;
    },
    async after(req, url, json, actor) {
      if (await computer.after(req, url, json, actor)) return true;
      if (await terminals.after(req, url, json, actor)) return true;
      const route = url.pathname;
      if (route === '/api/relay/packages/wish' && req.method === 'POST') {
        const p = z
          .object({ deviceId: uuid, projectId: uuid, wish: z.string().trim().min(2).max(4000) })
          .strict()
          .parse(await body(req));
        ownedDevice(p.deviceId, actor.id);
        project(p.deviceId, p.projectId);
        limit('computer-package-wish:' + actor.id, 15, 3600000);
        if (!onlinePackages) throw fail(503, '网上插件查找尚未配置。');
        const r = await onlinePackages.wish({ ...p, owner: actor.id });
        ownedDevice(p.deviceId, actor.id);
        project(p.deviceId, p.projectId);
        json(200, r);
        return true;
      }
      if (route === '/api/relay/plugins/wish' && req.method === 'POST') {
        const p = z
          .object({ deviceId: uuid, projectId: uuid, wish: z.string().trim().min(2).max(4000) })
          .strict()
          .parse(await body(req));
        ownedDevice(p.deviceId, actor.id);
        const pr = project(p.deviceId, p.projectId);
        limit('computer-plugin-wish:' + actor.id, 20, 3600000);
        if (!draftComputerPlugin) throw fail(503, '电脑插件生成尚未配置。');
        const manifest = parseComputerPlugin(
          await draftComputerPlugin({ wish: p.wish, project: projectView(pr) }),
        );
        // Recheck ownership after the model request; generating a draft never
        // installs software or writes a device configuration.
        ownedDevice(p.deviceId, actor.id);
        project(p.deviceId, p.projectId);
        json(200, { manifest, permissions: pluginPermissions(manifest) });
        return true;
      }
      if (route === '/api/relay/projects' && req.method === 'GET') {
        const id = uuid.parse(url.searchParams.get('deviceId'));
        const device = ownedDevice(id, actor.id);
        const capabilities = JSON.parse(device.capabilities || '[]');
        const supported = (name) => capabilities.includes(name);
        json(200, {
          projects: labels.decorate(
            actor.id,
            id,
            db
              .prepare('SELECT * FROM relay_projects WHERE device_id=? AND revoked=0')
              .all(id)
              .map((p) => ({
                ...projectView(p),
                agent: {
                  backend: 'pi',
                  transport: 'astral-relay',
                  capabilities: agentCapabilities(
                    {
                      thinking: supported('thinking_levels'),
                      attachments: supported('chat_inputs'),
                      questions: supported('interactive_questions'),
                      appFunctions: supported('app_functions'),
                      goal: supported('long_goals'),
                      // New executors report control capabilities explicitly.
                      streaming: supported('streaming'),
                      stop: supported('cancellation'),
                      steer: supported('steering'),
                      terminal: supported('terminals') && !!p.allow_execute,
                      compact: supported('compact'),
                    },
                    now() - device.last_seen < 45000 ? '' : '目标电脑离线。',
                  ),
                },
              })),
          ),
        });
        return true;
      }
      const rename = route.match(/^\/api\/relay\/projects\/([^/]+)\/display-name$/);
      if (rename && req.method === 'PUT') {
        const device = uuid.parse(url.searchParams.get('deviceId')),
          id = uuid.parse(rename[1]);
        ownedDevice(device, actor.id);
        project(device, id);
        limit('remote-label:' + actor.id, 60);
        const p = projectLabelSchema.parse(await body(req));
        labels.set(actor.id, device, id, p.name);
        json(200, { ok: true });
        return true;
      }
      if (route === '/api/relay/operations' && req.method === 'POST') {
        limit('operation:' + actor.id, 120);
        const p = z
          .object({ id: uuid, deviceId: uuid, projectId: uuid, operation })
          .strict()
          .parse(await body(req));
        const device = ownedDevice(p.deviceId, actor.id);
        const pr = project(p.deviceId, p.projectId);
        if (['write', 'mkdir', 'restore'].includes(p.operation.kind) && !pr.allow_write)
          throw fail(403, '此电脑项目仅允许读取。');
        if (p.operation.kind === 'plugin_register') {
          const permission = pluginPermissions(p.operation.manifest);
          if ((permission.write && !pr.allow_write) || (permission.execute && !pr.allow_execute))
            throw fail(403, '本机未授权插件需要的修改或命令权限。');
        }
        let prepared = p.operation;
        const old = db.prepare('SELECT * FROM relay_operations WHERE id=?').get(p.id);
        if (old) {
          const stored = JSON.parse(old.input);
          if (stored.kind === 'package_install') delete stored.package;
          if (
            old.owner !== actor.id ||
            old.device_id !== p.deviceId ||
            old.project_id !== p.projectId ||
            JSON.stringify(stored) !== JSON.stringify(p.operation)
          )
            throw fail(409, '请求编号已用于其他操作。');
          json(200, { operation: opView(old) });
          return true;
        }
        if (p.operation.kind.startsWith('package_')) {
          if (!JSON.parse(device.capabilities || '[]').includes('online_packages'))
            throw fail(409, '这台电脑尚未运行支持网上插件的执行器，请同步新版电脑执行器。');
          if (p.operation.kind !== 'package_list' && !pr.allow_execute)
            throw fail(403, '请先在目标电脑为此项目授权本机命令执行，再安装或修改网上插件。');
          if (
            p.operation.kind !== 'package_list' &&
            db
              .prepare(
                "SELECT 1 FROM relay_jobs WHERE device_id=? AND project_id=? AND status='running'",
              )
              .get(p.deviceId, p.projectId)
          )
            throw fail(409, '此项目有任务正在使用工具，请完成后再修改插件组合。');
          if (p.operation.kind === 'package_install')
            prepared = {
              ...p.operation,
              package: onlinePackages.resolve(
                p.operation.previewId,
                actor.id,
                p.deviceId,
                p.projectId,
              ),
            };
        }
        const input = JSON.stringify(prepared);
        if (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM relay_operations WHERE status IN ('queued','running')",
            )
            .get().n >= 512
        )
          throw fail(429, '文件请求队列已满。');
        const at = new Date(now()).toISOString();
        db.prepare(
          "INSERT INTO relay_operations(id,owner,device_id,project_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
        ).run(p.id, actor.id, p.deviceId, p.projectId, input, at, at);
        json(202, {
          operation: opView(db.prepare('SELECT * FROM relay_operations WHERE id=?').get(p.id)),
        });
        return true;
      }
      const op = route.match(/^\/api\/relay\/operations\/([^/]+)$/);
      if (op && req.method === 'GET') {
        const r = db
          .prepare('SELECT * FROM relay_operations WHERE id=? AND owner=?')
          .get(uuid.parse(op[1]), actor.id);
        if (!r) throw fail(404, '文件请求不存在。');
        ownedDevice(r.device_id, actor.id);
        project(r.device_id, r.project_id);
        sweep();
        json(200, {
          operation: opView(db.prepare('SELECT * FROM relay_operations WHERE id=?').get(r.id)),
        });
        return true;
      }
      return false;
    },
  };
}
