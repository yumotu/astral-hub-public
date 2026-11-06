import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-computer-chats-'));
  let time = Date.now();
  const adminToken = 'synthetic-computer-chats-admin-token-12345678';
  const app = await createApp({ token: adminToken, dataDir: dir, now: () => time });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const req = async (path, data, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api` + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'chatsowner',
      password: 'Synthetic-chats-password',
      displayName: 'Chats',
      adminToken,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const other = (
    await req('/auth/register', {
      username: 'chatsother',
      password: 'Synthetic-chats-password',
      displayName: 'Other',
      invite: invite.code,
    })
  ).body;
  const code = (await req('/relay/pairing', {}, owner.token)).body.code;
  const device = (
    await req('/relay/device/enroll', {
      code,
      name: 'Test computer',
      platform: 'darwin',
      rootLabel: 'synthetic',
      allowWrite: true,
    })
  ).body;
  const projects = [
    { id: randomUUID(), name: 'one', allowWrite: true, allowExecute: false },
    { id: randomUUID(), name: 'two', allowWrite: false, allowExecute: false },
  ];
  const announce = () =>
    req('/relay/device/workspace/announce', { version: 2, projects }, device.token);
  await announce();
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const submit = (conversationId = randomUUID(), input = 'synthetic', extra = {}) => ({
    id: randomUUID(),
    deviceId: device.deviceId,
    projectId: projects[0].id,
    conversationId,
    input,
    access: 'read',
    execute: false,
    deliveryPreference: 'steer',
    ...extra,
  });
  const poll = () => req('/relay/device/workspace/jobs/poll?capacity=2', undefined, device.token);
  const state = { revision: 1, output: 'partial', thinking: '', phase: '正在回复', tools: [] };
  return {
    base: `http://127.0.0.1:${app.server.address().port}/api`,
    req,
    owner,
    other,
    device,
    projects,
    announce,
    submit,
    poll,
    state,
    db: app.store.db,
    tick: (ms) => (time += ms),
  };
}
test('remote main conversations can invoke current-account app functions without local file-write permission', async (t) => {
  const f = await fixture(t),
    p = f.submit(undefined, 'app functions', { projectId: f.projects[1].id });
  assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 202);
  assert.equal((await f.poll()).body.job.id, p.id);
  const path = '/relay/device/workspace/jobs/' + p.id + '/app-functions';
  assert.equal((await f.req(path, { action: 'catalog' }, f.owner.token)).status, 401);
  const catalog = (await f.req(path, { action: 'catalog' }, f.device.token)).body;
  assert.ok(catalog.functions.some((x) => x.name === 'contacts.send'));
  assert.ok(catalog.functions.some((x) => x.name === 'assistant.attachments'));
  const inputs = await f.req(
    path,
    { action: 'invoke', name: 'assistant.attachments', input: {}, callId: 'attachments' },
    f.device.token,
  );
  assert.equal(inputs.status, 200);
  assert.deepEqual(inputs.body.result.files, []);
  const learning = await f.req(
    path,
    { action: 'invoke', name: 'learning.list', input: {}, callId: 'list' },
    f.device.token,
  );
  assert.deepEqual(learning.body.result.lessons, []);
  await f.req('/social/contacts', { username: f.other.user.username }, f.owner.token);
  await f.req('/social/contacts/' + f.owner.user.id, { accept: true }, f.other.token);
  const proposal = (
    await f.req(
      path,
      {
        action: 'invoke',
        name: 'contacts.send',
        input: { contactId: f.other.user.id, content: 'Remote chat synthetic message' },
        callId: 'send',
      },
      f.device.token,
    )
  ).body;
  assert.equal(proposal.state, 'prepared');
  assert.equal(
    (await f.req('/app-functions/requests/' + proposal.id + '/confirm', {}, f.device.token)).status,
    401,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + proposal.id + '/confirm', {}, f.other.token)).status,
    404,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + proposal.id + '/confirm', {}, f.owner.token)).body
      .state,
    'done',
  );
  const other = f.submit();
  await f.req('/relay/submissions', other, f.owner.token);
  await f.poll();
  assert.equal(
    (
      await f.req(
        '/relay/device/workspace/jobs/' + other.id + '/app-functions',
        { action: 'status', id: proposal.id },
        f.device.token,
      )
    ).status,
    404,
  );
  const denied = (
    await f.req(
      path,
      {
        action: 'invoke',
        name: 'contacts.send',
        input: { contactId: f.other.user.id, content: 'Expired request' },
        callId: 'expired',
      },
      f.device.token,
    )
  ).body;
  f.tick(20 * 60000);
  assert.equal((await f.req(path, { action: 'catalog' }, f.device.token)).status, 409);
  assert.equal(
    (await f.req('/app-functions/requests/' + denied.id + '/confirm', {}, f.owner.token)).status,
    409,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM direct_messages').get().n, 1);
});
test('computer conversations keep project/account bindings, independent lanes, progress and idempotent submissions', async (t) => {
  const f = await fixture(t),
    a = f.submit(),
    b = f.submit(),
    c = f.submit(a.conversationId, 'next', { deliveryPreference: 'queue' });
  for (const p of [a, b, c])
    assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 202);
  assert.equal((await f.req('/relay/submissions', a, f.owner.token)).status, 200);
  assert.equal(
    (await f.req('/relay/submissions', { ...a, input: 'changed' }, f.owner.token)).status,
    409,
  );
  assert.equal(
    (await f.req('/relay/device/poll', undefined, f.device.token)).body.job,
    null,
    'legacy device cannot claim scoped jobs',
  );
  const first = (await f.poll()).body.job,
    second = (await f.poll()).body.job;
  assert.equal(first.id, a.id);
  assert.equal(second.id, b.id);
  assert.equal((await f.poll()).body.job, null);
  assert.equal((await f.req('/relay/jobs/' + a.id, undefined, f.other.token)).status, 404);
  assert.equal(
    (
      await f.req(
        '/relay/submissions',
        { ...f.submit(a.conversationId), projectId: f.projects[1].id },
        f.owner.token,
      )
    ).status,
    409,
  );
  const base = '/relay/device/workspace/jobs/' + a.id;
  assert.equal((await f.req(base + '/progress', f.state, f.device.token)).status, 200);
  await f.req(
    base + '/progress',
    { ...f.state, revision: 2, output: 'new partial' },
    f.device.token,
  );
  await f.req(base + '/progress', f.state, f.device.token);
  assert.equal(
    (await f.req('/relay/jobs/' + a.id, undefined, f.owner.token)).body.job.output,
    'new partial',
  );
  await f.req(
    base + '/result',
    { ...f.state, revision: 3, output: 'final', status: 'done' },
    f.device.token,
  );
  assert.equal((await f.poll()).body.job.id, c.id);
  const history = (
    await f.req('/relay/conversations/' + a.conversationId, undefined, f.owner.token)
  ).body;
  assert.deepEqual(
    history.jobs.map((j) => j.id),
    [a.id, c.id],
  );
  assert.equal(history.jobs[0].output, 'final');
  assert.equal(
    (await f.req('/relay/conversations/' + a.conversationId, undefined, f.other.token)).status,
    404,
  );
  assert.equal(
    (
      await f.req(
        '/relay/submissions',
        f.submit(undefined, 'forbidden', { projectId: f.projects[1].id, access: 'edit' }),
        f.owner.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        '/relay/submissions',
        f.submit(undefined, 'forbidden', { execute: true }),
        f.owner.token,
      )
    ).status,
    403,
  );
});
test('steering is delivered once before completion and revoked or disconnected tasks cannot revive', async (t) => {
  const f = await fixture(t),
    p = f.submit();
  await f.req('/relay/submissions', p, f.owner.token);
  await f.poll();
  const addition = f.submit(p.conversationId, 'supplement');
  const a = await f.req('/relay/submissions', addition, f.owner.token);
  assert.equal(a.body.job.parentId, p.id);
  const heartbeat = () => f.req('/relay/device/heartbeat', { jobId: p.id }, f.device.token);
  assert.deepEqual((await heartbeat()).body.controls, [{ id: addition.id, input: addition.input }]);
  assert.deepEqual((await heartbeat()).body.controls, []);
  await f.req(
    `/relay/device/workspace/jobs/${p.id}/control`,
    { id: addition.id, status: 'applied' },
    f.device.token,
  );
  await f.req(
    `/relay/device/workspace/jobs/${p.id}/control`,
    { id: addition.id, status: 'accepted' },
    f.device.token,
  );
  assert.equal(
    (await f.req('/relay/jobs/' + addition.id, undefined, f.owner.token)).body.job.status,
    'applied',
  );
  await f.req(
    `/relay/device/workspace/jobs/${p.id}/result`,
    { ...f.state, status: 'done' },
    f.device.token,
  );
  assert.equal(
    (await f.req('/relay/jobs/' + addition.id, undefined, f.owner.token)).body.job.status,
    'done',
  );
  const unknown = f.submit();
  await f.req('/relay/submissions', unknown, f.owner.token);
  await f.poll();
  f.tick(46000);
  assert.equal(
    (await f.req('/relay/jobs/' + unknown.id, undefined, f.owner.token)).body.job.status,
    'interrupted',
  );
  await f.req(
    `/relay/device/workspace/jobs/${unknown.id}/result`,
    { ...f.state, status: 'done' },
    f.device.token,
  );
  assert.equal(
    (await f.req('/relay/jobs/' + unknown.id, undefined, f.owner.token)).body.job.status,
    'interrupted',
  );
  assert.equal(
    (
      await f.req(
        '/relay/submissions',
        f.submit(unknown.conversationId, 'must not auto resume'),
        f.owner.token,
      )
    ).status,
    409,
  );
  const running = f.submit();
  await f.req('/relay/submissions', running, f.owner.token);
  await f.poll();
  f.projects.splice(0, 1);
  await f.announce();
  assert.equal(
    (await f.req('/relay/device/heartbeat', { jobId: running.id }, f.device.token)).body.cancelled,
    true,
  );
});

