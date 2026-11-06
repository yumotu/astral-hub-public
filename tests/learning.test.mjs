import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { learningFixture } from './fixtures/learning.mjs';

const adminToken = 'learning-synthetic-admin-token-1234567890123456789';
const generated = learningFixture();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-learning-'));
  let replies = [
      { title: generated.title, explanation: generated.explanation },
      { questions: generated.questions },
    ],
    calls = 0;
  const options = {
    token: adminToken,
    dataDir: dir,
    aiLimits: { perMinute: 1000 },
    aiConfig: {
      apiKey: 'synthetic',
      model: 'synthetic-model',
      fetch: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body),
          input = JSON.parse(request.messages[1].content);
        assert.ok([8192, 16384].includes(request.max_tokens));
        let reply;
        if (request.messages[0].content.includes('出题规划者') && !replies[0]?.plan)
          reply = {
            plan: Array.from({ length: input.choiceCount + input.shortCount }, (_, i) => ({
              slot: i + 1,
              kind: i < input.choiceCount ? 'choice' : 'short',
              objective: `合成独立目标${i + 1}：不同情境下的推理判断`,
            })),
          };
        else reply = replies.shift();
        if (input.assignedTargets && reply?.questions)
          reply = {
            questions: reply.questions.map((q, i) => ({
              ...q,
              slot: q.slot ?? input.assignedTargets[i]?.slot,
            })),
          };
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }],
        });
      },
    },
  };
  let app = await createApp(options);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, data, token = '', method) {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  const owner = (
    await request('/auth/bootstrap', {
      username: 'learningowner',
      displayName: '学习验收',
      password: 'synthetic-learning-password',
      adminToken,
    })
  ).body;
  const invitation = (await request('/auth/invitations', {}, owner.token)).body;
  const other = (
    await request('/auth/register', {
      username: 'learningother',
      displayName: '另一账号',
      password: 'synthetic-learning-password',
      invite: invitation.code,
    })
  ).body;
  const input = {
    id: randomUUID(),
    topic: '哈希表冲突处理',
    level: 'beginner',
    choiceCount: 1,
    shortCount: 1,
  };
  return {
    db: app.store.db,
    request,
    owner,
    other,
    input,
    replies: (values) => {
      replies = values;
    },
    calls: () => calls,
    restart: async () => {
      await new Promise((r) => app.server.close(r));
      app = await createApp(options);
      await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    },
  };
}

