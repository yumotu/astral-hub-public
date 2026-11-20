import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import webpush from 'web-push';
import { fail } from './accounts.mjs';
import { notificationPayload } from '../shared/notifications.mjs';
import { notificationTargetSchema } from '../shared/notification-target.mjs';

const uuid = z.string().uuid();
const safeText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' '));
export const noticeSchema = z
  .object({
    kind: z.enum(['completed', 'error', 'input', 'plugin', 'test', 'mail', 'contact', 'friend']),
    title: safeText(120).pipe(z.string().min(1)),
    body: safeText(1200),
    conversationId: uuid.nullable().optional(),
    taskId: uuid.nullable().optional(),
    target: notificationTargetSchema.optional(),
  })
  .strict();
const pushEndpoint = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const u = new URL(value),
      h = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      ([
        'fcm.googleapis.com',
        'android.googleapis.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
      ].includes(h) ||
        h.endsWith('.notify.windows.com'))
    );
  }, '推送地址必须属于浏览器的官方推送服务。');
const key = (bytes) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/)
    .max(200)
    .refine((s) => Buffer.from(s, 'base64url').length === bytes, '推送密钥长度不正确。');
export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpoint,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: key(65), auth: key(16) }).strict(),
  })
  .strict();
export const notificationDeviceSchema = z
  .object({
    id: uuid,
    platform: z.enum(['web', 'desktop', 'android']),
    enabled: z.boolean(),
    preview: z.boolean().default(false),
    subscription: pushSubscriptionSchema.optional(),
  })
  .strict();