test('computer PTY transport requires local execution, preserves cursors and never repeats unknown keystrokes', async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    open = { id, deviceId: f.device.deviceId, projectId: f.projects[0].id, cols: 80, rows: 24 };
  assert.equal((await f.req('/relay/terminals', open, f.owner.token)).status, 403);
  f.projects[0].allowExecute = true;
  await f.announce();
  assert.equal((await f.req('/relay/terminals', open, f.owner.token)).status, 202);
  assert.equal((await f.req('/relay/terminals', open, f.owner.token)).status, 200);
  assert.equal((await f.req('/relay/terminals/' + id, undefined, f.other.token)).status, 404);
  const poll = () => f.req('/relay/device/workspace/poll?batch=1', undefined, f.device.token);
  assert.equal((await poll()).body.operations[0].kind, 'terminal_open');
  assert.deepEqual((await poll()).body.operations, []);
  const sync = (chunks, closed = false) =>
    f.req(
      '/relay/device/workspace/terminals/sync',
      { sessions: [{ id, closed, exitCode: closed ? 0 : null, chunks }] },
      f.device.token,
    );
  const chunk = { seq: 1, data: '真实输出替身\r\n' };
  assert.equal((await sync([chunk])).body.acks[id], 1);
  await sync([chunk]);
  const read = (await f.req('/relay/terminals/' + id, undefined, f.owner.token)).body;
  assert.equal(read.status, 'open');
  assert.deepEqual(read.chunks, [chunk]);
  const key = { id: randomUUID(), data: 'printf test\r' };
  assert.equal((await f.req('/relay/terminals/' + id + '/input', key, f.owner.token)).status, 202);
  assert.equal((await f.req('/relay/terminals/' + id + '/input', key, f.owner.token)).status, 200);
  assert.equal(
    (
      await f.req(
        '/relay/terminals/' + id + '/input',
        { ...key, data: 'different\r' },
        f.owner.token,
      )
    ).status,
    409,
  );
  const action = (await poll()).body.operations;
  assert.equal(action.length, 1);
  assert.equal(action[0].data, key.data);
  await f.req(
    '/relay/device/workspace/result',
    { id: key.id, status: 'done', result: { accepted: true } },
    f.device.token,
  );
  const finalRead = (await f.req('/relay/terminals/' + id + '?after=1', undefined, f.owner.token))
    .body;
  assert.deepEqual(finalRead.chunks, []);
  assert.equal(finalRead.inputReceipts[0].status, 'done');
  const expired = { id: randomUUID(), data: 'must not run later\r' };
  await f.req('/relay/terminals/' + id + '/input', expired, f.owner.token);
  f.tick(11000);
  assert.deepEqual((await poll()).body.operations, []);
  assert.equal(
    (await f.req('/relay/operations/' + expired.id, undefined, f.owner.token)).body.operation
      .status,
    'cancelled',
  );
  await f.req('/relay/terminals/' + id + '/close', { id: randomUUID() }, f.owner.token);
  assert.deepEqual((await sync([], false)).body.close, [id]);
  assert.equal(
    (
      await f.req(
        '/relay/terminals/' + id + '/input',
        { id: randomUUID(), data: 'x' },
        f.owner.token,
      )
    ).status,
    409,
  );
  await sync([], true);
  assert.equal((await f.req('/relay/terminals/' + id, undefined, f.owner.token)).body.closed, true);
});