test('question edits validate answers, preserve historical grades and reject stale versions across accounts', async (t) => {
  const f = await fixture(t),
    lesson = (await f.request('/learning/lessons', f.input, f.owner.token)).body.lesson;
  const path = '/learning/lessons/' + lesson.id + '/questions/q1';
  const read = await f.request(path, undefined, f.owner.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.question.revision, 1);
  assert.equal(read.body.question.correctIndex, 0);
  assert.equal((await f.request(path, undefined, f.other.token)).status, 404);
  assert.equal((await f.request(path, undefined, adminToken)).status, 403);
  const before = await f.request(
    '/learning/attempts',
    {
      id: randomUUID(),
      lessonId: lesson.id,
      questionId: 'q1',
      questionRevision: 1,
      answer: { choiceIndex: 0 },
    },
    f.owner.token,
  );
  assert.equal(before.status, 201);
  assert.equal(before.body.attempt.score, 100);
  const { id, revision, ...question } = read.body.question;
  const edit = {
    revision,
    question: {
      ...question,
      prompt: '勘误：正确计算结果是哪一项？',
      options: ['763ms', '907.2ms'],
      correctIndex: 1,
      explanation: '0.18×120 + 0.82×1080 = 907.2ms。',
    },
  };
  assert.equal(
    (
      await f.request(
        path,
        { ...edit, question: { ...edit.question, correctIndex: 5 } },
        f.owner.token,
        'PATCH',
      )
    ).status,
    400,
  );
  const changed = await f.request(path, edit, f.owner.token, 'PATCH');
  assert.equal(changed.status, 200);
  assert.equal(changed.body.question.revision, 2);
  assert.equal((await f.request(path, edit, f.owner.token, 'PATCH')).status, 409);
  assert.equal(
    (await f.request(path, { ...edit, revision: 2 }, f.other.token, 'PATCH')).status,
    404,
  );
  const stale = await f.request(
    '/learning/attempts',
    {
      id: randomUUID(),
      lessonId: lesson.id,
      questionId: 'q1',
      questionRevision: 1,
      answer: { choiceIndex: 0 },
    },
    f.owner.token,
  );
  assert.equal(stale.status, 409);
  const after = await f.request(
    '/learning/attempts',
    {
      id: randomUUID(),
      lessonId: lesson.id,
      questionId: 'q1',
      questionRevision: 2,
      answer: { choiceIndex: 0 },
    },
    f.owner.token,
  );
  assert.equal(after.body.attempt.score, 0);
  assert.equal(after.body.attempt.questionRevision, 2);
  const detail = (await f.request('/learning/lessons/' + lesson.id, undefined, f.owner.token)).body
    .lesson;
  assert.equal(detail.attempts[0].score, 100);
  assert.equal(detail.attempts[0].questionRevision, 1);
  assert.equal(detail.attempts[0].correctIndex, 0);
  assert.equal(detail.questions[0].revision, 2);
  assert.equal(detail.questions[0].correctIndex, undefined);
  const history = await f.request(path + '/history', undefined, f.owner.token);
  assert.deepEqual(
    history.body.versions.map((v) => v.revision),
    [2, 1],
  );
  await f.restart();
  assert.equal((await f.request(path, undefined, f.owner.token)).body.question.revision, 2);
});

test('short-answer edits replace future rubric without changing old AI feedback or the question kind', async (t) => {
  const f = await fixture(t),
    lesson = (await f.request('/learning/lessons', f.input, f.owner.token)).body.lesson,
    path = '/learning/lessons/' + lesson.id + '/questions/q2';
  f.replies([{ score: 72, feedback: '原评分反馈' }]);
  const submitted = await f.request(
    '/learning/attempts',
    { id: randomUUID(), lessonId: lesson.id, questionId: 'q2', answer: { text: '我的原答案' } },
    f.owner.token,
  );
  assert.equal(submitted.status, 201);
  const q = (await f.request(path, undefined, f.owner.token)).body.question;
  const { id, revision, ...data } = q;
  assert.equal(
    (await f.request(path, { revision, question: generated.questions[0] }, f.owner.token, 'PATCH'))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        path,
        {
          revision,
          question: {
            ...data,
            referenceAnswer: '新的严格参考答案',
            rubric: ['定义与分母', '计算与解释'],
            explanation: '修正后的具体解析',
          },
        },
        f.owner.token,
        'PATCH',
      )
    ).status,
    200,
  );
  const old = (await f.request('/learning/lessons/' + lesson.id, undefined, f.owner.token)).body
    .lesson.attempts[0];
  assert.equal(old.feedback, '原评分反馈');
  assert.equal(old.referenceAnswer, q.referenceAnswer);
  assert.equal(old.score, 72);
});

test('learning generation is authenticated, account-scoped, idempotent and hides quiz answers', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/learning/lessons')).status, 401);
  assert.equal((await f.request('/learning/lessons', f.input, adminToken)).status, 403);
  const created = await f.request('/learning/lessons', f.input, f.owner.token);
  assert.equal(created.status, 201);
  assert.equal(created.body.lesson.questions.length, 2);
  assert.doesNotMatch(
    JSON.stringify(created.body.lesson.questions),
    /correctIndex|referenceAnswer|rubric|explanation/,
  );
  assert.equal((await f.request('/learning/lessons', f.input, f.owner.token)).status, 200);
  assert.equal(f.calls(), 2);
  assert.equal(
    (await f.request('/learning/lessons', { ...f.input, topic: '不同主题' }, f.owner.token)).status,
    409,
  );
  assert.equal(
    (await f.request('/learning/lessons/' + f.input.id, undefined, f.other.token)).status,
    404,
  );
  assert.deepEqual(
    (await f.request('/learning/lessons', undefined, f.other.token)).body.lessons,
    [],
  );
  assert.equal(
    (
      await f.request(
        '/learning/lessons',
        { ...f.input, id: randomUUID(), admin: true },
        f.owner.token,
      )
    ).status,
    400,
  );
});

