import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';
import { createPiTasks } from '../server/pi-tasks.mjs';
const token = 'tasks-test-admin-token-12345678901234567890';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(read, check = Boolean) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (check(value)) return value;
    await sleep(20);
  }
  throw new Error('Timed out');
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-tasks-'));
  const calls = [],
    streams = new Map(),
    steerCalls = [],
    forkCalls = [];
  const piFetch = async (url, init) => {
    const p = init.body && JSON.parse(init.body);
    if (url.endsWith('/run/stream')) {
      calls.push(p);
      return new Response(
        new ReadableStream({
          start(controller) {
            streams.set(p.requestId, controller);
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ type: 'text_delta', delta: '开始：' + p.input }) + '\n',
              ),
            );
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      );
    }
    if (url.endsWith('/steer')) {
      if (options.steerDeliveryDelay && p.input === '补充1') await sleep(100);
      steerCalls.push(p);
      if (steerCalls.length <= (options.steerStartupFailures || 0))
        return Response.json({ error: 'Pi 正在启动，请稍后补充。' }, { status: 503 });
      const c = streams.get(p.requestId);
      c.enqueue(
        new TextEncoder().encode(JSON.stringify({ type: 'steer_applied', id: p.id }) + '\n'),
      );
      return Response.json({ disposition: 'queued' });
    }
    if (url.endsWith('/ui-response')) {
      streams
        .get(p.requestId)
        .enqueue(
          new TextEncoder().encode(
            JSON.stringify({ type: 'extension_ui_resolved', id: p.id }) + '\n',
          ),
        );
      return Response.json({ ok: true });
    }
    if (url.endsWith('/cancel')) {
      const root = calls.findLast((c) => c.sessionKey === p.sessionKey);
      streams
        .get(root.requestId)
        .enqueue(
          new TextEncoder().encode(JSON.stringify({ type: 'error', error: '已停止' }) + '\n'),
        );
      streams.get(root.requestId).close();
      streams.delete(root.requestId);
      return Response.json({ ok: true });
    }
    if (url.endsWith('/projects'))
      return Response.json({
        projects: [
          { id: 'alpha', readOnly: false },
          { id: 'readonly', readOnly: true },
        ],
      });
    if (url.endsWith('/sessions/fork')) {
      forkCalls.push(p);
      return Response.json({ native: true });
    }
    return Response.json({ nativeSessions: options.nativeSessions === true });
  };
  const app = await createApp({
    token,
    dataDir: dir,
    piConfig: { url: 'http://pi', token: 'bridge-test', fetch: piFetch },
    ...options,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  async function req(path, data, auth, method) {
    const response = await fetch(base + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = (
    await req('/auth/bootstrap', {
      username: 'owner',
      password: 'task-tests-password-7731!',
      displayName: 'Owner',
      adminToken: token,
    })
  ).body.token;
  const snapshot = async (auth = owner) => (await req('/pi/tasks', null, auth)).body;
  const task = async (id) => (await snapshot()).tasks.find((t) => t.id === id);
  const finish = (id, output = '已完成') => {
    const c = streams.get(id);
    c.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ type: 'done', output, tools: [], context: { messageCount: 4 } }) + '\n',
      ),
    );
    c.close();
    streams.delete(id);
  };
  t.after(async () => {
    for (const [id] of streams) finish(id);
    await eventually(
      () => streams.size,
      (n) => n === 0,
    );
    await sleep(40);
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const emit = (id, event) =>
    streams.get(id).enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  return { req, owner, snapshot, task, calls, steerCalls, forkCalls, finish, base, app, emit };
}
const message = (conversationId, input, extra = {}) => ({
  id: randomUUID(),
  conversationId,
  input,
  ...extra,
});
test('history branches preserve a prefix and attachment bytes, while editing leaves the source task running', async (t) => {
  const f = await fixture(t, { nativeSessions: true }),
    source = randomUUID();
  const upload = await fetch(`${f.base}/pi/conversations/${source}/files?name=sample.png`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + f.owner },
    body: Buffer.from('synthetic-image-bytes'),
  });
  const file = (await upload.json()).file;
  const a = message(source, 'first', { attachments: [file.id] }),
    b = message(source, 'second'),
    c = message(source, 'still running');
  for (const p of [a, b]) {
    await f.req('/pi/tasks', p, f.owner);
    await eventually(
      () => f.task(p.id),
      (x) => x?.status === 'running',
    );
    f.finish(p.id);
    await eventually(
      () => f.task(p.id),
      (x) => x?.status === 'done',
    );
  }
  await f.req('/pi/tasks', c, f.owner);
  await eventually(
    () => f.task(c.id),
    (x) => x?.status === 'running',
  );
  const id = randomUUID(),
    body = { id, turnId: b.id, position: 'before' };
  const fork = await f.req(`/pi/conversations/${source}/fork`, body, f.owner);
  assert.equal(fork.status, 201);
  assert.equal(fork.body.draft.input, 'second');
  const history = (await f.req(`/pi/conversations/${id}`, null, f.owner)).body.turns;
  assert.deepEqual(
    history.map((x) => x.input),
    ['first'],
  );
  assert.equal((await f.task(c.id)).status, 'running');
  const copied = history[0].attachments[0];
  assert.notEqual(copied.id, file.id);
  assert.equal(copied.sha256, file.sha256);
  assert.deepEqual(f.forkCalls[0].checkpoints, [{ from: a.id, to: history[0].id }]);
  assert.equal((await f.req(`/pi/conversations/${source}/fork`, body, f.owner)).status, 201);
  assert.equal((await f.req(`/pi/conversations/${id}`, null, f.owner)).body.turns.length, 1);
  assert.equal(
    (
      await f.req(
        `/pi/conversations/${randomUUID()}/fork`,
        { id: randomUUID(), turnId: a.id, position: 'after' },
        f.owner,
      )
    ).status,
    404,
  );
  const branched = message(id, 'edited second');
  await f.req('/pi/tasks', branched, f.owner);
  await eventually(
    () => f.task(branched.id),
    (x) => x?.status === 'running',
  );
  f.finish(branched.id);
  f.finish(c.id);
  await eventually(
    () => f.task(c.id),
    (x) => x?.status === 'done',
  );
  assert.equal((await f.req(`/pi/conversations/${source}`, null, f.owner, 'DELETE')).status, 200);
  const downloaded = await fetch(`${f.base}/pi/conversations/${id}/files/${copied.id}`, {
    headers: { Authorization: 'Bearer ' + f.owner },
  });
  assert.equal(await downloaded.text(), 'synthetic-image-bytes');
});