export async function createNotifications(db, { root, start = true, sendPush } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const keyPath = join(root, 'web-push.json');
  let vapid;
  try {
    vapid = JSON.parse(await readFile(keyPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    vapid = webpush.generateVAPIDKeys();
    await writeFile(keyPath, JSON.stringify(vapid), { mode: 0o600, flag: 'wx' });
  }
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(vapid.publicKey || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(vapid.privateKey || '')
  )
    throw new Error('通知签名配置无效。');
  const deliver =
    sendPush ||
    ((sub, payload) =>
      webpush.sendNotification(sub, payload, {
        vapidDetails: {
          subject: process.env.WEB_PUSH_SUBJECT || 'https://astral.example',
          ...vapid,
        },
        TTL: 86400,
        timeout: 10000,
        urgency: 'normal',
      }));
  db.exec(`CREATE TABLE IF NOT EXISTS app_notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,id TEXT NOT NULL,dedupe TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,
    read_at TEXT,UNIQUE(owner,id),UNIQUE(owner,dedupe));
    CREATE INDEX IF NOT EXISTS app_notices_owner ON app_notifications(owner,seq);
    CREATE TABLE IF NOT EXISTS notification_devices(owner TEXT NOT NULL,id TEXT NOT NULL,
    session_hash TEXT NOT NULL,platform TEXT NOT NULL,enabled INTEGER NOT NULL,preview INTEGER NOT NULL,
    subscription TEXT,endpoint_hash TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner,id));
    CREATE UNIQUE INDEX IF NOT EXISTS notification_endpoint ON notification_devices(endpoint_hash) WHERE endpoint_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS notification_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,notice_id TEXT NOT NULL,device_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',
    UNIQUE(owner,notice_id,device_id));
    CREATE TABLE IF NOT EXISTS notification_policy(owner TEXT NOT NULL,conversation_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,PRIMARY KEY(owner,conversation_id));`);
  db.prepare("UPDATE notification_outbox SET state='pending' WHERE state='sending'").run();
  const events = new EventEmitter();
  events.setMaxListeners(200);
  let closed = false,
    busy = false;
  const rates = new Map();
  function limit(key, max) {
    const now = Date.now(),
      old = rates.get(key);
    if (old && old.until > now) {
      if (old.n >= max) throw fail(429, '通知请求过于频繁，请稍后重试。');
      old.n++;
    } else rates.set(key, { n: 1, until: now + 60000 });
    if (rates.size > 4000) for (const [k, v] of rates) if (v.until <= now) rates.delete(k);
  }
  const decode = (r) => ({
    ...JSON.parse(r.payload),
    id: r.id,
    seq: r.seq,
    createdAt: r.created_at,
    readAt: r.read_at,
  });
  const enabled = (owner, conversation) =>
    db
      .prepare('SELECT enabled FROM notification_policy WHERE owner=? AND conversation_id=?')
      .get(owner, conversation)?.enabled !== 0;
  async function flush() {
    if (closed || busy) return;
    busy = true;
    try {
      const rows = db
        .prepare(
          "SELECT * FROM notification_outbox WHERE state='pending' AND next_at<=? ORDER BY seq LIMIT 10",
        )
        .all(Date.now());
      for (const row of rows) {
        if (closed) break;
        const device = db
          .prepare(
            'SELECT d.* FROM notification_devices d JOIN sessions s ON s.hash=d.session_hash WHERE d.owner=? AND d.id=? AND d.enabled=1 AND s.expires>?',
          )
          .get(row.owner, row.device_id, Date.now());
        const notice = db
          .prepare('SELECT * FROM app_notifications WHERE owner=? AND id=?')
          .get(row.owner, row.notice_id);
        if (!device?.subscription || !notice) {
          db.prepare("UPDATE notification_outbox SET state='inactive' WHERE seq=?").run(row.seq);
          continue;
        }
        db.prepare(
          "UPDATE notification_outbox SET state='sending',attempts=attempts+1 WHERE seq=?",
        ).run(row.seq);
        try {
          await deliver(
            JSON.parse(device.subscription),
            JSON.stringify(notificationPayload(decode(notice), row.owner, !!device.preview)),
          );
          if (!closed)
            db.prepare("UPDATE notification_outbox SET state='sent',error='' WHERE seq=?").run(
              row.seq,
            );
        } catch (e) {
          if (closed) break;
          const gone = [404, 410].includes(e.statusCode),
            exhausted = row.attempts >= 4;
          if (gone)
            db.prepare('UPDATE notification_devices SET enabled=0 WHERE owner=? AND id=?').run(
              row.owner,
              row.device_id,
            );
          db.prepare('UPDATE notification_outbox SET state=?,next_at=?,error=? WHERE seq=?').run(
            gone ? 'expired' : exhausted ? 'failed' : 'pending',
            Date.now() + Math.min(300000, 5000 * 2 ** row.attempts),
            gone ? '推送订阅已失效，请重新启用。' : '推送服务暂不可达，通知仍保存在通知中心。',
            row.seq,
          );
        }
      }
    } finally {
      busy = false;
    }
  }
  const timer = start ? setInterval(() => void flush().catch(() => {}), 2000) : null;
  timer?.unref();
  const service = {
    publicKey: vapid.publicKey,
    publish(owner, raw, dedupe = randomUUID()) {
      const p = noticeSchema.parse(raw);
      const old = db
        .prepare('SELECT * FROM app_notifications WHERE owner=? AND dedupe=?')
        .get(owner, dedupe);
      if (old) return decode(old);
      const id = randomUUID(),
        createdAt = new Date().toISOString();
      db.exec('SAVEPOINT publish_notice');
      try {
        db.prepare(
          'INSERT INTO app_notifications(owner,id,dedupe,payload,created_at) VALUES(?,?,?,?,?)',
        ).run(owner, id, dedupe, JSON.stringify(p), createdAt);
        const devices = db
          .prepare(
            'SELECT d.id FROM notification_devices d JOIN sessions s ON s.hash=d.session_hash WHERE d.owner=? AND d.enabled=1 AND d.subscription IS NOT NULL AND s.expires>?',
          )
          .all(owner, Date.now());
        for (const d of devices)
          db.prepare(
            'INSERT OR IGNORE INTO notification_outbox(owner,notice_id,device_id) VALUES(?,?,?)',
          ).run(owner, id, d.id);
        db.exec('RELEASE publish_notice');
      } catch (e) {
        db.exec('ROLLBACK TO publish_notice; RELEASE publish_notice');
        throw e;
      }
      events.emit(owner);
      return decode(
        db.prepare('SELECT * FROM app_notifications WHERE owner=? AND id=?').get(owner, id),
      );
    },
    task(owner, task, event) {
      if (task.parentId) return;
      if (event.type === 'notification_policy') {
        service.setPolicy(owner, task.conversationId, event.enabled === true);
        return;
      }
      if (!enabled(owner, task.conversationId)) return;
      const link = { conversationId: task.conversationId, taskId: task.id };
      if (event.type === 'notification') {
        const p = noticeSchema.parse({
          kind: 'plugin',
          title: event.title,
          body: event.body,
          ...link,
        });
        service.publish(owner, p, `${task.id}:plugin:${uuid.parse(event.id)}`);
      } else if (event.type === 'extension_ui_request')
        service.publish(
          owner,
          {
            kind: 'input',
            title: 'Pi 需要你的回复',
            body: String(event.title || '请返回对话处理插件请求。').slice(0, 1200),
            ...link,
          },
          `${task.id}:input:${event.id}`,
        );
      else if (event.type === 'task' && !/^\/notify(?:\s|$)/.test(task.input || '')) {
        const kind = ['error', 'interrupted'].includes(task.status) ? 'error' : null;
        if (kind)
          service.publish(
            owner,
            {
              kind,
              title: 'Pi 任务需要检查',
              body: '执行未正常完成，请打开对话检查记录。',
              ...link,
            },
            `${task.id}:${kind}`,
          );
      }
    },
    setPolicy(owner, id, value) {
      db.prepare(
        'INSERT INTO notification_policy VALUES(?,?,?) ON CONFLICT(owner,conversation_id) DO UPDATE SET enabled=excluded.enabled',
      ).run(owner, id, Number(value));
    },
    inbox(owner) {
      return {
        notifications: db
          .prepare('SELECT * FROM app_notifications WHERE owner=? ORDER BY seq DESC LIMIT 50')
          .all(owner)
          .map(decode),
        cursor: db
          .prepare('SELECT COALESCE(MAX(seq),0) n FROM app_notifications WHERE owner=?')
          .get(owner).n,
        unread: db
          .prepare('SELECT count(*) n FROM app_notifications WHERE owner=? AND read_at IS NULL')
          .get(owner).n,
      };
    },
    since(owner, after) {
      const rows = db
        .prepare('SELECT * FROM app_notifications WHERE owner=? AND seq>? ORDER BY seq LIMIT 100')
        .all(owner, after);
      return { notifications: rows.map(decode), cursor: rows.at(-1)?.seq ?? after };
    },
    async changes(owner, after, res) {
      if (events.listenerCount(owner) >= 24) throw fail(429, '通知连接过多，请关闭重复页面。');
      let result = service.since(owner, after);
      if (!result.notifications.length && !res.destroyed)
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timeout);
            events.off(owner, done);
            res.off('close', done);
            resolve();
          };
          const timeout = setTimeout(done, 20000);
          events.once(owner, done);
          res.once('close', done);
        });
      return closed ? { notifications: [], cursor: after } : service.since(owner, after);
    },
    read(owner, id) {
      const result = db
        .prepare('UPDATE app_notifications SET read_at=COALESCE(read_at,?) WHERE owner=? AND id=?')
        .run(new Date().toISOString(), owner, id);
      if (!result.changes) throw fail(404, '通知不存在。');
      events.emit(owner);
    },
    readAll(owner, through) {
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(through);
      const result = db
        .prepare(
          'UPDATE app_notifications SET read_at=? WHERE owner=? AND seq<=? AND read_at IS NULL',
        )
        .run(new Date().toISOString(), owner, through);
      if (result.changes) events.emit(owner);
      return { read: result.changes };
    },
    device(owner, sessionHash, raw) {
      const p = notificationDeviceSchema.parse(raw);
      const existing = db
        .prepare('SELECT count(*) n FROM notification_devices WHERE owner=? AND id<>?')
        .get(owner, p.id).n;
      if (existing >= 20) throw fail(429, '最多启用 20 台通知设备。');
      const hash = p.subscription
        ? createHash('sha256').update(p.subscription.endpoint).digest('hex')
        : null;
      db.exec('SAVEPOINT notification_device');
      try {
        if (hash)
          db.prepare(
            'DELETE FROM notification_devices WHERE endpoint_hash=? AND NOT(owner=? AND id=?)',
          ).run(hash, owner, p.id);
        db.prepare(
          'INSERT INTO notification_devices VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET session_hash=excluded.session_hash,platform=excluded.platform,enabled=excluded.enabled,preview=excluded.preview,subscription=excluded.subscription,endpoint_hash=excluded.endpoint_hash,updated_at=excluded.updated_at',
        ).run(
          owner,
          p.id,
          sessionHash,
          p.platform,
          Number(p.enabled),
          Number(p.preview),
          p.subscription ? JSON.stringify(p.subscription) : null,
          hash,
          new Date().toISOString(),
        );
        db.exec('RELEASE notification_device');
      } catch (e) {
        db.exec('ROLLBACK TO notification_device; RELEASE notification_device');
        throw e;
      }
    },
    devices(owner) {
      return db
        .prepare(
          'SELECT id,platform,enabled,preview,subscription IS NOT NULL AS remote,updated_at FROM notification_devices WHERE owner=?',
        )
        .all(owner)
        .map((d) => {
          const latest = db
            .prepare(
              'SELECT state,error FROM notification_outbox WHERE owner=? AND device_id=? ORDER BY seq DESC LIMIT 1',
            )
            .get(owner, d.id);
          return {
            ...d,
            enabled: !!d.enabled,
            preview: !!d.preview,
            remote: !!d.remote,
            delivery: latest?.state === 'pending' ? 'retrying' : latest?.state || null,
            error: latest?.error || '',
          };
        });
    },
    async handle(req, url, json, actor, body, res) {
      const path = url.pathname;
      if (!path.startsWith('/api/notifications')) return false;
      if (!actor?.id) throw fail(401, '请先登录独立账号。');
      const owner = actor.id;
      limit('all:' + owner, 180);
      if (req.method === 'POST') limit('write:' + owner, 30);
      if (path === '/api/notifications/test') limit('test:' + owner, 6);
      if (path === '/api/notifications' && req.method === 'GET') {
        json(200, service.inbox(owner));
        return true;
      }
      if (path === '/api/notifications/status' && req.method === 'GET') {
        json(200, {
          scope: owner,
          webPush: true,
          androidRemotePush: false,
          publicKey: vapid.publicKey,
          devices: service.devices(owner),
        });
        return true;
      }
      if (path === '/api/notifications/read-all' && req.method === 'POST') {
        const p = z
          .object({ through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
          .strict()
          .parse(await body(req));
        json(200, { ...service.readAll(owner, p.through), ...service.inbox(owner) });
        return true;
      }
      if (path === '/api/notifications/updates' && req.method === 'GET') {
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(url.searchParams.get('after') || 0);
        const value = await service.changes(owner, after, res);
        if (!res.destroyed) json(200, value);
        return true;
      }
      if (path === '/api/notifications/devices' && req.method === 'POST') {
        service.device(owner, actor.sessionHash, await body(req));
        json(200, { ok: true });
        return true;
      }
      const read = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
      const single = path.match(/^\/api\/notifications\/([^/]+)$/);
      if (single && req.method === 'GET') {
        const n = db
          .prepare('SELECT * FROM app_notifications WHERE owner=? AND id=?')
          .get(owner, uuid.parse(single[1]));
        if (!n) throw fail(404, '通知不存在。');
        json(200, { notification: decode(n) });
        return true;
      }
      if (read && req.method === 'POST') {
        service.read(owner, uuid.parse(read[1]));
        json(200, { ok: true });
        return true;
      }
      if (path === '/api/notifications/test' && req.method === 'POST') {
        const p = z
          .object({ id: uuid })
          .strict()
          .parse(await body(req));
        json(201, {
          notification: service.publish(
            owner,
            { kind: 'test', title: '星屿通知测试', body: '通知接口已连通。' },
            'test:' + p.id,
          ),
        });
        return true;
      }
      throw fail(404, '通知接口不存在。');
    },
    flush,
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const name of events.eventNames()) events.emit(name);
      events.removeAllListeners();
    },
  };
  return service;
}