test('a restarted terminal is interrupted, revoked projects cannot receive input and arbitrary file actions cannot open a shell', async (t) => {
  const f = await fixture(t);
  f.projects[0].allowExecute = true;
  await f.announce();
  const id = randomUUID(),
    open = { id, deviceId: f.device.deviceId, projectId: f.projects[0].id, cols: 80, rows: 24 };
  await f.req('/relay/terminals', open, f.owner.token);
  await f.req(
    '/relay/device/workspace/terminals/sync',
    {
      sessions: [
        { id, closed: false, exitCode: null, chunks: [{ seq: 1, data: 'retained output' }] },
      ],
    },
    f.device.token,
  );
  await f.req('/relay/device/workspace/terminals/sync', { sessions: [] }, f.device.token);
  const r = (await f.req('/relay/terminals/' + id, undefined, f.owner.token)).body;
  assert.equal(r.status, 'interrupted');
  assert.equal(r.chunks[0].data, 'retained output');
  assert.equal(
    (
      await f.req(
        '/relay/operations',
        {
          id: randomUUID(),
          deviceId: f.device.deviceId,
          projectId: f.projects[0].id,
          operation: { kind: 'terminal_open', sessionId: randomUUID() },
        },
        f.owner.token,
      )
    ).status,
    400,
  );
  f.projects[0].allowExecute = false;
  await f.announce();
  assert.equal(
    (
      await f.req(
        '/relay/terminals/' + id + '/input',
        { id: randomUUID(), data: 'x' },
        f.owner.token,
      )
    ).status,
    403,
  );
});