test('running conversations can be renamed, pinned and archived without interrupting or replaying the task', async (t) => {
  const f = await fixture(t),
    conversationId = randomUUID(),
    p = message(conversationId, '后台执行测试');
  await f.req('/pi/tasks', p, f.owner);
  await eventually(
    () => f.task(p.id),
    (task) => task?.status === 'running',
  );
  const path = '/pi/conversations/' + conversationId;
  const patch = await f.req(
    path,
    { title: '后台任务', pinned: true, archived: true },
    f.owner,
    'PATCH',
  );
  assert.equal(patch.status, 200);
  assert.equal((await f.req(path, null, f.owner, 'DELETE')).status, 409);
  assert.equal((await f.task(p.id)).status, 'running');
  assert.equal((await f.req('/pi/conversations', null, f.owner)).body.conversations.length, 0);
  f.finish(p.id);
  await eventually(
    () => f.task(p.id),
    (task) => task?.status === 'done',
  );
  assert.equal((await f.req('/pi/conversations', null, f.owner)).body.conversations.length, 0);
  const archived = (await f.req('/pi/conversations?archived=only', null, f.owner)).body
    .conversations[0];
  assert.equal(archived.title, '后台任务');
  assert.ok(archived.pinnedAt);
  await f.req(path, { archived: false }, f.owner, 'PATCH');
  assert.equal(
    (await f.req('/pi/conversations', null, f.owner)).body.conversations[0].title,
    '后台任务',
  );
  assert.equal(f.calls.length, 1);
});
test('bridge error details survive snapshots and warnings persist with completed history', async (t) => {
  const f = await fixture(t),
    conversation = randomUUID();
  const p = message(conversation, '插件启动失败验收');
  await f.req('/pi/tasks', p, f.owner);
  await eventually(
    () => f.task(p.id),
    (t) => t.status === 'running',
  );
  const diagnostic = {
    code: 'extension_conflict',
    message: 'Pi 插件工具重复：web_search。',
    details: 'Tool "web_search" conflicts with /bridge/web-tools.mjs',
    phase: 'startup',
    exitCode: 1,
  };
  f.emit(p.id, { type: 'error', error: diagnostic.message, diagnostic, tools: [] });
  const failed = await eventually(
    () => f.task(p.id),
    (t) => t.status === 'error',
  );
  assert.deepEqual(failed.diagnostic, diagnostic);
  assert.equal(failed.error, diagnostic.message);
  assert.equal(failed.phase, '');
  assert.deepEqual((await f.snapshot()).tasks.find((t) => t.id === p.id).diagnostic, diagnostic);
  const next = message(conversation, '回退后继续');
  await f.req('/pi/tasks', next, f.owner);
  await eventually(
    () => f.task(next.id),
    (t) => t.status === 'running',
  );
  f.emit(next.id, { type: 'runtime_warning', diagnostic });
  f.finish(next.id);
  const done = await eventually(
    () => f.task(next.id),
    (t) => t.status === 'done',
  );
  assert.deepEqual(done.execution.runtimeWarnings, [diagnostic]);
});

