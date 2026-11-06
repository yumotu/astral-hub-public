import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotifications, pushSubscriptionSchema } from '../server/notifications.mjs';
const owner = randomUUID(),
  other = randomUUID(),
  conversationId = randomUUID();
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-only',
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
};
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'astral-notifications-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions(hash TEXT PRIMARY KEY, expires INTEGER);');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('session-a', Date.now() + 86400000);
  const notices = await createNotifications(db, { root, start: false, ...options });
  t.after(async () => {
    notices.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, notices, root };
}
test('notifications persist, deduplicate per owner and only mark that owner records read', async (t) => {
  const { notices } = await fixture(t);
  const first = notices.publish(
    owner,
    { kind: 'plugin', title: '测试', body: '正文', conversationId },
    'call-1',
  );
  assert.equal(
    notices.publish(owner, { kind: 'plugin', title: '重复', body: '', conversationId }, 'call-1')
      .id,
    first.id,
  );
  assert.equal(notices.inbox(owner).notifications.length, 1);
  assert.equal(notices.inbox(other).notifications.length, 0);
  assert.equal(notices.inbox(owner).unread, 1);
  assert.throws(() => notices.read(other, first.id), { status: 404 });
  notices.read(owner, first.id);
  assert.equal(notices.inbox(owner).unread, 0);
  assert.equal(notices.since(owner, 0).notifications[0].id, first.id);
});
test('bulk read acknowledges only the observed owner cursor and preserves newer notifications', async (t) => {
  const { notices } = await fixture(t);
  for (let i = 0; i < 55; i++)
    notices.publish(owner, { kind: 'plugin', title: '旧通知', body: '' }, 'bulk-' + i);
  const cursor = notices.inbox(owner).cursor;
  notices.publish(owner, { kind: 'plugin', title: '刚到的新通知', body: '' }, 'new-after-cursor');
  notices.publish(other, { kind: 'plugin', title: '另一账号', body: '' }, 'other-bulk');
  assert.equal(notices.readAll(owner, cursor).read, 55);
  assert.equal(notices.inbox(owner).unread, 1);
  assert.equal(notices.inbox(other).unread, 1);
  assert.equal(notices.readAll(owner, cursor).read, 0);
  assert.throws(() => notices.readAll(owner, -1));
});
test('task completion and input prompts become notifications; supplements and notify commands do not duplicate', async (t) => {
  const { notices } = await fixture(t);
  const task = { id: randomUUID(), conversationId, input: 'work', status: 'running' };
  notices.task(owner, task, {
    type: 'extension_ui_request',
    id: 'prompt-1',
    method: 'confirm',
    title: '确认操作',
  });
  notices.task(owner, task, {
    type: 'extension_ui_request',
    id: 'prompt-1',
    method: 'confirm',
    title: '确认操作',
  });
  notices.task(owner, { ...task, status: 'done' }, { type: 'task' });
  notices.task(owner, { ...task, status: 'done' }, { type: 'task' });
  notices.task(
    owner,
    { ...task, id: randomUUID(), parentId: task.id, status: 'done' },
    { type: 'task' },
  );
  notices.task(
    owner,
    { ...task, id: randomUUID(), input: '/notify test', status: 'done' },
    { type: 'task' },
  );
  assert.deepEqual(
    notices
      .inbox(owner)
      .notifications.map((n) => n.kind)
      .sort(),
    ['completed', 'input'],
  );
  notices.setPolicy(owner, conversationId, false);
  notices.task(owner, { ...task, id: randomUUID(), status: 'error' }, { type: 'task' });
  assert.equal(notices.inbox(owner).notifications.length, 2);
  notices.setPolicy(owner, conversationId, true);
  notices.task(owner, { ...task, id: randomUUID(), status: 'error' }, { type: 'task' });
  assert.equal(notices.inbox(owner).notifications.length, 3);
});
test('Web Push rejects internal destinations and malformed keys before any outbound request', () => {
  assert.equal(pushSubscriptionSchema.safeParse(subscription).success, true);
  for (const endpoint of [
    'http://fcm.googleapis.com/send',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://fcm.googleapis.com.evil.test/',
    'https://example.com/',
    'https://user@fcm.googleapis.com/',
    'https://fcm.googleapis.com:444/',
  ])
    assert.equal(
      pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success,
      false,
      endpoint,
    );
  assert.equal(
    pushSubscriptionSchema.safeParse({ ...subscription, keys: { p256dh: 'oops', auth: 'oops' } })
      .success,
    false,
  );
});
test('durable push retry uses the same notification, hides previews and stops after session logout', async (t) => {
  const sent = [];
  let fail = true;
  const { notices, db } = await fixture(t, {
    sendPush: async (sub, payload) => {
      sent.push(JSON.parse(payload));
      if (fail) throw Object.assign(Error('private transport details'), { statusCode: 503 });
    },
  });
  const deviceId = randomUUID();
  notices.device(owner, 'session-a', {
    id: deviceId,
    platform: 'web',
    enabled: true,
    preview: false,
    subscription,
  });
  notices.publish(
    owner,
    { kind: 'completed', title: 'private project name', body: 'private result', conversationId },
    'one',
  );
  await notices.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '星屿');
  assert.doesNotMatch(JSON.stringify(sent[0]), /private/);
  assert.equal(notices.devices(owner)[0].delivery, 'retrying');
  db.prepare('UPDATE notification_outbox SET next_at=0').run();
  fail = false;
  await notices.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].id, sent[1].id);
  assert.equal(notices.devices(owner)[0].delivery, 'sent');
  db.prepare('DELETE FROM sessions').run();
  notices.publish(owner, { kind: 'completed', title: '结束', body: '', conversationId }, 'two');
  await notices.flush();
  assert.equal(sent.length, 2);
});
test('expired subscriptions are disabled and live-only devices never enqueue a push', async (t) => {
  const { notices } = await fixture(t, {
    sendPush: async () => {
      throw Object.assign(Error('gone'), { statusCode: 410 });
    },
  });
  notices.device(owner, 'session-a', {
    id: randomUUID(),
    platform: 'android',
    enabled: true,
    preview: false,
  });
  notices.device(owner, 'session-a', {
    id: randomUUID(),
    platform: 'web',
    enabled: true,
    preview: false,
    subscription,
  });
  notices.publish(owner, { kind: 'test', title: '测试', body: '' }, 'test');
  await notices.flush();
  assert.equal(notices.devices(owner).find((d) => d.platform === 'web').enabled, false);
  assert.equal(notices.inbox(owner).unread, 1);
});