test('older computer conversations remain paginated, versioned and isolated without creating empty conversations', async (t) => {
  const f = await fixture(t),
    base = '/relay/conversations?deviceId=' + f.device.deviceId + '&projectId=' + f.projects[0].id;
  assert.deepEqual((await f.req(base, undefined, f.owner.token)).body.conversations, []);
  const insert = f.db.prepare(
    'INSERT INTO relay_conversations(id,owner,device_id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  );
  for (let i = 0; i < 101; i++) {
    const at = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
    insert.run(
      randomUUID(),
      f.owner.user.id,
      f.device.deviceId,
      f.projects[0].id,
      'synthetic ' + i,
      at,
      at,
    );
  }
  const first = (await f.req(base, undefined, f.owner.token)).body;
  assert.equal(first.conversations.length, 100);
  assert.ok(first.next);
  const second = (await f.req(base + '&before=' + first.next, undefined, f.owner.token)).body;
  assert.equal(second.conversations.length, 1);
  assert.equal(second.next, null);
  assert.equal(
    new Set([...first.conversations, ...second.conversations].map((c) => c.id)).size,
    101,
  );
  assert.equal((await f.req(base + '&before=' + first.next, undefined, f.other.token)).status, 404);
  const selected = second.conversations[0],
    p = f.submit(selected.id, 'version check');
  await f.req('/relay/submissions', p, f.owner.token);
  await f.poll();
  const before = (await f.req('/relay/conversations/' + p.conversationId, undefined, f.owner.token))
    .body.conversation.version;
  await f.req(`/relay/device/workspace/jobs/${p.id}/progress`, f.state, f.device.token);
  const after = (await f.req('/relay/conversations/' + p.conversationId, undefined, f.owner.token))
    .body.conversation.version;
  assert.notEqual(before, after);
  const latest = (await f.req(base, undefined, f.owner.token)).body.conversations.find(
    (c) => c.id === p.conversationId,
  );
  assert.equal(latest.version, after);
  assert.equal(latest.active, 1);
});

test('computer conversation menus preserve bindings, guard active deletion and tombstone old submissions and uploads', async (t) => {
  const f = await fixture(t),
    p = f.submit(undefined, 'menu history');
  assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 202);
  const path = '/relay/conversations/' + p.conversationId;
  for (const method of ['GET', 'PATCH', 'DELETE'])
    assert.equal(
      (
        await f.req(
          path,
          method === 'PATCH' ? { title: 'foreign' } : undefined,
          f.other.token,
          method,
        )
      ).status,
      404,
    );
  assert.equal(
    (await f.req(path, { title: '人工标题', pinned: true, archived: true }, f.owner.token, 'PATCH'))
      .status,
    200,
  );
  const normal = await f.req(
    `/relay/conversations?deviceId=${p.deviceId}&projectId=${p.projectId}`,
    undefined,
    f.owner.token,
  );
  assert.equal(normal.body.conversations.length, 0);
  const archived = await f.req(
    `/relay/conversations?deviceId=${p.deviceId}&projectId=${p.projectId}&archived=include`,
    undefined,
    f.owner.token,
  );
  assert.equal(archived.body.conversations[0].title, '人工标题');
  assert.ok(archived.body.conversations[0].pinnedAt);
  assert.ok(archived.body.conversations[0].archivedAt);
  assert.equal((await f.req(path, undefined, f.owner.token, 'DELETE')).status, 409);
  await f.poll();
  await f.req(
    '/relay/device/workspace/jobs/' + p.id + '/result',
    { ...f.state, status: 'done' },
    f.device.token,
  );
  const uploadUrl = f.base + `/pi/conversations/${p.conversationId}/files?name=notes.txt`;
  const upload = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + f.owner.token,
      'Content-Type': 'application/octet-stream',
    },
    body: 'synthetic menu attachment',
  });
  assert.equal(upload.status, 201);
  assert.equal((await f.req(path, undefined, f.owner.token, 'DELETE')).status, 200);
  assert.equal((await f.req(path, undefined, f.owner.token)).status, 404);
  assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 410);
  assert.equal(
    (await f.req('/relay/submissions', { ...p, id: randomUUID() }, f.owner.token)).status,
    410,
  );
  assert.equal(
    (
      await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + f.owner.token,
          'Content-Type': 'application/octet-stream',
        },
        body: 'late upload',
      })
    ).status,
    410,
  );
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM pi_files WHERE conversation_id=?').get(p.conversationId).n,
    0,
  );
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM relay_closed_conversations WHERE id=?')
      .get(p.conversationId).n,
    1,
  );
});

