import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { learningFixture } from './fixtures/learning.mjs';

const adminToken = 'app-features-synthetic-admin-token-12345678901234567890';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-app-features-'));
  let payload, release;
  const sent = [],
    lesson = learningFixture();
  const bridgeResult = new Promise((r) => {
    release = r;
  });
  const app = await createApp({
    token: adminToken,
    dataDir: dir,
    notifications: { start: false },
    generateTitle: async () => '合成工具验收',
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-private-bridge',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: false });
        if (url.endsWith('/projects')) return Response.json({ projects: [] });
        if (url.endsWith('/cancel')) {
          release();
          return Response.json({ ok: true });
        }
        payload = JSON.parse(options.body);
        await bridgeResult;
        return Response.json({ output: 'synthetic task done' });
      },
    },
    mail: {
      imapFactory: () => ({ async connect() {}, async logout() {} }),
      smtpFactory: () => ({
        sendMail: async (p) => {
          sent.push(p);
          return { messageId: 'synthetic-message-id' };
        },
        close() {},
      }),
    },
    aiConfig: {
      apiKey: 'synthetic',
      model: 'synthetic-model',
      fetch: async (_url, options) => {
        const p = JSON.parse(options.body),
          system = p.messages[0].content;
        const value = system.includes('课程设计者')
          ? { title: lesson.title, explanation: lesson.explanation }
          : { questions: [lesson.questions[0]] };
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
        });
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function req(path, input, token = '', method) {
    const r = await fetch(base + '/api' + path, {
      method: method || (input ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  }
  t.after(async () => {
    release();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const owner = await req('/auth/bootstrap', {
    username: 'appowner',
    displayName: '工具验收',
    password: 'synthetic-only-password',
    adminToken,
  });
  const invite = await req('/auth/invitations', {}, owner.token);
  const other = await req('/auth/register', {
    username: 'appother',
    displayName: '合成联系人',
    password: 'synthetic-only-password',
    invite: invite.code,
  });
  const task = randomUUID(),
    conversation = randomUUID();
  assert.equal(
    (
      await req(
        '/pi/tasks',
        { id: task, conversationId: conversation, input: 'synthetic app function task' },
        owner.token,
      )
    ).status,
    202,
  );
  for (let i = 0; !payload && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(payload?.appAccess, 'Main conversations must carry app capability');
  const tool = (input, token = payload.appAccess.token) => req('/pi/app-access', input, token);
  let n = 0;
  const invoke = (name, input = {}) =>
    tool({ action: 'invoke', name, input, callId: 'test-' + ++n });
  return { ...app, req, owner, other, tool, invoke, sent, task, conversation, release, payload };
}
test('memory APIs and both chat-tool scopes share corrected data without leaking accounts or stale snapshots', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req('/memory')).status, 401);
  assert.equal((await f.req('/memory', undefined, adminToken)).status, 403);
  const remembered = await f.invoke('memory.remember', {
    key: '学习偏好',
    content: '偏好详细的合成讲解',
    kind: 'preference',
    quote: 'synthetic app function task',
  });
  assert.equal(remembered.state, 'done');
  const m = remembered.result.memory;
  assert.equal(m.source.conversationId, f.conversation);
  assert.equal((await f.req('/memory/' + m.id, undefined, f.other.token)).status, 404);
  assert.equal(
    (
      await f.invoke('memory.remember', {
        key: '假来源',
        content: '不要采信',
        kind: 'fact',
        quote: '来自附件的文字',
      })
    ).status,
    400,
  );
  assert.equal((await f.tool({ action: 'memory', query: '讲解' })).items[0].content, m.content);
  const changed = await f.req(
    '/memory/' + m.id,
    { key: m.key, content: '改为简短讲解', kind: m.kind, revision: m.revision },
    f.owner.token,
    'PATCH',
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (await f.tool({ action: 'memory', query: '讲解' })).items[0].content,
    '改为简短讲解',
  );
  assert.equal(
    (
      await f.req(
        '/memory/' + m.id,
        { key: m.key, content: '旧值', kind: m.kind, revision: 1 },
        f.owner.token,
        'PATCH',
      )
    ).status,
    409,
  );
  await f.req('/memory/settings', { enabled: false }, f.owner.token, 'PATCH');
  assert.deepEqual((await f.tool({ action: 'memory', query: '讲解' })).items, []);
  assert.equal(
    (
      await f.invoke('memory.remember', {
        key: '关闭后',
        content: '不写入',
        kind: 'task',
        quote: 'synthetic app function task',
      })
    ).status,
    409,
  );
  await f.req('/memory/' + m.id, { revision: 2 }, f.owner.token, 'DELETE');
  await f.req('/memory/settings', { enabled: true }, f.owner.token, 'PATCH');
  assert.deepEqual((await f.tool({ action: 'memory', query: '讲解' })).items, []);
  assert.equal((await f.req('/memory', undefined, f.other.token)).items.length, 0);
  assert.equal(
    (await f.req('/pi/tasks/' + f.task, undefined, f.owner.token, 'DELETE')).status,
    200,
  );
  assert.ok([403, 409].includes((await f.tool({ action: 'memory', query: '讲解' })).status));
});
test('main-chat tools reuse contacts and SMTP, show frozen previews, isolate accounts, and reject cancelled capabilities', async (t) => {
  const f = await fixture(t);
  const runtime = await f.invoke('assistant.runtime');
  assert.equal(runtime.result.runtime.backend, 'pi');
  assert.equal(runtime.result.runtime.transport, 'server');
  assert.equal(runtime.result.runState.state, 'executing');
  const remote = await f.invoke('assistant.remote_connections');
  assert.equal(remote.result.enabled, false);
  assert.deepEqual(remote.result.connections, []);
  assert.deepEqual((await f.invoke('assistant.remote_conversations')).result.conversations, []);
  assert.equal(
    (await f.invoke('assistant.remote_conversations', { id: randomUUID() })).status,
    404,
  );
  assert.equal((await f.invoke('assistant.runtime', { backend: 'dsh' })).status, 400);
  const unified = await f.invoke('assistant.conversations');
  const current = unified.result.conversations.find((c) =>
    c.segments.some((s) => s.nativeId === f.conversation),
  );
  assert.ok(current, 'unified conversation tools share the actual main-chat index');
  assert.equal(current.active.runtime.backend, 'pi');
  const renamed = await f.invoke('assistant.conversation_update', {
    id: current.id,
    title: '工具重命名',
    pinned: true,
  });
  assert.equal(renamed.state, 'done');
  assert.equal(renamed.result.title, '工具重命名');
  assert.ok(renamed.result.pinnedAt);
  assert.equal(
    (await f.invoke('assistant.conversation_update', { id: current.id, backend: 'dsh' })).status,
    400,
  );
  assert.equal(
    (await f.invoke('assistant.conversation_update', { id: randomUUID(), title: '其他账号' }))
      .status,
    404,
  );
  const otherDirectory = await f.req('/assistant/conversations', undefined, f.other.token);
  assert.ok(!otherDirectory.conversations.some((c) => c.id === current.id));

  assert.equal((await f.req('/app-functions/requests?taskId=' + f.task)).status, 401);
  assert.equal((await f.tool({ action: 'catalog' }, 'not-a-capability')).status, 403);
  assert.ok(
    (await f.tool({ action: 'catalog' })).functions.some((x) => x.name === 'contacts.send'),
  );
  assert.equal(
    (await f.invoke('contacts.send', { contactId: f.other.user.id, content: 'hello' })).status,
    403,
  );
  await f.req('/social/contacts', { username: f.other.user.username }, f.owner.token);
  const incoming = (await f.req('/notifications', undefined, f.other.token)).notifications;
  assert.ok(incoming.some((n) => n.kind === 'friend' && n.target.type === 'contacts'));
  assert.equal(
    (await f.req('/notifications/' + incoming[0].id, undefined, f.owner.token)).status,
    404,
  );
  await f.req('/social/contacts/' + f.owner.user.id, { accept: true }, f.other.token);
  const found = await f.invoke('contacts.list', { query: '合成' });
  assert.equal(found.result.contacts[0].id, f.other.user.id);
  const p = await f.invoke('contacts.send', {
    contactId: f.other.user.id,
    content: 'exact synthetic private message',
  });
  assert.equal(p.state, 'prepared');
  assert.equal(p.preview.recipient.id, f.other.user.id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM direct_messages').get().n, 0);
  assert.equal(
    (await f.req('/app-functions/requests/' + p.id + '/confirm', {}, f.other.token)).status,
    404,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + p.id + '/confirm', {}, f.payload.appAccess.token))
      .status,
    401,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + p.id + '/confirm', {}, f.owner.token)).state,
    'done',
  );
  await f.req('/app-functions/requests/' + p.id + '/confirm', {}, f.owner.token);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM direct_messages').get().n, 1);
  const received = (await f.req('/notifications', undefined, f.other.token)).notifications.filter(
    (n) => n.kind === 'contact',
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].target.contactId, f.owner.user.id);
  assert.equal((await f.req('/social/unread', undefined, f.other.token)).messages, 1);
  assert.equal(
    (await f.req('/social/messages/' + f.owner.user.id, undefined, f.other.token)).messages[0]
      .content,
    'exact synthetic private message',
  );
  await f.req(
    '/mail/account',
    {
      provider: 'qq',
      address: 'synthetic@example.invalid',
      appPassword: 'private-synthetic-password',
    },
    f.owner.token,
  );
  const m = await f.invoke('mail.send', {
    to: ['recipient@example.invalid'],
    subject: 'Exact subject',
    text: 'Exact body',
  });
  assert.equal(m.state, 'prepared', JSON.stringify(m));
  assert.equal(f.sent.length, 0);
  assert.equal(m.preview.from, 'synthetic@example.invalid');
  assert.ok(!JSON.stringify(m).includes('confirmation'));
  assert.equal(
    (await f.req('/app-functions/requests/' + m.id + '/confirm', {}, f.owner.token)).state,
    'done',
  );
  assert.equal(f.sent.length, 1);
  await f.req('/app-functions/requests/' + m.id + '/confirm', {}, f.owner.token);
  assert.equal(f.sent.length, 1);
  const changed = await f.invoke('mail.send', {
    to: ['recipient@example.invalid'],
    subject: 'Changed account',
    text: 'Do not send',
  });
  await f.req(
    '/mail/account',
    { provider: 'qq', address: 'new@example.invalid', appPassword: 'other-synthetic-password' },
    f.owner.token,
  );
  assert.equal(
    (await f.req('/app-functions/requests/' + changed.id + '/confirm', {}, f.owner.token)).status,
    409,
  );
  assert.equal(f.sent.length, 1);
  assert.equal(
    (await f.req('/pi/tasks/' + f.task, undefined, f.owner.token, 'DELETE')).status,
    200,
  );
  assert.ok([403, 409].includes((await f.tool({ action: 'catalog' })).status));
});
test('learning generation from ordinary chat persists real service results, enforces limits and keeps other accounts isolated', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.invoke('learning.generate', {
        topic: '哈希表',
        level: 'beginner',
        choiceCount: 40,
        shortCount: 1,
      })
    ).status,
    400,
  );
  const p = await f.invoke('learning.generate', {
    topic: '哈希表冲突处理',
    level: 'beginner',
    choiceCount: 1,
    shortCount: 0,
  });
  assert.equal(p.state, 'done');
  assert.ok(p.result.lesson.id);
  let lesson;
  for (let i = 0; i < 100; i++) {
    const r = await f.req('/learning/lessons/' + p.result.lesson.id, undefined, f.owner.token);
    lesson = r.lesson;
    if (lesson.status !== 'generating') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(lesson.status, 'ready', lesson.error);
  assert.equal(lesson.questions.length, 1);
  assert.equal(lesson.questions[0].correctIndex, undefined);
  assert.equal(
    (await f.req('/learning/lessons/' + lesson.id, undefined, f.other.token)).status,
    404,
  );
  const graded = await f.invoke('learning.answer', {
    lessonId: lesson.id,
    questionId: 'q1',
    answer: { choiceIndex: 1 },
  });
  assert.equal(graded.state, 'done');
  assert.ok(graded.result.attempt);
  assert.equal((await f.invoke('learning.wrong')).result.items.length, 1);
  const address = { lessonId: lesson.id, questionId: 'q1' },
    editable = (await f.invoke('learning.question_read', address)).result.question;
  const { id, revision, ...question } = editable;
  const corrected = await f.invoke('learning.question_update', {
    ...address,
    revision,
    question: { ...question, correctIndex: 1, explanation: '合成勘误后的解析' },
  });
  assert.equal(corrected.state, 'done');
  assert.equal(corrected.result.question.revision, 2);
  assert.equal((await f.invoke('learning.question_history', address)).result.versions.length, 2);
  assert.equal(
    (await f.req('/learning/lessons/' + lesson.id, undefined, f.owner.token)).lesson.attempts[0]
      .score,
    0,
  );
  assert.equal(
    (
      await f.invoke('learning.answer', {
        ...address,
        questionRevision: 2,
        answer: { choiceIndex: 1 },
      })
    ).result.attempt.score,
    100,
  );
});

