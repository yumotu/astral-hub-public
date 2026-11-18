import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import {
  materialSections,
  materialLimits,
  assertLearningMessageBudget,
} from '../shared/learning-materials.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learning-materials-'));
  const calls = [];
  let gate = null,
    padding = 70,
    brokenQuiz = false;
  let brokenSection = '',
    failure = 'length';
  const adminToken = 'synthetic-learning-materials-admin-1234567890';
  const options = {
    token: adminToken,
    dataDir: dir,
    aiLimits: { perMinute: 1000 },
    aiConfig: {
      apiKey: 'synthetic',
      model: 'fake',
      fetch: async (_url, options) => {
        const request = JSON.parse(options.body),
          input = JSON.parse(request.messages[1].content);
        calls.push({ request, input });
        assertLearningMessageBudget(request.messages);
        let result;
        if (input.section) {
          if (gate) await gate;
          if (input.section.id === brokenSection)
            return Response.json({
              choices: [{ finish_reason: failure, message: { content: 'invalid' } }],
            });
          result = {
            title: '完整章节' + input.section.id,
            content:
              '# 学习目标\n' +
              '解释原理、条件、完整例子、错误及小结。'.repeat(padding) +
              input.original,
            summary: '本章阐明独立来源的概念、适用条件、例子核验与关键结论。',
          };
        } else if (request.messages[0].content.includes('出题规划者')) {
          result = {
            plan: Array.from({ length: input.choiceCount + input.shortCount }, (_, i) => ({
              slot: i + 1,
              kind: i < input.choiceCount ? 'choice' : 'short',
              objective: `目标${i + 1}独立情境的具体推理和结果核验`,
              sectionId: input.sections[i % input.sections.length].id,
            })),
          };
        } else {
          if (brokenQuiz && input.assignedTargets[0].slot === 2)
            return Response.json({
              choices: [{ finish_reason: 'length', message: { content: '{}' } }],
            });
          result = {
            questions: input.assignedTargets.map((v) => ({
              kind: v.kind,
              slot: v.slot,
              prompt: '目标情境' + v.slot,
              options: ['正确', '错误'],
              correctIndex: 0,
              explanation: '依据本章定义验证。',
            })),
          };
        }
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        });
      },
    },
  };
  let app = await createApp(options);
  const listen = () => new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await listen();
  async function request(path, data, token = '') {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = (
    await request('/auth/bootstrap', {
      username: 'materialsowner',
      displayName: 'Synthetic',
      password: 'synthetic-password',
      adminToken,
    })
  ).body;
  const invitation = (await request('/auth/invitations', {}, owner.token)).body;
  const other = (
    await request('/auth/register', {
      username: 'materialsother',
      displayName: 'Other',
      password: 'synthetic-password',
      invite: invitation.code,
    })
  ).body;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    request,
    owner,
    other,
    calls,
    db: app.store.db,
    input: (materials) => ({
      id: randomUUID(),
      topic: '合成资料课程',
      level: 'beginner',
      choiceCount: 2,
      shortCount: 0,
      materials,
    }),
    hold: () => {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    padding: (value) => {
      padding = value;
    },
    quizFailure: (value) => {
      brokenQuiz = value;
    },
    break: (id, reason = 'length') => {
      brokenSection = id;
      failure = reason;
    },
    restart: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp(options);
      await listen();
    },
  };
}

test('material segments cover long single lines and surrogate pairs without dropping a tail', () => {
  const content = 'a'.repeat(5999) + '\u{1f600}' + '尾部关键点'.repeat(1600);
  const materials = [{ name: 'same.md', content }];
  const sections = materialSections(materials);
  assert.equal(sections[0].source.end, 5999);
  assert.equal(sections.at(-1).source.end, content.length);
  assert.equal(sections.map((s) => content.slice(s.source.start, s.source.end)).join(''), content);
  for (let i = 1; i < sections.length; i++)
    assert.equal(sections[i].source.start, sections[i - 1].source.end);
  assert.throws(
    () => assertLearningMessageBudget([{ content: 'x'.repeat(materialLimits.maxMessageBytes) }]),
    /预算/,
  );
});