test('computer inputs require advertised support, account ownership and a running device lease; legacy receipts are not replayed', async (t) => {
  const f = await fixture(t),
    p = f.submit(undefined, 'read attachment', { thinkingLevel: 'high' });
  assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 409);
  await f.req(
    '/relay/device/workspace/announce',
    { version: 2, projects: f.projects, capabilities: ['chat_inputs', 'thinking_levels'] },
    f.device.token,
  );
  const upload = await fetch(
    f.base + `/pi/conversations/${p.conversationId}/files?name=input.txt`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + f.owner.token,
        'Content-Type': 'application/octet-stream',
      },
      body: 'computer input sentinel',
    },
  );
  const file = (await upload.json()).file;
  assert.equal(upload.status, 201);
  p.attachments = [file.id];
  assert.equal((await f.req('/relay/submissions', p, f.other.token)).status, 404);
  assert.equal(
    (await f.req('/relay/submissions', { ...p, attachments: [randomUUID()] }, f.owner.token))
      .status,
    404,
  );
  assert.equal((await f.req('/relay/submissions', p, f.owner.token)).status, 202);
  const inputs = '/relay/device/workspace/jobs/' + p.id + '/inputs';
  assert.equal((await f.req(inputs, undefined, f.device.token)).status, 403);
  const job = (await f.poll()).body.job;
  assert.equal(job.thinkingLevel, 'high');
  assert.equal(job.attachments[0].id, file.id);
  assert.equal((await f.req(inputs, undefined, f.owner.token)).status, 401);
  assert.equal((await f.req(inputs, undefined, f.device.token)).body.files[0].id, file.id);
  const discovered = await f.req(
    '/relay/device/workspace/jobs/' + p.id + '/app-functions',
    { action: 'invoke', name: 'assistant.attachments', input: {}, callId: 'current-inputs' },
    f.device.token,
  );
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.result.files[0].id, file.id);
  assert.ok(discovered.body.result.files.every((f) => !('path' in f)));
  const bytes = await fetch(f.base + inputs + '/' + file.id, {
    headers: { Authorization: 'Bearer ' + f.device.token },
  });
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), 'computer input sentinel');
  assert.equal(
    (
      await f.req(
        `/pi/conversations/${p.conversationId}/files/${file.id}`,
        undefined,
        f.owner.token,
        'DELETE',
      )
    ).status,
    409,
  );
  await f.req('/relay/jobs/' + p.id + '/cancel', {}, f.owner.token);
  assert.equal((await f.req(inputs, undefined, f.device.token)).status, 403);
  const old = f.submit(undefined, 'legacy receipt');
  await f.req('/relay/submissions', old, f.owner.token);
  const stored = JSON.parse(
    f.db.prepare('SELECT submission FROM relay_jobs WHERE id=?').get(old.id).submission,
  );
  delete stored.attachments;
  delete stored.thinkingLevel;
  f.db.prepare('UPDATE relay_jobs SET submission=? WHERE id=?').run(JSON.stringify(stored), old.id);
  const receipt = await f.req(
    '/relay/submissions',
    { ...old, thinkingLevel: 'high' },
    f.owner.token,
  );
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.job.thinkingLevel, 'off');
  assert.equal(f.db.prepare('SELECT count(*) n FROM relay_jobs WHERE id=?').get(old.id).n, 1);
});