test('choice grading persists wrong answers and review progress exactly once, without model grading', async (t) => {
  const f = await fixture(t);
  const lesson = (await f.request('/learning/lessons', f.input, f.owner.token)).body.lesson;
  const submission = {
    id: randomUUID(),
    lessonId: lesson.id,
    questionId: 'q1',
    answer: { choiceIndex: 1 },
  };
  const result = await f.request('/learning/attempts', submission, f.owner.token);
  assert.equal(result.status, 201);
  assert.equal(result.body.attempt.score, 0);
  assert.equal(result.body.attempt.correctIndex, 0);
  assert.equal(f.calls(), 2);
  assert.equal((await f.request('/learning/attempts', submission, f.owner.token)).status, 200);
  assert.equal(
    (
      await f.request(
        '/learning/attempts',
        { ...submission, answer: { choiceIndex: 0 } },
        f.owner.token,
      )
    ).status,
    409,
  );
  let wrong = (await f.request('/learning/wrong', undefined, f.owner.token)).body.items;
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].wrongCount, 1);
  assert.deepEqual((await f.request('/learning/wrong', undefined, f.other.token)).body.items, []);
  assert.equal(
    (await f.request('/learning/attempts', { ...submission, id: randomUUID() }, f.other.token))
      .status,
    404,
  );
  const corrected = await f.request(
    '/learning/attempts',
    { ...submission, id: randomUUID(), answer: { choiceIndex: 0 } },
    f.owner.token,
  );
  assert.equal(corrected.body.attempt.score, 100);
  assert.equal(f.calls(), 2);
  assert.equal((await f.request('/learning/wrong', undefined, f.owner.token)).body.items.length, 0);
  wrong = (await f.request('/learning/wrong?resolved=include', undefined, f.owner.token)).body
    .items;
  assert.equal(wrong[0].resolved, true);
  assert.equal(wrong[0].reviewCount, 2);
  assert.equal(
    (await f.request('/learning/lessons/' + lesson.id, undefined, f.owner.token)).body.lesson
      .attempts.length,
    2,
  );
});

test('short-answer grading uses the stored rubric and rejects malformed AI results without false completion', async (t) => {
  const f = await fixture(t);
  await f.request('/learning/lessons', f.input, f.owner.token);
  f.replies([{ score: 65, feedback: '已经解释比值，请补充冲突增多对查找性能的影响。' }]);
  const input = {
    id: randomUUID(),
    lessonId: f.input.id,
    questionId: 'q2',
    answer: { text: '负载因子是元素数和桶数的比值。' },
  };
  const result = await f.request('/learning/attempts', input, f.owner.token);
  assert.equal(result.status, 201);
  assert.equal(result.body.attempt.score, 65);
  assert.equal(result.body.attempt.method, 'ai');
  assert.match(result.body.attempt.referenceAnswer, /冲突/);
  assert.equal((await f.request('/learning/attempts', input, f.owner.token)).status, 200);
  assert.equal(f.calls(), 3);
  f.replies([{ score: 999, feedback: '无效评分' }]);
  assert.equal(
    (await f.request('/learning/attempts', { ...input, id: randomUUID() }, f.owner.token)).status,
    502,
  );
  assert.equal(
    (await f.request('/learning/wrong', undefined, f.owner.token)).body.items[0].wrongCount,
    1,
  );
  assert.equal(
    (
      await f.request(
        '/learning/attempts',
        { ...input, id: randomUUID(), answer: { choiceIndex: 0 } },
        f.owner.token,
      )
    ).status,
    400,
  );
});