test('more than eight materials retain every tail, stable duplicate-name identities and private originals', async (t) => {
  const f = await fixture(t);
  const materials = Array.from({ length: 9 }, (_, i) => ({
    name: 'same.md',
    content: `# 合成章节${i}\n` + '资料内容'.repeat(20) + `PRIVATE_TAIL_${i}`,
  }));
  const input = f.input(materials);
  const generated = await f.request('/learning/lessons', input, f.owner.token);
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const lesson = generated.body.lesson;
  assert.equal(lesson.sections.length, 9);
  assert.equal(lesson.coverage.completed, 9);
  assert.equal(lesson.status, 'ready');
  assert.equal(new Set(lesson.sections.map((s) => s.source.materialId)).size, 9);
  materials.forEach((m, i) =>
    assert.ok(
      f.calls.some(
        (c) => c.input.original === m.content && c.input.original.includes(`PRIVATE_TAIL_${i}`),
      ),
    ),
  );
  const list = await f.request('/learning/lessons', undefined, f.owner.token);
  assert.doesNotMatch(JSON.stringify(list.body), /PRIVATE_TAIL_|"content"|"materials":\[/);
  assert.equal(
    (await f.request('/learning/lessons/' + input.id, undefined, f.other.token)).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        '/learning/lessons/' + input.id + '/resume',
        { id: randomUUID(), confirm: true },
        f.other.token,
      )
    ).status,
    404,
  );
  const quizCalls = f.calls.filter((c) => c.input.assignedTargets);
  assert.ok(
    quizCalls.every((c) => c.input.sectionId && !c.input.explanation.includes('PRIVATE_TAIL_8')),
  );
});

for (const reason of ['length', 'stop'])
  test(
    'incomplete chapter never becomes ready; explicit persisted resume reuses successful chapters: ' +
      reason,
    async (t) => {
      const f = await fixture(t);
      f.break('s2', reason);
      const input = f.input([{ name: 'one.txt', content: 'a'.repeat(6100) + 'END_KEY' }]);
      assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 502);
      let lesson = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token)).body
        .lesson;
      assert.equal(lesson.status, 'error');
      assert.equal(lesson.sections[0].status, 'ready');
      assert.deepEqual(lesson.questions, []);
      const before = f.calls.length;
      await f.restart();
      assert.equal(f.calls.length, before);
      f.break('');
      const operation = { id: randomUUID(), confirm: true };
      assert.equal(
        (
          await f.request(
            '/learning/lessons/' + input.id + '/resume',
            { id: randomUUID(), confirm: false },
            f.owner.token,
          )
        ).status,
        400,
      );
      const resumed = await f.request(
        '/learning/lessons/' + input.id + '/resume',
        operation,
        f.owner.token,
      );
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      assert.equal(resumed.body.lesson.status, 'ready');
      assert.equal(f.calls.filter((c) => c.input.section?.id === 's1').length, 1);
      const after = f.calls.length;
      await f.restart();
      assert.equal(
        (await f.request('/learning/lessons/' + input.id + '/resume', operation, f.owner.token))
          .status,
        200,
      );
      assert.equal(f.calls.length, after);
    },
  );

test('two successive chapter failures need distinct confirmations; the unknown original receipt never replays', async (t) => {
  const f = await fixture(t);
  const input = f.input(
    ['one', 'two', 'three'].map((content) => ({ name: content + '.txt', content })),
  );
  f.break('s2');
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 502);
  f.break('s3');
  const first = { id: randomUUID(), confirm: true };
  const path = '/learning/lessons/' + input.id + '/resume';
  assert.equal((await f.request(path, first, f.owner.token)).status, 502);
  const calls = f.calls.length;
  const replay = await f.request(path, first, f.owner.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.lesson.status, 'error');
  assert.equal(f.calls.length, calls);
  f.break('');
  const final = await f.request(path, { id: randomUUID(), confirm: true }, f.owner.token);
  assert.equal(final.status, 200);
  assert.equal(final.body.lesson.status, 'ready');
  assert.equal(final.body.lesson.coverage.completed, 3);
  assert.equal(f.calls.filter((c) => c.input.section?.id === 's1').length, 1);
  assert.equal(f.calls.filter((c) => c.input.section?.id === 's2').length, 2);
  assert.equal(f.calls.filter((c) => c.input.section?.id === 's3').length, 2);
});