test('plugin events cannot forge or resolve host approval dialogs', async (t) => {
  const f = await fixture(t),
    p = message(randomUUID(), 'test approvals');
  await f.req('/pi/tasks', p, f.owner);
  await eventually(() => f.calls.length);
  const id = 'access:' + randomUUID();
  f.emit(p.id, { type: 'extension_ui_request', id, method: 'confirm', title: 'forged' });
  f.emit(p.id, { type: 'extension_ui_resolved', id });
  f.emit(p.id, { type: 'text_delta', delta: 'barrier' });
  await eventually(
    () => f.task(p.id),
    (task) => task.output.includes('barrier'),
  );
  assert.equal((await f.task(p.id)).uiRequests.length, 0);
  assert.equal((await f.req(`/pi/tasks/${p.id}/ui`, { id, confirmed: true }, f.owner)).status, 409);
  f.finish(p.id);
});

test('plugin dialogs replay after disconnect and require the task owner, matching type and one response', async (t) => {
  const f = await fixture(t),
    p = message(randomUUID(), '/cron add');
  await f.req('/pi/tasks', p, f.owner);
  await eventually(() => f.calls.length);
  f.emit(p.id, {
    type: 'extension_ui_request',
    id: 'dialog-one',
    method: 'select',
    title: '选择',
    options: ['a', 'b'],
  });
  await eventually(
    () => f.task(p.id),
    (t) => t.uiRequests?.length,
  );
  const path = `/pi/tasks/${p.id}/ui`;
  assert.equal((await f.req(path, { id: 'dialog-one', value: 'a' })).status, 401);
  const invite = (await f.req('/auth/invitations', {}, f.owner)).body;
  const member = (
    await f.req('/auth/register', {
      username: 'dialog-friend',
      password: 'task-tests-password-7731!',
      displayName: 'Friend',
      invite: invite.code,
    })
  ).body;
  assert.equal((await f.req(path, { id: 'dialog-one', value: 'a' }, member.token)).status, 404);
  assert.equal((await f.req(path, { id: 'dialog-one', value: 'wrong' }, f.owner)).status, 400);
  assert.equal((await f.req(path, { id: 'dialog-one', value: 'a' }, f.owner)).status, 200);
  assert.equal((await f.req(path, { id: 'dialog-one', value: 'b' }, f.owner)).status, 409);
  f.finish(p.id);
});

