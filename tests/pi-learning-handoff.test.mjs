import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import appTools from '../deploy/pi/app-tools.mjs';

test('learning routing prompt separates persisted lessons from explanation-only requests', async () => {
  const source = await readFile(new URL('../deploy/pi/rpc-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /讲解并制定学习/);
  assert.match(source, /仅要求讲解、解释或讨论学习计划时不生成/);
  assert.match(source, /必须先用app_functions catalog，再invoke learning.generate/);
  assert.match(source, /默认的5道选择题、2道问答题/);
  assert.match(source, /只有lesson.status=ready才能报告课程生成完成/);
});

test('app_functions preserves its envelope and distinguishes lesson generating, ready and error', async (t) => {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.ASTRAL_APP_ACCESS_URL;
  const oldToken = process.env.ASTRAL_APP_ACCESS_TOKEN;
  process.env.ASTRAL_APP_ACCESS_URL = 'http://synthetic-app';
  process.env.ASTRAL_APP_ACCESS_TOKEN = 'synthetic';
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({
      ASTRAL_APP_ACCESS_URL: oldUrl,
      ASTRAL_APP_ACCESS_TOKEN: oldToken,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let tool;
  appTools({
    on() {},
    registerTool(value) {
      tool = value;
    },
  });
  for (const status of ['generating', 'ready', 'error']) {
    const envelope = {
      id: 'call-id',
      name: 'learning.generate',
      state: 'done',
      result: { lesson: { id: 'lesson-id', status } },
    };
    globalThis.fetch = async () => Response.json(envelope);
    const result = await tool.execute('synthetic-call', {
      action: 'invoke',
      name: 'learning.generate',
      input: { topic: 'synthetic' },
    });
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.state, 'done');
    assert.deepEqual(text.result, envelope.result);
    assert.equal(text.learning.lessonId, 'lesson-id');
    assert.equal(text.learning.status, status);
    assert.equal(text.learning.completed, status === 'ready');
    assert.equal(result.details.lessonStatus, status);
    assert.deepEqual(text.learning.query, {
      action: 'invoke',
      name: 'learning.read',
      input: { lessonId: 'lesson-id' },
    });
    if (status === 'generating') assert.match(result.details.summary, /生成中，未完成/);
    if (status === 'error') assert.equal(result.isError, true);
  }
  const plain = { id: 'plain-call', state: 'done', result: { contacts: [] } };
  globalThis.fetch = async () => Response.json(plain);
  const result = await tool.execute('plain', {
    action: 'invoke',
    name: 'contacts.list',
    input: {},
  });
  assert.deepEqual(JSON.parse(result.content[0].text), plain);
});