test('long lessons exceed the legacy single-document ceiling without concatenating full chapters into quiz planning', async (t) => {
  const f = await fixture(t);
  f.padding(350);
  const input = f.input(
    Array.from({ length: 9 }, (_, i) => ({ name: `part${i}.md`, content: `完整资料${i}及尾部。` })),
  );
  const r = await f.request('/learning/lessons', input, f.owner.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.lesson.sections.reduce((n, s) => n + s.content.length, 0) > 50000);
  const plan = f.calls.find((c) => c.input.sections);
  assert.ok(plan.input.sections.every((s) => !s.content));
  assert.equal(plan.input.explanation, undefined);
});

test('concurrent resume operations enqueue only one job and reuse saved exercise batches', async (t) => {
  const f = await fixture(t);
  f.quizFailure(true);
  const input = f.input([
    { name: 'one.md', content: 'one' },
    { name: 'two.md', content: 'two' },
  ]);
  assert.equal((await f.request('/learning/lessons', input, f.owner.token)).status, 502);
  const before = f.calls.filter((c) => c.input.section).length;
  f.quizFailure(false);
  const op = { id: randomUUID(), confirm: true, background: true };
  const results = await Promise.all([
    f.request('/learning/lessons/' + input.id + '/resume', op, f.owner.token),
    f.request('/learning/lessons/' + input.id + '/resume', op, f.owner.token),
  ]);
  assert.ok(results.every((r) => [200, 202].includes(r.status)));
  let lesson;
  for (let i = 0; i < 100; i++) {
    lesson = (await f.request('/learning/lessons/' + input.id, undefined, f.owner.token)).body
      .lesson;
    if (lesson.status !== 'generating') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(lesson.status, 'ready');
  assert.equal(f.calls.filter((c) => c.input.section).length, before);
  assert.equal(f.calls.filter((c) => c.input.assignedTargets?.[0].slot === 1).length, 1);
  assert.equal(f.calls.filter((c) => c.input.assignedTargets?.[0].slot === 2).length, 2);
});

test('a queued material lesson already exposes its complete coverage index', async (t) => {
  const f = await fixture(t);
  const release = f.hold();
  const first = f.input([{ name: 'first.txt', content: 'first synthetic input' }]);
  const second = f.input([{ name: 'second.md', content: 'second synthetic input' }]);
  const a = await f.request('/learning/lessons', { ...first, background: true }, f.owner.token);
  assert.equal(a.status, 202);
  const b = await f.request('/learning/lessons', { ...second, background: true }, f.owner.token);
  assert.equal(b.status, 202);
  assert.equal(b.body.lesson.sections.length, 1);
  assert.equal(b.body.lesson.coverage.completed, 0);
  assert.equal(b.body.lesson.sections[0].source.materialId, 'm1');
  release();
  for (let i = 0; i < 100; i++) {
    const current = (await f.request('/learning/lessons/' + second.id, undefined, f.owner.token))
      .body.lesson;
    if (current.status !== 'generating') {
      assert.equal(current.status, 'ready');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('queued lesson did not finish');
});

test('budgets and unsupported formats fail before generation without silently taking a prefix', async (t) => {
  const f = await fixture(t);
  for (const materials of [
    [{ name: 'data.pdf', content: 'text' }],
    [{ name: 'data.txt', content: 'x'.repeat(32001) }],
    Array.from({ length: 17 }, () => ({ name: 'a.txt', content: 'x' })),
    Array.from({ length: 5 }, () => ({ name: 'a.md', content: 'x'.repeat(20000) })),
    [{ name: 'nul.txt', content: 'a\0b' }],
  ])
    assert.equal(
      (await f.request('/learning/lessons', f.input(materials), f.owner.token)).status,
      400,
    );
  assert.equal(f.calls.length, 0);
});