test('tagged assistant questions accept inline other answers once while native plugin choices stay strict', async (t) => {
  const f = await fixture(t),
    p = message(randomUUID(), 'Question');
  await f.req('/pi/tasks', p, f.owner);
  await eventually(() => f.calls.length);
  const meta = {
    questionId: randomUUID(),
    toolCallId: 'ask-user',
    question: '选择范围',
    context: '合成问题',
  };
  f.emit(p.id, {
    type: 'extension_ui_request',
    id: 'inline-other',
    method: 'select',
    title: meta.question,
    source: 'ask_user',
    questionId: meta.questionId,
    toolCallId: meta.toolCallId,
    options: ['仅摘要', '全文', '填写其他答案'],
  });
  await eventually(
    () => f.task(p.id),
    (task) => task.uiRequests?.length,
  );
  const path = `/pi/tasks/${p.id}/ui`;
  assert.equal(
    (await f.req(path, { id: 'inline-other', value: '仅检查第二页中的公式' }, f.owner)).status,
    200,
  );
  assert.equal(
    (await f.req(path, { id: 'inline-other', value: '不要重复提交' }, f.owner)).status,
    409,
  );
  f.finish(p.id);
});

test('background queue survives view disconnects, edits/withdrawals, cursor replay and duplicate submits', async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID();
  const first = message(a, 'A任务');
  assert.equal((await f.req('/pi/tasks', first, f.owner)).status, 202);
  await eventually(
    () => f.task(first.id),
    (t) => t.status === 'running',
  );
  const queued = message(a, '待编辑'),
    withdrawn = message(a, '撤回这一条');
  await f.req('/pi/tasks', queued, f.owner);
  await f.req('/pi/tasks', withdrawn, f.owner);
  assert.equal(
    (await f.req('/pi/tasks/' + queued.id, { input: '已编辑', revision: 1 }, f.owner, 'PATCH'))
      .status,
    200,
  );
  assert.equal(
    (await f.req('/pi/tasks/' + queued.id, { input: '旧设备覆盖', revision: 1 }, f.owner, 'PATCH'))
      .status,
    409,
  );
  assert.equal((await f.req('/pi/tasks/' + withdrawn.id, null, f.owner, 'DELETE')).status, 200);
  const before = await f.snapshot();
  assert.equal((await f.req('/pi/tasks', first, f.owner)).status, 200);
  assert.equal((await f.req('/pi/message', { ...first, stream: true }, f.owner)).status, 409);
  assert.equal(f.calls.length, 1);
  // Another device opens the same persisted task; neither reconnection nor reads execute it again.
  const secondDevice = await f.snapshot();
  assert.equal(secondDevice.tasks.find((t) => t.id === first.id).status, 'running');
  f.finish(first.id, 'A完成');
  await eventually(
    () => f.task(queued.id),
    (t) => t.status === 'running',
  );
  assert.equal(f.calls[1].input, '已编辑');
  const replay = await f.req('/pi/tasks/updates?after=' + before.cursor, null, f.owner);
  assert.ok(
    replay.body.events.some((e) => e.event.task?.id === first.id && e.event.task.status === 'done'),
  );
  assert.equal(new Set(replay.body.events.map((e) => e.seq)).size, replay.body.events.length);
  f.finish(queued.id, '编辑完成');
  await eventually(
    () => f.task(queued.id),
    (t) => t.status === 'done',
  );
  assert.equal(f.calls.length, 2);
  const turns = (await f.req('/pi/conversations/' + a, null, f.owner)).body.turns;
  assert.deepEqual(
    turns.map((t) => t.input),
    ['A任务', '已编辑'],
  );
  assert.equal((await f.req('/pi/conversations/' + b, null, f.owner)).body.turns.length, 0);
  assert.equal(
    (await f.req('/pi/tasks/' + queued.id, { input: '太晚', revision: 2 }, f.owner, 'PATCH'))
      .status,
    409,
  );
});