test('computer app functions reuse scoped menus, freeze delete previews and execute confirmed deletion once', async (t) => {
  const f = await fixture(t),
    history = f.submit();
  await f.req('/relay/submissions', history, f.owner.token);
  await f.poll();
  await f.req(
    '/relay/device/workspace/jobs/' + history.id + '/result',
    { ...f.state, status: 'done' },
    f.device.token,
  );
  const current = f.submit();
  await f.req('/relay/submissions', current, f.owner.token);
  await f.poll();
  const path = '/relay/device/workspace/jobs/' + current.id + '/app-functions';
  let n = 0;
  const invoke = async (name, input = {}) =>
    (await f.req(path, { action: 'invoke', name, input, callId: 'menu-' + ++n }, f.device.token))
      .body;
  const devices = await invoke('computer.devices');
  assert.equal(devices.result.devices[0].id, f.device.deviceId);
  const update = await invoke('computer.conversation_update', {
    conversationId: history.conversationId,
    title: '工具改名',
    pinned: true,
  });
  assert.equal(update.state, 'done');
  const list = await invoke('computer.conversations', {
    deviceId: history.deviceId,
    projectId: history.projectId,
  });
  assert.ok(list.result.conversations.some((c) => c.title === '工具改名'));
  const first = await invoke('computer.conversation_delete', {
    conversationId: history.conversationId,
  });
  assert.equal(first.state, 'prepared');
  assert.match(first.preview.text, /Test computer.*one.*工具改名/);
  await invoke('computer.conversation_update', {
    conversationId: history.conversationId,
    title: '再次改名',
  });
  const stale = await f.req('/app-functions/requests/' + first.id + '/confirm', {}, f.owner.token);
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /已变化/);
  const second = await invoke('computer.conversation_delete', {
    conversationId: history.conversationId,
  });
  assert.equal(
    (await f.req('/app-functions/requests/' + second.id + '/confirm', {}, f.other.token)).status,
    404,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + second.id + '/confirm', {}, f.owner.token)).body
      .state,
    'done',
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + second.id + '/confirm', {}, f.owner.token)).body
      .state,
    'done',
  );
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM relay_closed_conversations WHERE id=?')
      .get(history.conversationId).n,
    1,
  );
  const usage = await invoke('usage.summary');
  assert.equal(usage.result.mode, 'estimate');
  assert.equal(usage.result.total.requests, 0);
});

