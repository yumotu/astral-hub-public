import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { generateTarotQuestions } from '../shared/tarot-questions.mjs';
import { tarotQuestions } from '../web/src/ai.ts';
const questions = [
  '今天我可以怎样照顾自己的感受？',
  '面对改变，我能先做好哪一步？',
  '怎样更清楚地表达自己的需要？',
];
const completion = (value) =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
  });
test('tarot recommendations request 2-3 distinct AI questions and carry only previous recommendations', async () => {
  const calls = [];
  const config = {
    apiKey: 'mock-secret',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return completion({ questions });
    },
  };
  assert.deepEqual(await generateTarotQuestions(config, { previous: questions.slice(0, 2) }), {
    questions,
  });
  assert.deepEqual(await generateTarotQuestions(config), { questions });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].messages[1].content).previous, questions.slice(0, 2));
  assert.notEqual(
    JSON.parse(calls[0].messages[1].content).request,
    JSON.parse(calls[1].messages[1].content).request,
  );
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.equal(JSON.stringify(calls).includes('mock-secret'), false);
  for (const value of [
    { questions: [] },
    { questions: [questions[0]] },
    { questions: [questions[0], questions[0]] },
    { questions: [...questions, '第四个问题？'] },
    { questions, unexpected: true },
  ]) {
    await assert.rejects(
      generateTarotQuestions({ ...config, fetch: async () => completion(value) }),
      /推荐问题格式/,
    );
  }
});
test('tarot recommendations use the selected device/server route without disclosing device keys to the server', async (t) => {
  const settings = {
    url: 'https://sync.example.com',
    token: 'sync-token',
    apiKey: 'device-private',
    model: 'deepseek-flash',
    aiMode: 'local',
  };
  let destination,
    serverMode = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    destination = String(url);
    if (serverMode) {
      assert.equal(JSON.stringify(options).includes('device-private'), false);
      return Response.json({ questions });
    }
    const content = JSON.parse(options.body);
    assert.equal(JSON.stringify(content).includes('sync-token'), false);
    return completion({ questions });
  });
  assert.deepEqual(await tarotQuestions(settings), { questions });
  assert.equal(destination, 'https://api.deepseek.com/chat/completions');
  serverMode = true;
  assert.deepEqual(await tarotQuestions({ ...settings, aiMode: 'server' }), { questions });
  assert.equal(destination, 'https://sync.example.com/api/tarot/questions');
});
test('tarot recommendation endpoint authenticates, validates input and uses the bounded AI gateway', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-tarot-questions-'));
  const token = 'synthetic-tarot-token-'.repeat(3);
  let count = 0;
  const app = await createApp({
    token,
    dataDir: dir,
    aiConfig: {
      apiKey: 'server-private',
      model: 'deepseek-flash',
      fetch: async () => {
        count++;
        return completion({ questions });
      },
    },
    aiLimits: { perMinute: 1 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.server.address().port + '/api/tarot/questions';
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const request = (data, auth = true) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(data),
    });
  assert.equal((await request({}, false)).status, 401);
  assert.equal((await request({ apiKey: 'injected' })).status, 400);
  const response = await request({ previous: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { questions });
  assert.equal(count, 1);
  assert.equal((await request({})).status, 429);
  assert.equal(count, 1);
});