test('learning history, grading and wrong-answer review survive server restart', async (t) => {
  const f = await fixture(t);
  await f.request('/learning/lessons', f.input, f.owner.token);
  await f.request(
    '/learning/attempts',
    { id: randomUUID(), lessonId: f.input.id, questionId: 'q1', answer: { choiceIndex: 1 } },
    f.owner.token,
  );
  await f.restart();
  const lesson = (await f.request('/learning/lessons/' + f.input.id, undefined, f.owner.token)).body
    .lesson;
  assert.equal(lesson.title, generated.title);
  assert.equal(lesson.attempts.length, 1);
  assert.equal(
    (await f.request('/learning/wrong', undefined, f.owner.token)).body.items[0].wrongCount,
    1,
  );
  assert.deepEqual(
    (await f.request('/learning/lessons', undefined, f.other.token)).body.lessons,
    [],
  );
});

test('invalid or mismatched generated quizzes never become completed lessons or silently retry', async (t) => {
  const f = await fixture(t);
  f.replies([
    { title: generated.title, explanation: generated.explanation },
    { questions: [generated.questions[0]] },
  ]);
  assert.equal((await f.request('/learning/lessons', f.input, f.owner.token)).status, 502);
  assert.equal((await f.request('/learning/lessons', f.input, f.owner.token)).status, 409);
  assert.equal(f.calls(), 2);
  assert.equal(
    (await f.request('/learning/lessons/' + f.input.id, undefined, f.owner.token)).body.lesson
      .status,
    'error',
  );
  assert.equal(
    (await f.request('/learning/lessons', undefined, f.owner.token)).body.lessons[0].status,
    'error',
  );
});

test('older learning history is paginated without truncation or cross-account cursors', async (t) => {
  const f = await fixture(t);
  await f.request('/learning/lessons', f.input, f.owner.token);
  const original = f.db.prepare('SELECT * FROM learning_lessons WHERE id=?').get(f.input.id);
  for (let i = 0; i < 101; i++) {
    const id = randomUUID(),
      input = { ...f.input, id };
    f.db
      .prepare('INSERT INTO learning_lessons VALUES(?,?,?,?,?,?,?)')
      .run(
        original.owner,
        id,
        JSON.stringify(input),
        'ready',
        original.data,
        null,
        new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      );
  }
  const first = (await f.request('/learning/lessons', undefined, f.owner.token)).body;
  assert.equal(first.lessons.length, 100);
  assert.ok(first.next);
  const second = (
    await f.request('/learning/lessons?before=' + first.next, undefined, f.owner.token)
  ).body;
  assert.equal(second.lessons.length, 2);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.lessons, ...second.lessons].map((l) => l.id)).size, 102);
  assert.equal(
    (await f.request('/learning/lessons?before=' + first.next, undefined, f.other.token)).status,
    404,
  );
});

