import { z } from 'zod';
import { fail } from './accounts.mjs';
const uuid = z.string().uuid(),
  dimension = { cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) };
export function createRelayTerminals(db, { body, now, limit, ownedDevice, project }) {
  db.exec(`CREATE TABLE IF NOT EXISTS relay_terminals(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,cols INTEGER NOT NULL,rows INTEGER NOT NULL,seq INTEGER NOT NULL DEFAULT 0,chunks TEXT NOT NULL DEFAULT '[]',exit_code INTEGER,error TEXT,last_seen INTEGER NOT NULL,submission TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_terminal_owner ON relay_terminals(owner,device_id,project_id);
    CREATE INDEX IF NOT EXISTS relay_terminal_operations ON relay_operations(device_id,json_extract(input,'$.sessionId'),created_at);`);
  const get = (id) => db.prepare('SELECT * FROM relay_terminals WHERE id=?').get(id);
  const view = (r) => ({
    id: r.id,
    deviceId: r.device_id,
    projectId: r.project_id,
    status: r.status,
    cols: r.cols,
    rows: r.rows,
    closed: ['closed', 'error', 'interrupted'].includes(r.status),
    exitCode: r.exit_code,
    error: r.error,
    createdAt: r.created_at,
  });
  function scoped(id, owner) {
    const r = get(id);
    if (!r || r.owner !== owner) throw fail(404, '电脑终端不存在。');
    ownedDevice(r.device_id, owner);
    return r;
  }
  function permission(r) {
    const p = project(r.device_id, r.project_id);
    if (!p.allow_execute) throw fail(403, '目标电脑未授权执行命令。');
  }
  function queue(r, id, op) {
    const input = JSON.stringify(op),
      old = db.prepare('SELECT * FROM relay_operations WHERE id=?').get(id);
    if (old) {
      if (
        old.owner !== r.owner ||
        old.device_id !== r.device_id ||
        old.project_id !== r.project_id ||
        old.input !== input
      )
        throw fail(409, '终端请求编号已用于其他内容。');
      return;
    }
    if (
      db
        .prepare("SELECT COUNT(*) AS n FROM relay_operations WHERE status IN ('queued','running')")
        .get().n >= 512
    )
      throw fail(429, '电脑请求队列已满。');
    const at = new Date(now()).toISOString();
    db.prepare(
      "INSERT INTO relay_operations(id,owner,device_id,project_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
    ).run(id, r.owner, r.device_id, r.project_id, input, at, at);
  }
  function revoke(device, pid) {
    db.prepare(
      "UPDATE relay_terminals SET status='closed',error='本机授权已撤销。',updated_at=? WHERE device_id=? AND status IN ('opening','open','closing')" +
        (pid ? ' AND project_id=?' : ''),
    ).run(
      ...(pid
        ? [new Date(now()).toISOString(), device, pid]
        : [new Date(now()).toISOString(), device]),
    );
  }
  function sweep() {
    db.prepare(
      "UPDATE relay_terminals SET status='interrupted',error='终端已失联或启动超时，未自动重开。' WHERE status IN ('opening','open','closing') AND last_seen<=?",
    ).run(now() - 45000);
    db.prepare(
      `UPDATE relay_operations SET status='cancelled',error='终端请求已过期或会话已关闭，未重复执行。'
      WHERE status='queued' AND json_extract(input,'$.kind') LIKE 'terminal_%' AND (
        (json_extract(input,'$.kind')='terminal_input' AND CAST(strftime('%s',created_at) AS INTEGER)*1000<?) OR
        (json_extract(input,'$.kind') NOT IN ('terminal_close') AND json_extract(input,'$.sessionId') IN (SELECT id FROM relay_terminals WHERE status IN ('closed','error','interrupted'))))`,
    ).run(now() - 10000);
  }
  return {
    revoke,
    sweep,
    operationResult(op, result) {
      const input = JSON.parse(op.input);
      if (input.kind === 'terminal_open' && result.status === 'error')
        db.prepare(
          "UPDATE relay_terminals SET status='error',error=? WHERE id=? AND status='opening'",
        ).run(result.error || '本机终端未能启动。', input.sessionId);
    },
    async before(req, url, json, d) {
      if (url.pathname !== '/api/relay/device/workspace/terminals/sync' || req.method !== 'POST')
        return false;
      limit('computer-terminal-sync:' + d.id, 600);
      sweep();
      const p = z
        .object({
          sessions: z
            .array(
              z
                .object({
                  id: uuid,
                  closed: z.boolean(),
                  exitCode: z.number().int().nullable(),
                  reset: z.boolean().optional(),
                  chunks: z
                    .array(
                      z
                        .object({
                          seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
                          data: z.string().max(65536),
                        })
                        .strict(),
                    )
                    .max(128),
                })
                .strict(),
            )
            .max(24),
        })
        .strict()
        .parse(await body(req));
      if (JSON.stringify(p).length > 800000) throw fail(413, '终端输出批次过大。');
      const close = [],
        acks = {};
      for (const s of p.sessions) {
        const r = get(s.id);
        if (!r || r.device_id !== d.id) {
          close.push(s.id);
          continue;
        }
        try {
          permission(r);
        } catch {
          revoke(d.id, r.project_id);
          close.push(s.id);
          continue;
        }
        if (['closed', 'error', 'interrupted', 'closing'].includes(r.status)) {
          close.push(s.id);
          if (s.closed && r.status === 'closing')
            db.prepare("UPDATE relay_terminals SET status='closed',exit_code=? WHERE id=?").run(
              s.exitCode,
              s.id,
            );
          acks[s.id] = r.seq;
          continue;
        }
        const gap = s.reset && s.chunks.length && s.chunks[0].seq > r.seq + 1;
        let chunks = gap ? [] : JSON.parse(r.chunks),
          seq = gap ? s.chunks[0].seq - 1 : r.seq;
        for (const c of s.chunks) {
          if (c.seq <= seq) continue;
          if (c.seq !== seq + 1) throw fail(409, '终端输出游标不连续。');
          chunks.push(c);
          seq = c.seq;
        }
        let bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.data), 0);
        while (bytes > 524288 && chunks.length > 1) bytes -= Buffer.byteLength(chunks.shift().data);
        db.prepare(
          'UPDATE relay_terminals SET chunks=?,seq=?,status=?,exit_code=?,last_seen=?,updated_at=? WHERE id=?',
        ).run(
          JSON.stringify(chunks),
          seq,
          s.closed ? 'closed' : 'open',
          s.exitCode,
          now(),
          new Date(now()).toISOString(),
          s.id,
        );
        acks[s.id] = seq;
      }
      const present = new Set(p.sessions.map((s) => s.id));
      for (const r of db
        .prepare("SELECT id FROM relay_terminals WHERE device_id=? AND status='open'")
        .all(d.id))
        if (!present.has(r.id))
          db.prepare(
            "UPDATE relay_terminals SET status='interrupted',error='本机终端已结束或执行器重启，未自动重开。' WHERE id=?",
          ).run(r.id);
      db.prepare('UPDATE relay_devices SET last_seen=? WHERE id=?').run(now(), d.id);
      json(200, { close, acks });
      return true;
    },
    async after(req, url, json, actor) {
      const path = url.pathname;
      if (path === '/api/relay/terminals') {
        if (req.method === 'GET') {
          const device = uuid.parse(url.searchParams.get('deviceId')),
            pid = uuid.parse(url.searchParams.get('projectId'));
          ownedDevice(device, actor.id);
          project(device, pid);
          sweep();
          json(200, {
            sessions: db
              .prepare(
                'SELECT * FROM relay_terminals WHERE owner=? AND device_id=? AND project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100',
              )
              .all(actor.id, device, pid)
              .map(view),
          });
          return true;
        }
        if (req.method === 'POST') {
          limit('computer-terminal-open:' + actor.id, 30);
          const p = z
            .object({ id: uuid, deviceId: uuid, projectId: uuid, ...dimension })
            .strict()
            .parse(await body(req));
          const d = ownedDevice(p.deviceId, actor.id),
            r = { id: p.id, owner: actor.id, device_id: p.deviceId, project_id: p.projectId };
          permission(r);
          if (now() - d.last_seen > 15000) throw fail(409, '目标电脑离线，未排队启动终端。');
          const old = get(p.id),
            signature = JSON.stringify(p);
          if (old) {
            if (old.owner !== actor.id || old.submission !== signature)
              throw fail(409, '终端编号已用于其他会话。');
            json(200, { session: view(old) });
            return true;
          }
          if (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM relay_terminals WHERE device_id=? AND status IN ('opening','open','closing')",
              )
              .get(d.id).n >= 12
          )
            throw fail(429, '此电脑的终端已满，请先关闭不再使用的终端。');
          const at = new Date(now()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(
              "INSERT INTO relay_terminals(id,owner,device_id,project_id,status,cols,rows,last_seen,submission,created_at,updated_at) VALUES(?,?,?,?,'opening',?,?,?,?,?,?)",
            ).run(p.id, actor.id, d.id, p.projectId, p.cols, p.rows, now(), signature, at, at);
            queue(r, p.id, {
              kind: 'terminal_open',
              sessionId: p.id,
              cols: p.cols,
              rows: p.rows,
              issuedAt: now(),
            });
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          json(202, { session: view(get(p.id)) });
          return true;
        }
      }
      const match = path.match(/^\/api\/relay\/terminals\/([^/]+)(?:\/(input|resize|close))?$/);
      if (!match) return false;
      sweep();
      const r = scoped(uuid.parse(match[1]), actor.id);
      if (!match[2] && req.method === 'GET') {
        const after = z.coerce
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .parse(url.searchParams.get('after') || 0),
          chunks = JSON.parse(r.chunks);
        const inputReceipts = db
          .prepare(
            "SELECT id,status,error FROM relay_operations WHERE device_id=? AND json_extract(input,'$.sessionId')=? AND json_extract(input,'$.kind')='terminal_input' ORDER BY created_at DESC,rowid DESC LIMIT 64",
          )
          .all(r.device_id, r.id);
        json(200, {
          ...view(r),
          chunks: chunks.filter((c) => c.seq > after),
          cursor: r.seq,
          reset: !!chunks.length && after < chunks[0].seq - 1,
          inputReceipts,
        });
        return true;
      }
      if (req.method !== 'POST') return false;
      permission(r);
      limit('computer-terminal-input:' + actor.id, 1200);
      const schema =
        match[2] === 'input'
          ? z.object({ id: uuid, data: z.string().min(1).max(16384) }).strict()
          : match[2] === 'resize'
            ? z.object({ id: uuid, ...dimension }).strict()
            : z.object({ id: uuid }).strict();
      const p = schema.parse(await body(req));
      const old = db.prepare('SELECT * FROM relay_operations WHERE id=?').get(p.id);
      if (old) {
        const previous = JSON.parse(old.input);
        if (
          old.owner !== actor.id ||
          old.device_id !== r.device_id ||
          old.project_id !== r.project_id ||
          previous.sessionId !== r.id ||
          previous.kind !== 'terminal_' + match[2] ||
          ('data' in p && previous.data !== p.data) ||
          ('cols' in p && (previous.cols !== p.cols || previous.rows !== p.rows))
        )
          throw fail(409, '终端请求编号已用于其他内容。');
        json(200, { operationId: p.id, status: old.status });
        return true;
      }
      if (match[2] !== 'close' && (r.status !== 'open' || now() - r.last_seen > 15000))
        throw fail(409, '终端未就绪或已失联，输入未发送。');
      queue(r, p.id, {
        kind: 'terminal_' + match[2],
        sessionId: r.id,
        ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'id')),
        issuedAt: now(),
      });
      if (match[2] === 'close')
        db.prepare(
          "UPDATE relay_terminals SET status='closing' WHERE id=? AND status IN ('opening','open')",
        ).run(r.id);
      if (match[2] === 'resize')
        db.prepare('UPDATE relay_terminals SET cols=?,rows=? WHERE id=?').run(p.cols, p.rows, r.id);
      json(202, { operationId: p.id });
      return true;
    },
  };
}