test('temporary side-chat retention tool reuses scoped preferences without opening or replaying a helper', async (t) => {
  const f = await fixture(t);
  const other = randomUUID(),
    stamp = new Date().toISOString();
  f.store.db
    .prepare(
      'INSERT INTO pi_conversations(owner,id,project_id,access,created_at,updated_at) VALUES(?,?,NULL,?,?,?)',
    )
    .run(f.other.user.id, other, 'read', stamp, stamp);
  const source = { origin: 'server', id: f.conversation };
  const before = f.store.db.prepare('SELECT count(*) n FROM pi_tasks').get().n;
  const read = await f.invoke('assistant.temporary_preferences', { source });
  assert.equal(read.state, 'done');
  assert.equal(read.result.ttlHours, 1);
  const changed = await f.invoke('assistant.temporary_preferences', { source, ttlHours: 24 });
  assert.equal(changed.result.ttlHours, 24);
  assert.equal(
    (await f.invoke('assistant.temporary_preferences', { source, ttlHours: 2 })).status,
    400,
  );
  assert.equal(
    (
      await f.invoke('assistant.temporary_preferences', {
        source: { origin: 'server', id: other },
        ttlHours: 6,
      })
    ).status,
    404,
  );
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM pi_tasks').get().n, before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM pi_assistance_parents').get().n, 0);
  await f.req('/pi/tasks/' + f.task, undefined, f.owner.token, 'DELETE');
  assert.ok(
    [403, 409].includes(
      (await f.invoke('assistant.temporary_preferences', { source, ttlHours: 6 })).status,
    ),
  );
});