test('wrong-answer pages retain older exercises and reject another account cursor', async (t) => {
  const f = await fixture(t);
  await f.request('/learning/lessons', f.input, f.owner.token);
  const original = f.db.prepare('SELECT * FROM learning_lessons WHERE id=?').get(f.input.id);
  for (let i = 0; i < 201; i++) {
    const id = randomUUID(),
      attemptId = randomUUID(),
      at = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
    f.db
      .prepare('INSERT INTO learning_lessons VALUES(?,?,?,?,?,?,?)')
      .run(
        original.owner,
        id,
        JSON.stringify({ ...f.input, id }),
        'ready',
        original.data,
        null,
        at,
      );
    const result = {
      id: attemptId,
      lessonId: id,
      questionId: 'q1',
      score: 0,
      passed: false,
      method: 'exact',
      answer: { choiceIndex: 1 },
      correctIndex: 0,
      feedback: '合成错题',
      explanation: '合成解析',
      createdAt: at,
    };
    f.db
      .prepare('INSERT INTO learning_attempts VALUES(?,?,?,?,?,?,?,?)')
      .run(original.owner, attemptId, id, 'q1', '{}', 'done', JSON.stringify(result), at);
    f.db
      .prepare('INSERT INTO learning_wrong VALUES(?,?,?,?,?,?,?,?)')
      .run(original.owner, id, 'q1', attemptId, 1, 1, 0, at);
  }
  const first = (await f.request('/learning/wrong', undefined, f.owner.token)).body;
  assert.equal(first.items.length, 200);
  assert.ok(first.next);
  const second = (await f.request('/learning/wrong?before=' + first.next, undefined, f.owner.token))
    .body;
  assert.equal(second.items.length, 1);
  assert.equal(second.next, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((w) => w.lessonId + w.questionId)).size,
    201,
  );
  assert.equal(
    (await f.request('/learning/wrong?before=' + first.next, undefined, f.other.token)).status,
    404,
  );
});

test('learning accepts twenty and forty questions in batches, reports progress and keeps answers private', async (t) => {
  const f = await fixture(t);
  const long = learningFixture(20, 20);
  f.replies([
    { title: long.title, explanation: long.explanation },
    ...[
      long.questions.slice(0, 8),
      long.questions.slice(8, 16),
      long.questions.slice(16, 20),
      long.questions.slice(20, 28),
      long.questions.slice(28, 36),
      long.questions.slice(36),
    ].map((questions) => ({ questions })),
  ]);
  const input = { ...f.input, choiceCount: 20, shortCount: 20, background: true };
  const accepted = await f.request('/learning/lessons', input, f.owner.token);
  assert.equal(accepted.status, 202);
  assert.ok(
    [200, 202].includes((await f.request('/learning/lessons', input, f.owner.token)).status),
  );
  let lesson;
  for (let i = 0; i < 100; i++) {
    lesson = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token)).body
      .lesson;
    if (lesson.status !== 'generating') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(lesson.status, 'ready');
  assert.equal(lesson.progress.completed, 40);
  assert.equal(lesson.questions.length, 40);
  assert.equal(lesson.questions.at(-1).id, 'q40');
  assert.doesNotMatch(JSON.stringify(lesson.questions), /correctIndex|referenceAnswer|rubric/);
  assert.equal(f.calls(), 8);
  const twenty = learningFixture(20, 0);
  f.replies([
    { title: twenty.title, explanation: twenty.explanation },
    ...Array.from({ length: 3 }, (_, i) => ({
      questions: twenty.questions.slice(i * 8, i * 8 + 8),
    })),
  ]);
  const second = await f.request(
    '/learning/lessons',
    { ...f.input, id: randomUUID(), choiceCount: 20, shortCount: 0 },
    f.owner.token,
  );
  assert.equal(second.status, 201);
  assert.equal(second.body.lesson.questions.length, 20);
  assert.equal(f.calls(), 13);
  const attempt = await f.request(
    '/learning/attempts',
    { id: randomUUID(), lessonId: input.id, questionId: 'q40', answer: { text: '测试答案' } },
    f.other.token,
  );
  assert.equal(attempt.status, 404);
  assert.equal(
    (
      await f.request(
        '/learning/lessons',
        { ...input, id: randomUUID(), shortCount: 21 },
        f.owner.token,
      )
    ).status,
    400,
  );
});