test('startup steering retries only the same control message and never restarts the model task', async (t) => {
  const f = await fixture(t, { steerStartupFailures: 2 }),
    conversationId = randomUUID(),
    root = message(conversationId, '原任务');
  await f.req('/pi/tasks', root, f.owner);
  await eventually(
    () => f.task(root.id),
    (x) => x?.status === 'running',
  );
  const control = message(conversationId, '启动期间补充', { mode: 'steer', parentId: root.id });
  await f.req('/pi/tasks', control, f.owner);
  await eventually(
    () => f.task(control.id),
    (x) => x?.status === 'applied',
  );
  assert.equal(f.steerCalls.length, 3);
  assert.ok(f.steerCalls.every((p) => p.id === control.id && p.requestId === root.id));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.task(root.id)).status, 'running');
  f.finish(root.id);
  await eventually(
    () => f.task(root.id),
    (x) => x?.status === 'done',
  );
});
test('native steering is account/conversation scoped, applied supplements persist, and cancellations pause queued instructions', async (t) => {
  const f = await fixture(t),
    conversationId = randomUUID(),
    root = message(conversationId, '原任务');
  await f.req('/pi/tasks', root, f.owner);
  await eventually(
    () => f.task(root.id),
    (t) => t.status === 'running',
  );
  const supplement = message(conversationId, '补充要求', { mode: 'steer', parentId: root.id });
  assert.equal((await f.req('/pi/tasks', supplement, f.owner)).status, 202);
  await eventually(
    () => f.task(supplement.id),
    (t) => t.status === 'applied',
  );
  assert.equal((await f.req('/pi/tasks', supplement, f.owner)).status, 200);
  assert.equal((await f.req('/pi/tasks/' + supplement.id, null, f.owner, 'DELETE')).status, 409);
  assert.equal(
    (
      await f.req(
        '/pi/tasks',
        message(randomUUID(), '跨对话补充', { mode: 'steer', parentId: root.id }),
        f.owner,
      )
    ).status,
    409,
  );
  const invite = (await f.req('/auth/invitations', {}, f.owner)).body.code;
  const member = (
    await f.req('/auth/register', {
      username: 'member',
      password: 'task-tests-password-7731!',
      displayName: 'Member',
      invite,
    })
  ).body.token;
  assert.equal((await f.snapshot(member)).tasks.length, 0);
  assert.equal((await f.req('/pi/tasks/' + root.id, null, member, 'DELETE')).status, 404);
  assert.equal(
    (
      await f.req(
        '/pi/tasks',
        message(conversationId, '越权', { mode: 'steer', parentId: root.id }),
        member,
      )
    ).status,
    409,
  );
  f.finish(root.id, '原任务与补充完成');
  await eventually(
    () => f.task(root.id),
    (t) => t.status === 'done',
  );
  const turn = (await f.req('/pi/conversations/' + conversationId, null, f.owner)).body.turns[0];
  assert.equal(turn.supplements[0].input, '补充要求');
  const next = message(conversationId, '下一项'),
    waiting = message(conversationId, '不要自动执行');
  await f.req('/pi/tasks', next, f.owner);
  await eventually(
    () => f.task(next.id),
    (t) => t.status === 'running',
  );
  await f.req('/pi/tasks', waiting, f.owner);
  await f.req('/pi/tasks/' + next.id, null, f.owner, 'DELETE');
  await eventually(
    () => f.task(next.id),
    (t) => t.status === 'cancelled',
  );
  assert.equal((await f.task(waiting.id)).status, 'interrupted');
  const fresh = message(conversationId, '核对后新任务');
  await f.req('/pi/tasks', fresh, f.owner);
  await eventually(
    () => f.task(fresh.id),
    (t) => t.status === 'running',
  );
  f.finish(fresh.id);
  await eventually(
    () => f.task(fresh.id),
    (t) => t.status === 'done',
  );
});

test('durable restart marks uncertain executions and their dependent queue without replaying side effects', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-tasks-restart-')),
    db = new DatabaseSync(join(dir, 'test.sqlite'));
  let runs = 0;
  const options = {
    available: () => true,
    completed: () => false,
    run: async () => {
      runs++;
      await new Promise(() => {});
    },
    steer: async () => {},
    cancel: async () => {},
  };
  let tasks = createPiTasks(db, options);
  const a = message(randomUUID(), '修改文件', {
    projectId: null,
    access: 'read',
    mode: 'queue',
    parentId: null,
    attachments: [],
    thinkingLevel: 'off',
  });
  tasks.add('owner', a);
  await eventually(
    () => runs,
    (n) => n === 1,
  );
  tasks.add('owner', { ...a, id: randomUUID(), input: '依赖之前的修改' });
  tasks.close();
  tasks = createPiTasks(db, options);
  assert.equal(tasks.get('owner', a.id).status, 'interrupted');
  assert.ok(tasks.all('owner').every((t) => t.status === 'interrupted'));
  await sleep(50);
  assert.equal(runs, 1);
  tasks.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('executor busy before acceptance leaves a task queued; it does not fail or duplicate an accepted operation', async () => {
  const db = new DatabaseSync(':memory:');
  let attempts = 0;
  const tasks = createPiTasks(db, {
    available: () => true,
    completed: () => false,
    steer: async () => {},
    cancel: async () => {},
    run: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('busy'), { status: 429 });
      return { output: 'accepted once' };
    },
  });
  const p = message(randomUUID(), 'wait for executor', {
    projectId: null,
    access: 'read',
    mode: 'queue',
    parentId: null,
    attachments: [],
    thinkingLevel: 'off',
  });
  try {
    tasks.add('owner', p);
    await eventually(
      () => attempts,
      (n) => n === 1,
    );
    assert.equal(tasks.get('owner', p.id).status, 'queued');
    await eventually(
      () => tasks.get('owner', p.id),
      (t) => t.status === 'done',
    );
    assert.equal(attempts, 2);
    tasks.add('owner', p);
    assert.equal(attempts, 2);
  } finally {
    tasks.close();
    db.close();
  }
});