test('computer questions persist and bind replies to one owner/job, reject stale choices, and preserve acknowledgement across progress', async (t) => {
  const f = await fixture(t),
    p = f.submit(undefined, 'ASK_USER');
  await f.req('/relay/submissions', p, f.owner.token);
  await f.poll();
  const ui = {
    id: randomUUID(),
    method: 'select',
    title: '选哪一项？',
    options: ['甲', '乙'],
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const progress = '/relay/device/workspace/jobs/' + p.id + '/progress';
  const reply = '/relay/jobs/' + p.id + '/ui';
  const snapshot = () =>
    f.req('/relay/conversations/' + p.conversationId, undefined, f.owner.token);
  await f.req(progress, { ...f.state, uiRequests: [ui] }, f.device.token);
  const version = (await snapshot()).body.conversation.version;
  assert.equal((await f.req(reply, { id: ui.id, value: '甲' }, f.other.token)).status, 404);
  assert.equal((await f.req(reply, { id: ui.id, value: '丙' }, f.owner.token)).status, 400);
  assert.equal((await f.req(reply, { id: ui.id, value: '乙' }, f.owner.token)).status, 200);
  assert.notEqual((await snapshot()).body.conversation.version, version);
  assert.equal((await f.req(reply, { id: ui.id, value: '甲' }, f.owner.token)).status, 409);
  // Device progress sent before it received the answer must not reopen a question.
  await f.req(progress, { ...f.state, revision: 2, uiRequests: [ui] }, f.device.token);
  assert.equal((await snapshot()).body.jobs[0].uiRequests[0].status, 'responding');
  const beat = () => f.req('/relay/device/heartbeat', { jobId: p.id }, f.device.token);
  for (let i = 0; i < 2; i++)
    assert.deepEqual((await beat()).body.controls, [
      { type: 'extension_ui_response', id: ui.id, value: '乙' },
    ]);
  await f.req(
    progress,
    { ...f.state, revision: 3, uiRequests: [{ ...ui, status: 'resolved' }] },
    f.device.token,
  );
  assert.deepEqual((await beat()).body.controls, []);
  assert.equal((await snapshot()).body.jobs[0].uiRequests[0].status, 'resolved');
  // A late packet must not return a resolved question to pending.
  await f.req(progress, { ...f.state, revision: 4, uiRequests: [ui] }, f.device.token);
  assert.equal((await snapshot()).body.jobs[0].uiRequests[0].status, 'resolved');
  const forged = { ...ui, id: 'access:fake' };
  assert.equal(
    (await f.req(progress, { ...f.state, revision: 5, uiRequests: [forged] }, f.device.token))
      .status,
    400,
  );
  await f.req('/relay/jobs/' + p.id + '/cancel', {}, f.owner.token);
  assert.equal((await f.req(reply, { id: ui.id, value: '甲' }, f.owner.token)).status, 409);
});
