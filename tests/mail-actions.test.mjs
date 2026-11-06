import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';

const token = 'mail-actions-fixture-private-12345678901234567890';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-mail-actions-'));
  const state = {
    validity: 7n,
    time: Date.now(),
    searches: [],
    changes: [],
    crash: false,
    boxes: [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
      { path: 'Work', name: 'Work' },
    ],
    messages: new Map([
      [
        'INBOX',
        new Map([
          [101, false],
          [102, true],
        ]),
      ],
      ['Trash', new Map()],
      ['Work', new Map()],
    ]),
  };
  const app = await createApp({
    token,
    dataDir: dir,
    notifications: { start: false },
    mail: {
      now: () => state.time,
      imapFactory: () => {
        let selected = 'INBOX';
        return {
          async connect() {},
          async logout() {},
          get mailbox() {
            return { uidValidity: state.validity };
          },
          async list() {
            return state.boxes;
          },
          async getMailboxLock(name) {
            selected = name;
            return { release() {} };
          },
          async search(query) {
            state.searches.push(query);
            return [...(state.messages.get(selected) || [])]
              .filter(([, seen]) => query.seen !== false || !seen)
              .map(([id]) => id);
          },
          async fetchAll(ids) {
            const rows = ids
              .filter((id) => state.messages.get(selected)?.has(id))
              .map((uid) => ({
                uid,
                envelope: {
                  subject: 'synthetic mail ' + uid,
                  from: [{ address: 'sender@example.com' }],
                },
                flags: new Set(state.messages.get(selected).get(uid) ? ['\\Seen'] : []),
              }));
            const gate = state.fetchGate;
            state.fetchGate = null;
            if (gate) {
              gate.entered();
              await gate.promise;
            }
            return rows;
          },
          async messageFlagsAdd(ids, flags, opts) {
            state.changes.push({ action: 'read', ids, flags, opts });
            for (const id of ids) state.messages.get(selected).set(id, true);
            if (state.crash) throw Error('disconnected');
            return true;
          },
          async messageFlagsRemove(ids, flags, opts) {
            state.changes.push({ action: 'unread', ids, flags, opts });
            for (const id of ids) state.messages.get(selected).set(id, false);
            return true;
          },
          async messageMove(ids, destination, opts) {
            state.changes.push({ action: 'move', ids, destination, opts });
            for (const id of ids) {
              state.messages.get(destination).set(id + 1000, state.messages.get(selected).get(id));
              state.messages.get(selected).delete(id);
            }
            if (state.crash || state.failDestination === destination) throw Error('disconnected');
            return { uidMap: new Map(ids.map((id) => [id, id + 1000])) };
          },
          async mailboxCreate(name) {
            state.changes.push({ action: 'create', name });
            state.boxes.push({ path: name, name });
            state.messages.set(name, new Map());
            return { path: name, created: true };
          },
          async mailboxRename(name, newName) {
            state.changes.push({ action: 'rename', name, newName });
            state.boxes.find((b) => b.path === name).path = newName;
            state.messages.set(newName, state.messages.get(name));
            state.messages.delete(name);
            return { path: name, newPath: newName };
          },
        };
      },
    },
    ...options,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function request(path, data, auth = token, method) {
    const r = await fetch(url + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        Authorization: 'Bearer ' + auth,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  await request('/mail/account', {
    provider: 'qq',
    address: 'qa@qq.com',
    appPassword: 'synthetic-password',
  });
  const prepare = async (operation) => {
    const r = await request('/mail/actions/prepare', operation);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const confirm = (p, auth) =>
    request('/mail/actions/' + p.id + '/confirm', { confirm: true }, auth);
  return { app, state, request, prepare, confirm };
}

test('agent classification previews precise groups once, then creates folders and moves real messages idempotently', async (t) => {
  const { state, prepare, confirm } = await fixture(t);
  const operation = {
    action: 'organize',
    mailbox: 'INBOX',
    groups: [
      { destination: 'Work', uids: [101] },
      { destination: '学习', create: true, uids: [102] },
    ],
  };
  const preview = await prepare(operation);
  assert.equal(preview.groups.length, 2);
  assert.equal(preview.messages.length, 2);
  assert.equal(state.changes.length, 0);
  const done = await confirm(preview);
  assert.equal(done.status, 200);
  assert.equal(done.body.state, 'done');
  assert.equal(done.body.result.groups.filter((g) => g.state === 'done').length, 2);
  assert.equal(state.messages.get('Work').size, 1);
  assert.equal(state.messages.get('学习').size, 1);
  assert.equal(state.messages.get('INBOX').size, 0);
  const count = state.changes.length;
  assert.equal((await confirm(preview)).body.state, 'done');
  assert.equal(state.changes.length, count);
});

test('flag mutations keep long-term body caches and invalidate list caches', async (t) => {
  const { app, request, prepare, confirm } = await fixture(t);
  await request('/mail/messages');
  const row = app.store.db.prepare('SELECT owner,revision FROM mail_cache LIMIT 1').get();
  const key = JSON.stringify(['body-rich-v1', 'INBOX', 101]);
  app.store.db
    .prepare('INSERT INTO mail_cache VALUES(?,?,?,?,?,?,?)')
    .run(
      row.owner,
      key,
      row.revision,
      'INBOX',
      'synthetic-cache-only',
      Date.now() + 86400000,
      Date.now(),
    );
  const prepared = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  assert.equal((await confirm(prepared)).status, 200);
  assert.ok(app.store.db.prepare('SELECT 1 FROM mail_cache WHERE cache_key=?').get(key));
  assert.equal(
    app.store.db.prepare("SELECT count(*) AS n FROM mail_cache WHERE cache_key LIKE '%list%'").get()
      .n,
    0,
  );
});

test('classification rejects duplicated assignments and stale identities before side effects; partial moves are not replayed', async (t) => {
  const { state, request, prepare, confirm } = await fixture(t);
  const op = {
    action: 'organize',
    mailbox: 'INBOX',
    groups: [
      { destination: 'Work', uids: [101] },
      { destination: '学习', create: true, uids: [102] },
    ],
  };
  const duplicate = structuredClone(op);
  duplicate.groups[1].uids = [101];
  assert.equal((await request('/mail/actions/prepare', duplicate)).status, 400);
  const stale = await prepare(op);
  state.validity = 8n;
  assert.equal((await confirm(stale)).status, 409);
  assert.equal(state.changes.length, 0);
  const preview = await prepare(op);
  state.failDestination = '学习';
  assert.equal((await confirm(preview)).status, 502);
  const status = (await request('/mail/actions/' + preview.id)).body;
  assert.equal(status.state, 'unknown');
  assert.equal(status.result.groups[0].state, 'done');
  assert.equal(status.result.groups[1].state, 'unknown');
  const changes = state.changes.length;
  assert.equal((await confirm(preview)).status, 409);
  assert.equal(state.changes.length, changes);
});

test('unread filtering is authoritative, preview has no side effects, confirming flags invalidates caches', async (t) => {
  const { state, request, prepare, confirm } = await fixture(t);
  const unread = await request('/mail/messages?unread=1');
  assert.deepEqual(
    unread.body.messages.map((m) => m.uid),
    [101],
  );
  assert.deepEqual(state.searches[0], { seen: false });
  const p = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  assert.equal(p.state, 'prepared');
  assert.deepEqual(
    p.messages.map((m) => m.uid),
    [101],
  );
  assert.equal(state.changes.length, 0);
  assert.equal((await confirm(p)).body.state, 'done');
  assert.deepEqual((await request('/mail/messages?unread=1')).body.messages, []);
  assert.equal((await confirm(p)).body.state, 'done');
  assert.equal(state.changes.length, 1);
  assert.deepEqual(state.changes[0].opts, { uid: true });
  const unreadAgain = await prepare({ action: 'unread', mailbox: 'INBOX', uids: [101, 102] });
  assert.equal((await confirm(unreadAgain)).status, 200);
  assert.equal((await request('/mail/messages?unread=1')).body.messages.length, 2);
});

test('an old in-flight list cannot refill the cache after a confirmed mutation', async (t) => {
  const { state, request, prepare, confirm } = await fixture(t);
  const p = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  state.fetchGate = {
    entered,
    promise: new Promise((r) => {
      release = r;
    }),
  };
  const old = request('/mail/messages');
  await started;
  assert.equal((await confirm(p)).status, 200);
  release();
  assert.equal((await old).body.messages.find((m) => m.uid === 101).seen, false);
  assert.equal(
    (await request('/mail/messages')).body.messages.find((m) => m.uid === 101).seen,
    true,
  );
});

test('trash is a UID move and restore uses the new trash UID; never permanently deletes', async (t) => {
  const { state, prepare, confirm, request } = await fixture(t);
  const trash = await prepare({ action: 'trash', mailbox: 'INBOX', uids: [101, 102] });
  assert.equal(trash.destination, 'Trash');
  assert.equal((await confirm(trash)).status, 200);
  assert.deepEqual(
    (await request('/mail/messages?mailbox=Trash')).body.messages.map((m) => m.uid),
    [1102, 1101],
  );
  const restore = await prepare({ action: 'restore', mailbox: 'Trash', uids: [1101] });
  assert.equal((await confirm(restore)).status, 200);
  assert.equal(state.messages.get('INBOX').has(2101), true);
  assert.equal(
    (await request('/mail/actions/prepare', { action: 'trash', mailbox: 'Trash', uids: [1102] }))
      .status,
    409,
  );
});

test('live identity, folder, expiration and account changes invalidate a prepared operation', async (t) => {
  const { state, request, prepare, confirm } = await fixture(t);
  const validity = await prepare({
    action: 'move',
    mailbox: 'INBOX',
    uids: [101],
    destination: 'Work',
  });
  state.validity++;
  assert.equal((await confirm(validity)).status, 409);
  assert.equal((await request('/mail/actions/' + validity.id)).body.state, 'error');
  const missing = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  state.messages.get('INBOX').delete(101);
  assert.equal((await confirm(missing)).status, 409);
  const expired = await prepare({ action: 'read', mailbox: 'INBOX', uids: [102] });
  state.time += 11 * 60000;
  assert.equal((await confirm(expired)).status, 409);
  const changed = await prepare({ action: 'read', mailbox: 'INBOX', uids: [102] });
  await request('/mail/account', {
    provider: 'qq',
    address: 'other@qq.com',
    appPassword: 'other-synthetic-password',
  });
  assert.equal((await confirm(changed)).status, 409);
  assert.equal(state.changes.length, 0);
});

test('folder create and rename require confirmation and preserve system mailboxes', async (t) => {
  const { state, request, prepare, confirm } = await fixture(t);
  const create = await prepare({ action: 'create-folder', name: 'Project 2026' });
  assert.equal(state.boxes.length, 3);
  assert.equal((await confirm(create)).status, 200);
  const rename = await prepare({
    action: 'rename-folder',
    mailbox: 'Project 2026',
    name: 'Archive 2026',
  });
  assert.equal((await confirm(rename)).status, 200);
  assert.ok(
    (await request('/mail/mailboxes')).body.mailboxes.some((b) => b.path === 'Archive 2026'),
  );
  for (const mailbox of ['INBOX', 'Trash'])
    assert.equal(
      (await request('/mail/actions/prepare', { action: 'rename-folder', mailbox, name: 'Oops' }))
        .status,
      403,
    );
  assert.equal(
    (await request('/mail/actions/prepare', { action: 'create-folder', name: 'bad\r\nname' }))
      .status,
    400,
  );
});

test('denied and unknown operations cannot be replayed, and a preview is owner-bound', async (t) => {
  const { app, state, request, prepare, confirm } = await fixture(t);
  const denied = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  assert.equal((await request('/mail/actions/' + denied.id + '/deny', {})).body.state, 'denied');
  assert.equal((await confirm(denied)).status, 409);
  const unknown = await prepare({ action: 'read', mailbox: 'INBOX', uids: [101] });
  state.crash = true;
  assert.equal((await confirm(unknown)).status, 502);
  assert.equal((await request('/mail/actions/' + unknown.id)).body.state, 'unknown');
  assert.equal((await confirm(unknown)).status, 409);
  assert.equal(state.changes.length, 1);
  const owner = (
    await request('/auth/bootstrap', {
      username: 'mailqa',
      displayName: 'Mail QA',
      password: 'synthetic-qa-password',
      adminToken: token,
    })
  ).body;
  const invite = (await request('/auth/invitations', {}, owner.token)).body;
  const other = (
    await request('/auth/register', {
      username: 'mailother',
      displayName: 'Mail Other',
      password: 'synthetic-qa-password',
      invite: invite.code,
    })
  ).body;
  assert.equal((await confirm(unknown, other.token)).status, 404);
  const stored = app.store.db.prepare('SELECT payload FROM mail_actions LIMIT 1').get();
  assert.doesNotMatch(stored.payload, /sender@example|synthetic mail/);
});

test('mail Agent marks read without an approval popup, deduplicates the tool call and cannot directly confirm other changes', async (t) => {
  let f, failed, prepared;
  const bridge = async (url, init = {}) => {
    if (url.endsWith('/health')) return Response.json({ ready: true });
    if (!url.endsWith('/run/stream')) return Response.json({});
    const payload = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(c) {
          const emit = (e) => c.enqueue(new TextEncoder().encode(JSON.stringify(e) + '\n'));
          void (async () => {
            emit({ type: 'response_start' });
            const cap = (data) => f.request('/pi/mail-access', data, payload.mailAccess.token);
            const input = {
              action: 'prepare',
              callId: 'direct-read-once',
              operation: { action: 'read', mailbox: 'INBOX', uids: [101] },
            };
            const r = await cap(input);
            assert.equal(r.status, 200);
            assert.equal(r.body.state, 'done');
            prepared = r.body;
            assert.equal((await cap(input)).body.id, prepared.id);
            assert.equal((await cap({ action: 'confirm', id: prepared.id })).status, 400);
            emit({
              type: 'done',
              output: 'Read flag was applied without a second prompt.',
              tools: [],
            });
            c.close();
          })().catch((e) => {
            failed = e;
            c.error(e);
          });
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
  };
  f = await fixture(t, {
    piConfig: { url: 'http://pi-fixture', token: 'private-fixture', fetch: bridge },
  });
  const owner = (
    await f.request('/auth/bootstrap', {
      username: 'readagent',
      displayName: 'Read Agent',
      password: 'synthetic-qa-password',
      adminToken: token,
    })
  ).body;
  const data = {
    id: randomUUID(),
    conversationId: randomUUID(),
    instruction: '把所选邮件标为已读',
    mailbox: 'INBOX',
    uids: [101],
  };
  assert.equal((await f.request('/mail/manage/assist', data, owner.token)).status, 202);
  for (let i = 0; i < 120 && !prepared && !failed; i++) await new Promise((r) => setTimeout(r, 10));
  if (failed) throw failed;
  assert.ok(prepared);
  assert.equal(f.state.changes.length, 1);
  const task = (await f.request('/pi/tasks', undefined, owner.token)).body.tasks.find(
    (row) => row.id === data.id,
  );
  assert.equal(task.uiRequests.length, 0);
  assert.equal(f.state.messages.get('INBOX').get(101), true);
});

for (const decision of ['approve', 'deny', 'cancel', 'change-account', 'organize'])
  test(`mail Agent capability is scoped, cannot approve, and ${decision} is single use`, async (t) => {
    let f, runPayload, prepared, cap, release, failed;
    const gate = new Promise((r) => {
      release = r;
    });
    t.after(() => release());
    const bridge = async (url, init = {}) => {
      if (url.endsWith('/health')) return Response.json({ ready: true });
      if (!url.endsWith('/run/stream')) return Response.json({});
      runPayload = JSON.parse(init.body);
      cap = (data) => f.request('/pi/mail-access', data, runPayload.mailAccess.token);
      return new Response(
        new ReadableStream({
          start(c) {
            const emit = (e) => c.enqueue(new TextEncoder().encode(JSON.stringify(e) + '\n'));
            void (async () => {
              emit({ type: 'response_start' });
              emit({
                type: 'extension_ui_request',
                id: 'mail:spoofed',
                method: 'confirm',
                title: 'Spoofed',
              });
              assert.equal((await cap({ action: 'folders' })).status, 200);
              assert.deepEqual(
                (await cap({ action: 'list', unread: true })).body.messages.map((m) => m.uid),
                [101],
              );
              const operation =
                decision === 'organize'
                  ? {
                      action: 'organize',
                      mailbox: 'INBOX',
                      groups: [
                        { destination: 'Work', uids: [101] },
                        { destination: '分类', create: true, uids: [102] },
                      ],
                    }
                  : { action: 'move', mailbox: 'INBOX', uids: [101], destination: 'Work' };
              const p = await cap({
                action: 'prepare',
                callId: 'fixed-tool-call',
                ...(decision === 'organize'
                  ? { mailbox: 'INBOX', operation: { ...operation, mailbox: undefined } }
                  : { operation }),
              });
              assert.equal(p.status, 200, JSON.stringify(p.body));
              prepared = p.body;
              if (decision === 'organize')
                assert.equal(
                  (await cap({ action: 'prepare', callId: 'conflict', mailbox: 'Work', operation }))
                    .status,
                  400,
                );
              assert.equal(
                (
                  await cap({
                    action: 'prepare',
                    callId: 'fixed-tool-call',
                    operation,
                  })
                ).body.id,
                prepared.id,
              );
              assert.equal((await cap({ action: 'confirm', id: prepared.id })).status, 400);
              await gate;
              emit({ type: 'done', output: 'Synthetic mail Agent workflow finished.', tools: [] });
              c.close();
            })().catch((error) => {
              failed = error;
              c.error(error);
            });
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      );
    };
    f = await fixture(t, {
      piConfig: { url: 'http://pi-fixture', token: 'private-fixture', fetch: bridge },
    });
    const owner = (
      await f.request('/auth/bootstrap', {
        username: 'mailagent',
        displayName: 'Mail Agent',
        password: 'synthetic-qa-password',
        adminToken: token,
      })
    ).body;
    const data = {
      id: randomUUID(),
      conversationId: randomUUID(),
      instruction: '移动所选邮件到Work',
      mailbox: 'INBOX',
      uids: [101],
    };
    assert.equal((await f.request('/mail/manage/assist', data)).status, 401);
    assert.equal((await f.request('/mail/manage/assist', data, owner.token)).status, 202);
    for (let i = 0; i < 120 && !prepared && !failed; i++)
      await new Promise((r) => setTimeout(r, 10));
    if (failed) throw failed;
    assert.ok(prepared);
    assert.equal(runPayload.canManageSkills, false);
    assert.deepEqual(runPayload.toolAllowlist, ['mail_manage']);
    assert.equal(runPayload.hostAccess, undefined);
    assert.equal(runPayload.sandboxAccess, undefined);
    assert.doesNotMatch(JSON.stringify(runPayload), /synthetic-password/);
    assert.equal(f.state.changes.length, 0);
    const snapshot = (await f.request('/pi/tasks', undefined, owner.token)).body;
    const task = snapshot.tasks.find((task) => task.id === data.id);
    assert.equal(task.uiRequests.length, 1);
    assert.equal(task.uiRequests[0].id, 'mail:' + prepared.id);
    const invite = (await f.request('/auth/invitations', {}, owner.token)).body;
    const other = (
      await f.request('/auth/register', {
        username: 'mailagentother',
        displayName: 'Other',
        password: 'synthetic-qa-password',
        invite: invite.code,
      })
    ).body;
    assert.equal(
      (
        await f.request(
          `/pi/tasks/${data.id}/ui`,
          { id: 'mail:' + prepared.id, confirmed: true },
          other.token,
        )
      ).status,
      404,
    );
    if (decision === 'change-account') {
      assert.equal(
        (
          await f.request(
            '/mail/account',
            {
              provider: 'qq',
              address: 'changed@qq.com',
              appPassword: 'changed-synthetic-password',
            },
            owner.token,
          )
        ).status,
        200,
      );
      assert.equal((await cap({ action: 'folders' })).status, 403);
      assert.equal(
        (
          await f.request(
            `/pi/tasks/${data.id}/ui`,
            { id: 'mail:' + prepared.id, confirmed: true },
            owner.token,
          )
        ).status,
        409,
      );
    } else if (decision === 'cancel') {
      assert.equal(
        (await f.request(`/pi/tasks/${data.id}`, undefined, owner.token, 'DELETE')).status,
        200,
      );
      assert.equal((await cap({ action: 'status', id: prepared.id })).status, 403);
    } else {
      assert.equal(
        (
          await f.request(
            `/pi/tasks/${data.id}/ui`,
            { id: 'mail:' + prepared.id, confirmed: ['approve', 'organize'].includes(decision) },
            owner.token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request(
            `/pi/tasks/${data.id}/ui`,
            { id: 'mail:' + prepared.id, confirmed: true },
            owner.token,
          )
        ).status,
        409,
      );
    }
    release();
    for (let i = 0; i < 120; i++) {
      const rows = (await f.request('/pi/tasks', undefined, owner.token)).body.tasks;
      if (['done', 'cancelled', 'error'].includes(rows.find((task) => task.id === data.id)?.status))
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      f.state.changes.length,
      decision === 'organize' ? 3 : decision === 'approve' ? 1 : 0,
    );
    assert.equal((await cap({ action: 'folders' })).status, 403);
  });