test('Ask/Agent modes switch between turns in the same native session and stay locked while queued or steering', async (t) => {
  const f = await fixture(t),
    conversationId = randomUUID();
  const ask = message(conversationId, '查看项目', { projectId: 'alpha', access: 'read' });
  await f.req('/pi/tasks', ask, f.owner);
  await eventually(
    () => f.task(ask.id),
    (t) => t.status === 'running',
  );
  const agent = message(conversationId, '修改项目', { projectId: 'alpha', access: 'edit' });
  assert.equal((await f.req('/pi/tasks', agent, f.owner)).status, 409);
  const queued = message(conversationId, '继续分析', { projectId: 'alpha', access: 'read' });
  assert.equal((await f.req('/pi/tasks', queued, f.owner)).status, 202);
  f.finish(ask.id);
  await eventually(
    () => f.task(queued.id),
    (t) => t.status === 'running',
  );
  assert.equal((await f.req('/pi/tasks', agent, f.owner)).status, 409);
  f.finish(queued.id);
  await eventually(
    () => f.task(queued.id),
    (t) => t.status === 'done',
  );
  assert.equal((await f.req('/pi/tasks', agent, f.owner)).status, 202);
  await eventually(
    () => f.task(agent.id),
    (t) => t.status === 'running',
  );
  assert.equal(f.calls.at(-1).access, 'edit');
  assert.equal(f.calls.at(-1).sessionKey, f.calls[0].sessionKey);
  assert.equal(f.calls.at(-1).history.length, 4);
  assert.equal(
    (
      await f.req(
        '/pi/tasks',
        message(conversationId, '补充不能改变执行权限', {
          projectId: 'alpha',
          access: 'read',
          mode: 'steer',
          parentId: agent.id,
        }),
        f.owner,
      )
    ).status,
    409,
  );
  // A supplement to the edit run must use its actual mode, not the previous completed turn's mode.
  const supplement = message(conversationId, '沿用智能体模式补充', {
    projectId: 'alpha',
    access: 'edit',
    mode: 'steer',
    parentId: agent.id,
  });
  assert.equal((await f.req('/pi/tasks', supplement, f.owner)).status, 202);
  await eventually(
    () => f.task(supplement.id),
    (t) => t.status === 'applied',
  );
  f.finish(agent.id);
  await eventually(
    () => f.task(agent.id),
    (t) => t.status === 'done',
  );
  const conversations = (await f.req('/pi/conversations', null, f.owner)).body.conversations;
  assert.equal(conversations.find((c) => c.id === conversationId).access, 'edit');
  const back = message(conversationId, '切回询问', { projectId: 'alpha', access: 'read' });
  assert.equal((await f.req('/pi/tasks', back, f.owner)).status, 202);
  await eventually(
    () => f.task(back.id),
    (t) => t.status === 'running',
  );
  assert.equal(f.calls.at(-1).access, 'read');
  assert.equal(f.calls.at(-1).sessionKey, f.calls[0].sessionKey);
  f.finish(back.id);
  await eventually(
    () => f.task(back.id),
    (t) => t.status === 'done',
  );
  assert.equal(
    (
      await f.req(
        '/pi/tasks',
        message(conversationId, '更换项目', { projectId: 'readonly' }),
        f.owner,
      )
    ).status,
    409,
  );
  const locked = message(randomUUID(), '尝试修改只读来源', {
    projectId: 'readonly',
    access: 'edit',
  });
  const denied = await f.req('/pi/tasks', locked, f.owner);
  assert.equal(denied.status, 403);
  assert.equal(await f.task(locked.id), undefined, 'denied edits never create a queued model task');
  assert.equal(f.calls.filter((c) => c.projectId === 'readonly').length, 0);
});

