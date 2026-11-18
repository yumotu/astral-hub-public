import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { learningOutputNotice } from '../server/learning-output-notice.mjs';

test('conservative learning intent excludes consultation, negation and ambiguous text', () => {
  for (const input of ['请生成学习资料', '制定一份教案', '请保存课程', '创建课程']) {
    assert.equal(learningOutputNotice(input, false).learningNotice.generated, false);
    assert.deepEqual(learningOutputNotice(input, true), {});
  }
  for (const input of [
    '讲解一下这个概念',
    '如何生成学习资料',
    '能不能创建课程',
    '介绍一下教案',
    '不要生成课程',
    '如果创建课程会怎样',
    '比如生成课程',
    '学习资料是什么？',
    '可以创建课程吗',
    '介绍生成课程的方法',
    '解释“生成学习资料”是什么意思',
  ]) {
    assert.deepEqual(learningOutputNotice(input, false), {});
  }
});

test('real task completion adds only a nonblocking notice and trusts scoped persisted generation results', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-postcheck-'));
  const token = 'synthetic-postcheck-admin-token-1234567890';
  let base;
  let proofStatus;
  const app = await createApp({
    token,
    dataDir: dir,
    notifications: { start: false },
    generateTitle: async () => 'synthetic',
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) return Response.json({ ready: true });
        const payload = JSON.parse(options.body);
        if (proofStatus) {
          const response = await fetch(base + '/api/pi/app-access', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + payload.appAccess.token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'invoke',
              name: 'learning.generate',
              input: { topic: '合成课程', choiceCount: 1, shortCount: 0 },
              callId: 'synthetic-generation',
            }),
          });
          assert.equal(response.status, 200);
          const generated = await response.json();
          assert.ok(generated.result.lesson.id);
          assert.equal(generated.result.lesson.status, 'generating');
        }
        return new Response(
          JSON.stringify({ type: 'done', output: 'synthetic answer', tools: [] }) + '\n',
          { headers: { 'Content-Type': 'application/x-ndjson' } },
        );
      },
    },
    aiConfig: {
      apiKey: '',
      model: 'synthetic',
      fetch: async () => {
        throw Error('No real model');
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const bootstrap = await fetch(base + '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'postcheck',
      displayName: 'Synthetic',
      password: 'synthetic-password-only',
      adminToken: token,
    }),
  });
  const owner = await bootstrap.json();
  async function request(path, input) {
    const response = await fetch(base + '/api' + path, {
      method: input ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    assert.ok(response.ok);
    return response.json();
  }
  for (const [input, generated, expected] of [
    ['请生成学习资料', false, true],
    ['讲解一下这个概念', false, false],
    ['如何生成课程', false, false],
    ['请生成课程', true, false],
    ['请创建课程', false, true],
  ]) {
    proofStatus = generated;
    const id = randomUUID();
    await request('/pi/tasks', { id, conversationId: randomUUID(), input });
    let task;
    for (let i = 0; i < 100; i++) {
      task = (await request('/pi/tasks')).tasks.find((task) => task.id === id);
      if (task?.status === 'done' || task?.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(task.status, 'done', task.error);
    assert.equal(task.output, 'synthetic answer');
    assert.deepEqual(task.tools, []);
    assert.equal(!!task.learningNotice, expected);
    if (expected) {
      assert.equal(task.learningNotice.expected, true);
      assert.equal(task.learningNotice.generated, false);
      const { learningNotice, ...legacy } = JSON.parse(JSON.stringify(task));
      assert.equal(legacy.status, 'done');
      assert.equal(legacy.output, 'synthetic answer');
      assert.deepEqual(legacy.tools, []);
    }
  }
});
