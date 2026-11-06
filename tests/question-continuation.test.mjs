import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { askUserTitle, extensionUiRequest } from '../deploy/pi/rpc-prompt.mjs';
import { validQuestionContinuation, questionPrompt } from '../deploy/pi/question-continuation.mjs';
import { questionReplySchema, questionContinuation } from '../server/question-continuation.mjs';
import { createPiTasks } from '../server/pi-tasks.mjs';

function question() {
  return {
    id: randomUUID(),
    source: 'ask_user',
    questionId: randomUUID(),
    toolCallId: 'tool-' + randomUUID(),
    method: 'input',
    title: '需要你选择处理范围',
    message: '保留这个问题的上下文',
    status: 'pending',
  };
}
test('only tagged ask_user dialogs preserve their full question and context for continuation', () => {
  const data = {
    questionId: randomUUID(),
    toolCallId: 'original-tool',
    question: '问'.repeat(1000),
    context: '解释'.repeat(1500),
  };
  const e = {
    type: 'extension_ui_request',
    id: randomUUID(),
    method: 'input',
    title: askUserTitle(data),
  };
  const d = extensionUiRequest(e);
  assert.equal(d.source, 'ask_user');
  assert.equal(d.title, data.question);
  assert.equal(d.message, data.context);
  assert.equal(d.questionId, data.questionId);
  assert.equal(extensionUiRequest({ ...e, method: 'confirm' }).source, undefined);
  assert.equal(
    extensionUiRequest({
      ...e,
      title: 'Native plugin request',
      source: 'ask_user',
      questionId: data.questionId,
    }).source,
    undefined,
  );
  assert.equal(
    extensionUiRequest({ ...e, title: '[astral-question:invalid]\nQuestion' }).source,
    undefined,
  );
});
test('explicit question answers have stable task identities, bounded metadata and no approval or command interpretation', () => {
  const q = question(),
    task = { id: randomUUID(), status: 'interrupted', input: 'Original task', uiRequests: [q] };
  const reply = { id: q.id, value: '/long-goal This is an answer, not a command' };
  const next = questionContinuation('owner', task, reply);
  assert.equal(questionContinuation('owner', task, reply).id, next.id);
  assert.notEqual(questionContinuation('other', task, reply).id, next.id);
  assert.ok(validQuestionContinuation(next.resumeQuestion));
  assert.ok(!questionPrompt(reply.value, next.resumeQuestion).startsWith('/'));
  assert.match(questionPrompt(reply.value, next.resumeQuestion), /不能.*恢复扩大|不能通过恢复扩大/);
  assert.equal(questionReplySchema.safeParse({ ...reply, confirmed: true }).success, false);
  assert.equal(questionReplySchema.safeParse({ ...reply, execute: true }).success, false);
  assert.equal(questionReplySchema.safeParse({ ...reply, value: 'x'.repeat(4001) }).success, false);
  for (const bad of [
    { status: 'cancelled' },
    { uiRequests: [{ ...q, method: 'confirm' }] },
    { uiRequests: [{ ...q, source: undefined }] },
    { uiRequests: [{ ...q, status: 'responding' }] },
  ])
    assert.throws(() => questionContinuation('owner', { ...task, ...bad }, reply), /只有/);
  const linked = {
    ...task,
    uiRequests: [{ ...q, status: 'resolved', continuedAs: next.id, answerHash: next.answerHash }],
  };
  assert.equal(questionContinuation('owner', linked, reply).reused, true);
  assert.throws(
    () => questionContinuation('owner', linked, { ...reply, value: 'different' }),
    /其他答案/,
  );
});
test('server restart requires an explicit answer and atomically admits only one scope-preserving continuation', async () => {
  const db = new DatabaseSync(':memory:'),
    q = question(),
    owner = randomUUID(),
    id = randomUUID(),
    conversationId = randomUUID();
  let emit, unblock;
  const first = createPiTasks(db, {
    available: () => true,
    completed: () => null,
    run: async (_owner, _p, event) => {
      emit = event;
      await new Promise((resolve) => (unblock = resolve));
      return { output: 'old should stay interrupted' };
    },
  });
  const payload = {
    id,
    conversationId,
    input: 'Original exact task',
    projectId: 'alpha',
    access: 'read',
    thinkingLevel: 'high',
    attachments: [],
    toolAllowlist: ['ask_user', 'project_read'],
    mode: 'queue',
  };
  first.add(owner, payload);
  for (let i = 0; i < 30 && !emit; i++) await new Promise((resolve) => setImmediate(resolve));
  emit({ type: 'extension_ui_request', ...q });
  first.close();
  let preparations = 0;
  const restarted = createPiTasks(db, {
    available: () => false,
    completed: () => null,
    run: async () => {
      throw Error('must wait for explicit continuation');
    },
    prepareQuestionResume: async (_owner, original) => {
      assert.equal(original.id, id);
      preparations++;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  try {
    assert.equal(restarted.get(owner, id).status, 'interrupted');
    assert.equal(restarted.all(owner).length, 1);
    const reply = { id: q.id, value: 'Only inspect the README' };
    const [a, b] = await Promise.all([
      restarted.resumeQuestion(owner, id, reply),
      restarted.resumeQuestion(owner, id, reply),
    ]);
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, id);
    assert.equal(a.input, reply.value);
    assert.equal(a.status, 'queued');
    for (const key of ['projectId', 'access', 'thinkingLevel', 'attachments', 'toolAllowlist'])
      assert.deepEqual(a[key], payload[key]);
    assert.equal(restarted.all(owner).length, 2);
    assert.ok(preparations >= 1);
    assert.equal(restarted.get(owner, id).status, 'interrupted');
    assert.equal(restarted.get(owner, id).uiRequests[0].status, 'resolved');
    assert.equal((await restarted.resumeQuestion(owner, id, reply)).id, a.id);
    await assert.rejects(
      restarted.resumeQuestion(owner, id, { ...reply, value: 'A different answer' }),
      /其他答案/,
    );
    await assert.rejects(restarted.resumeQuestion(randomUUID(), id, reply), /不存在/);
    restarted.close();
    const again = createPiTasks(db, {
      available: () => false,
      completed: () => null,
      run: async () => {},
    });
    assert.equal(
      again.get(owner, a.id).status,
      'queued',
      'a committed, never-started continuation was mistaken for an unknown old execution',
    );
    again.close();
  } finally {
    restarted.close();
    unblock?.();
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
  }
});
test('denied or competing server continuation leaves the old question unanswered', async () => {
  const db = new DatabaseSync(':memory:'),
    q = question(),
    owner = randomUUID(),
    id = randomUUID(),
    conversationId = randomUUID();
  const runner = createPiTasks(db, {
    available: () => false,
    completed: () => null,
    run: async () => {},
    prepareQuestionResume: async () => {
      throw Object.assign(Error('Project access revoked'), { status: 403 });
    },
  });
  runner.add(owner, {
    id,
    conversationId,
    input: 'Original',
    projectId: 'alpha',
    access: 'edit',
    mode: 'queue',
  });
  const row = db.prepare('SELECT state FROM pi_tasks WHERE id=?').get(id);
  db.prepare('UPDATE pi_tasks SET state=? WHERE id=?').run(
    JSON.stringify({ ...JSON.parse(row.state), status: 'interrupted', uiRequests: [q] }),
    id,
  );
  try {
    await assert.rejects(
      runner.resumeQuestion(owner, id, { id: q.id, value: 'answer' }),
      /revoked/,
    );
    assert.equal(runner.get(owner, id).uiRequests[0].status, 'pending');
    assert.equal(runner.all(owner).length, 1);
    runner.add(owner, {
      id: randomUUID(),
      conversationId,
      input: 'Other queued task',
      mode: 'queue',
    });
    await assert.rejects(
      runner.resumeQuestion(owner, id, { id: q.id, value: 'answer' }),
      /运行中或结果未知/,
    );
  } finally {
    runner.close();
    db.close();
  }
});