test('learning ceiling is persistent and writable only by an independent administrator', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request('/learning/settings', undefined, f.other.token)).body.maxQuestions,
    40,
  );
  assert.equal(
    (await f.request('/learning/settings', { maxQuestions: 20 }, f.other.token, 'PUT')).status,
    403,
  );
  assert.equal(
    (await f.request('/learning/settings', { maxQuestions: 20 }, adminToken, 'PUT')).status,
    403,
  );
  assert.equal(
    (await f.request('/learning/settings', { maxQuestions: 20 }, f.owner.token, 'PUT')).status,
    200,
  );
  await f.restart();
  assert.equal(
    (await f.request('/learning/settings', undefined, f.other.token)).body.maxQuestions,
    20,
  );
  assert.equal(
    (
      await f.request(
        '/learning/lessons',
        { ...f.input, choiceCount: 21, shortCount: 0 },
        f.owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/learning/settings', { maxQuestions: 0 }, f.owner.token, 'PUT')).status,
    400,
  );
  assert.equal(
    (await f.request('/learning/settings', { maxQuestions: 21, extra: true }, f.owner.token, 'PUT'))
      .status,
    400,
  );
});

test('partial batches and interrupted generation stay honest and never replay a request', async (t) => {
  const f = await fixture(t),
    lesson = learningFixture(9, 0);
  f.replies([
    { title: lesson.title, explanation: lesson.explanation },
    { questions: lesson.questions.slice(0, 8) },
    { questions: lesson.questions.slice(0, 1) },
  ]);
  const input = { ...f.input, choiceCount: 9, shortCount: 0 };
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 502);
  const partial = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token)).body
    .lesson;
  assert.equal(partial.status, 'error');
  assert.equal(partial.progress.completed, 8);
  assert.equal(partial.questions.length, 0);
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 409);
  assert.equal(f.calls(), 5);
  f.db.prepare("UPDATE learning_lessons SET status='generating' WHERE id=?").run(input.id);
  await f.restart();
  const interrupted = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token))
    .body.lesson;
  assert.equal(interrupted.status, 'error');
  assert.match(interrupted.error, /中断/);
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 409);
  assert.equal(f.calls(), 5);
});

test('duplicate questions are repaired from known output without replaying valid batches', async (t) => {
  const f = await fixture(t),
    lesson = learningFixture(9, 0);
  f.replies([
    { title: lesson.title, explanation: lesson.explanation },
    { questions: lesson.questions.slice(0, 8) },
    { questions: lesson.questions.slice(0, 1) },
    { questions: lesson.questions.slice(8) },
  ]);
  const r = await f.request(
    '/learning/lessons',
    { ...f.input, choiceCount: 9, shortCount: 0 },
    f.owner.token,
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.lesson.questions.length, 9);
  assert.equal(new Set(r.body.lesson.questions.map((q) => q.prompt)).size, 9);
  assert.equal(f.calls(), 5);
});

test('large quizzes reject an invalid coverage plan before generating exercises', async (t) => {
  const f = await fixture(t),
    lesson = learningFixture(9, 0);
  f.replies([
    { title: lesson.title, explanation: lesson.explanation },
    {
      plan: Array.from({ length: 9 }, (_, i) => ({
        slot: i + 1,
        kind: 'choice',
        objective: '每一项都重复同一个目标',
      })),
    },
  ]);
  const input = { ...f.input, choiceCount: 9, shortCount: 0 };
  const r = await f.request('/learning/lessons', input, f.owner.token);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /蓝图/);
  assert.equal(f.calls(), 2);
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 409);
  assert.equal(f.calls(), 2);
});

test('a batch cannot substitute another slot or expose answers from an incomplete quiz', async (t) => {
  const f = await fixture(t),
    lesson = learningFixture(9, 0);
  f.replies([
    { title: lesson.title, explanation: lesson.explanation },
    { questions: lesson.questions.slice(0, 8).map((q, i) => ({ ...q, slot: i ? i + 1 : 9 })) },
  ]);
  const input = { ...f.input, choiceCount: 9, shortCount: 0 };
  const r = await f.request('/learning/lessons', input, f.owner.token);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /蓝图/);
  const saved = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token)).body
    .lesson;
  assert.equal(saved.status, 'error');
  assert.deepEqual(saved.questions, []);
  assert.equal(saved.progress.completed, 0);
});