test('different conversations run concurrently while each conversation keeps FIFO, steering and cancel isolation', async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID();
  const first = message(a, 'A first'),
    second = message(b, 'B first'),
    next = message(a, 'A next');
  await f.req('/pi/tasks', first, f.owner);
  await eventually(
    () => f.task(first.id),
    (x) => x?.status === 'running',
  );
  await f.req('/pi/tasks', next, f.owner);
  await f.req('/pi/tasks', second, f.owner);
  await eventually(
    () => f.calls.length,
    (n) => n === 2,
  );
  assert.equal((await f.task(first.id)).status, 'running');
  assert.equal((await f.task(second.id)).status, 'running');
  assert.equal((await f.task(next.id)).status, 'queued');
  const supplement = message(b, 'B supplement', { mode: 'steer', parentId: second.id });
  await f.req('/pi/tasks', supplement, f.owner);
  await eventually(
    () => f.task(supplement.id),
    (x) => x?.status === 'applied',
  );
  await f.req('/pi/tasks/' + first.id, null, f.owner, 'DELETE');
  await eventually(
    () => f.task(first.id),
    (x) => x?.status === 'cancelled',
  );
  assert.equal((await f.task(next.id)).status, 'interrupted');
  assert.equal((await f.task(second.id)).status, 'running');
  f.finish(second.id, 'B completed');
  await eventually(
    () => f.task(second.id),
    (x) => x?.status === 'done',
  );
  assert.equal(f.calls.length, 2);
  assert.equal((await f.req('/pi/conversations/' + b, null, f.owner)).body.turns.length, 1);
});

test('authenticated users run independent conversations concurrently with isolated streams, cancellation and history', async (t) => {
  const f = await fixture(t, { piConcurrency: 4, piConcurrencyPerUser: 2 });
  const invite = (await f.req('/auth/invitations', {}, f.owner)).body.code;
  const member = (
    await f.req('/auth/register', {
      username: 'multiuser-member',
      displayName: 'Member',
      password: 'multiuser-only-test-2026!',
      invite,
    })
  ).body.token;
  assert.ok(member);
  const conversation = randomUUID();
  const a = message(conversation, 'owner task'),
    a2 = message(randomUUID(), 'owner second'),
    a3 = message(randomUUID(), 'owner queued');
  const b = message(conversation, 'member task'),
    b2 = message(randomUUID(), 'member second');
  for (const p of [a, a2, a3]) assert.equal((await f.req('/pi/tasks', p, f.owner)).status, 202);
  for (const p of [b, b2]) assert.equal((await f.req('/pi/tasks', p, member)).status, 202);
  await eventually(
    () => f.calls.length,
    (n) => n === 4,
  );
  const own = await f.snapshot(),
    other = await f.snapshot(member);
  assert.equal(own.tasks.filter((x) => x.status === 'running').length, 3);
  assert.equal(other.tasks.filter((x) => x.status === 'running').length, 1);
  assert.equal(other.tasks.find((x) => x.id === b2.id).phase, '等待空闲执行名额');
  assert.ok(!JSON.stringify(other).includes(a.id));
  assert.ok(!JSON.stringify(own).includes(b.id));
  assert.equal((await f.req('/pi/tasks/' + a.id, null, member, 'DELETE')).status, 404);
  assert.equal(
    (await f.req('/pi/tasks/' + a.id, { input: 'overwrite', revision: 1 }, member, 'PATCH')).status,
    404,
  );
  const first = f.calls.find((x) => x.requestId === a.id),
    second = f.calls.find((x) => x.requestId === b.id);
  assert.notEqual(first.sessionKey, second.sessionKey);
  assert.notEqual(first.ownerId, second.ownerId);
  assert.equal(second.canManageSkills, false);
  f.finish(b.id, 'member private result');
  f.finish(a.id, 'owner private result');
  await eventually(
    async () => (await f.snapshot(member)).tasks.find((x) => x.id === b.id),
    (x) => x?.status === 'done',
  );
  await eventually(
    () => f.task(a.id),
    (x) => x?.status === 'done',
  );
  const ownHistory = (await f.req('/pi/conversations/' + conversation, null, f.owner)).body;
  const memberHistory = (await f.req('/pi/conversations/' + conversation, null, member)).body;
  assert.equal(ownHistory.turns[0].output, 'owner private result');
  assert.equal(memberHistory.turns[0].output, 'member private result');
  const events = (await f.req('/pi/tasks/updates?after=0', null, member)).body;
  assert.ok(!JSON.stringify(events).includes('owner private result'));
  await eventually(
    () => f.calls.length,
    (n) => n === 5,
  );
  for (const p of [a2, a3, b2]) f.finish(p.id);
  await eventually(
    () => f.snapshot(),
    (s) => s.tasks.every((x) => ['done'].includes(x.status)),
  );
});

test('finished tasks get asynchronous AI names without blocking replies and manual names stay authoritative', async (t) => {
  let complete,
    generated = 0;
  const f = await fixture(t, {
    generateTitle: async () => {
      generated++;
      return new Promise((r) => (complete = r));
    },
  });
  const conversationId = randomUUID(),
    id = randomUUID();
  assert.equal(
    (
      await f.req(
        '/pi/tasks',
        { id, conversationId, input: '帮我整理项目需求', access: 'read' },
        f.owner,
      )
    ).status,
    202,
  );
  await eventually(() => f.calls.length);
  f.finish(id, '需求已整理');
  await eventually(
    () => f.task(id),
    (x) => x?.status === 'done',
  );
  assert.equal(generated, 1);
  const path = '/pi/conversations/' + conversationId;
  assert.equal((await f.req(path, null, f.owner)).body.conversation.title, '帮我整理项目需求');
  await f.req(path, { title: '人工标题' }, f.owner, 'PATCH');
  complete('项目需求整理');
  await new Promise((r) => setImmediate(r));
  assert.equal((await f.req(path, null, f.owner)).body.conversation.title, '人工标题');
});

test('continuous submissions choose the live parent at admission and deliver in order before the parent finishes', async (t) => {
  const f = await fixture(t, { steerDeliveryDelay: true }),
    conversationId = randomUUID(),
    root = message(conversationId, '持续任务');
  await f.req('/pi/tasks', root, f.owner);
  await eventually(
    () => f.task(root.id),
    (x) => x?.status === 'running',
  );
  const a = message(conversationId, '补充1', { deliveryPreference: 'steer' }),
    b = message(conversationId, '补充2', { deliveryPreference: 'steer' });
  assert.equal((await f.req('/pi/submissions', a, f.owner)).status, 202);
  assert.equal((await f.req('/pi/submissions', b, f.owner)).status, 202);
  await eventually(
    () => f.task(b.id),
    (x) => x?.status === 'applied',
  );
  assert.deepEqual(
    f.steerCalls.map((p) => p.input),
    ['补充1', '补充2'],
  );
  assert.equal((await f.task(a.id)).parentId, root.id);
  assert.equal((await f.task(root.id)).status, 'running');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.req('/pi/submissions', a, f.owner)).status, 200);
  assert.equal(
    (await f.req('/pi/submissions', { ...a, input: '不允许更换已发送内容' }, f.owner)).status,
    409,
  );
  f.finish(root.id);
  await eventually(
    () => f.task(root.id),
    (x) => x?.status === 'done',
  );
  const late = message(conversationId, '任务结束后的新补充', {
    mode: 'steer',
    parentId: root.id,
    deliveryPreference: 'steer',
  });
  const accepted = await f.req('/pi/submissions', late, f.owner);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.task.mode, 'queue');
  assert.equal(accepted.body.task.parentId, null);
  await eventually(
    () => f.task(late.id),
    (x) => x?.status === 'running',
  );
  f.finish(late.id);
  assert.equal((await f.req('/pi/submissions', a, f.owner)).status, 200);
  assert.equal(f.calls.length, 2);
});
