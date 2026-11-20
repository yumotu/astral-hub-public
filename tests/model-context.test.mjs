import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModelContext,
  configureContext,
  contextCompaction,
} from '../deploy/pi/model-context.mjs';

const offered = (window = 1048576) => ({
  data: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      context_window: window,
      max_output_tokens: 393216,
      input_modalities: ['text', 'image'],
    },
  ],
});
const key = 'a'.repeat(64),
  other = 'b'.repeat(64);
async function setup(t, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'astral-model-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, model: 'deepseek-flash', apiKey: 'private-test-key', fetchImpl };
  return { options, service: createModelContext(options) };
}
test('model API determines the real window; changes persist per conversation and clamp to a smaller provider limit', async (t) => {
  let calls = 0,
    data = offered();
  const { options, service } = await setup(t, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    return Response.json(data);
  });
  const [state, parallel] = await Promise.all([service.get(key), service.get(other)]);
  assert.equal(calls, 1);
  assert.equal(state.contextWindow, 1048576);
  assert.equal(state.maxContextWindow, 1048576);
  assert.equal(parallel.source, 'api');
  assert.equal(state.requestedContextWindow, null);
  assert.equal((await service.set(key, 131072)).contextWindow, 131072);
  assert.equal((await service.get(other)).contextWindow, 1048576);
  const restarted = createModelContext(options);
  assert.equal((await restarted.get(key)).contextWindow, 131072);
  for (const invalid of [0, -1, 1.5, 16383, 1048577, '131072', NaN])
    await assert.rejects(service.set(key, invalid), { status: 400 });
  await assert.rejects(service.get('../../outside'), { status: 400 });
  data = offered(65536);
  const lowered = await service.get(key, { refresh: true });
  assert.equal(lowered.contextWindow, 65536);
  assert.equal(lowered.requestedContextWindow, 131072);
  assert.equal((await service.set(key, null)).requestedContextWindow, null);
  assert.equal((await service.get(key)).contextWindow, 65536);
});
test('missing metadata and network failure never invent a 1M capacity; verified cache is identified', async (t) => {
  let mode = 'missing';
  const { options, service } = await setup(t, async () => {
    if (mode === 'offline') throw new Error('must not expose provider details');
    return Response.json(mode === 'missing' ? { data: [{ id: 'deepseek-flash' }] } : offered());
  });
  const unknown = await service.get(key);
  assert.equal(unknown.maxContextWindow, null);
  assert.equal(unknown.source, 'unavailable');
  assert.equal(unknown.contextWindow, 64000);
  await assert.rejects(service.set(key, 1048576), { status: 503 });
  mode = 'valid';
  const known = await service.get(key, { refresh: true });
  assert.equal(known.maxContextWindow, 1048576);
  mode = 'offline';
  const cached = await createModelContext(options).get(key);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.maxContextWindow, 1048576);
  assert.equal(cached.fetchedAt, known.fetchedAt);
  assert.match(cached.warning, /缓存/);
  assert.doesNotMatch(JSON.stringify(cached), /private-test-key|provider details/);
});
test('invalid or absent model is not mistaken for a valid provider capacity', async (t) => {
  let data = { data: [{ id: 'other-model', context_window: 1048576 }] };
  const { service } = await setup(t, async () => Response.json(data));
  assert.equal((await service.get(key)).maxContextWindow, null);
  for (const invalid of [0, -1, 2.5, '1048576', 1e20]) {
    data = offered(invalid);
    assert.equal((await service.get(key, { refresh: true })).maxContextWindow, null);
  }
});
test('production output budget allows deep reasoning and remains capped by API and working window', async () => {
  const template = JSON.parse(await readFile(new URL('../deploy/pi/models.json', import.meta.url), 'utf8')).providers['astral-deepseek'].models[0];
  const configured = configureContext(template, { contextWindow: 1048576, maxOutputTokens: 393216 });
  assert.equal(configured.maxTokens, 131072);
  assert.equal(configureContext(template, { contextWindow: 1048576, maxOutputTokens: 16384 }).maxTokens, 16384);
  assert.equal(configureContext(template, { contextWindow: 16384, maxOutputTokens: 393216 }).maxTokens, 4096);
  assert.equal(contextCompaction(1048576, {}, configured.maxTokens).reserveTokens, 131072);
});
test('runtime model and compaction use selected size while preserving output and model settings', () => {
  const template = {
    id: 'deepseek-flash',
    contextWindow: 64000,
    maxTokens: 3000,
    input: ['text'],
    compat: { supportsStore: false },
  };
  const updated = configureContext(template, {
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    inputModalities: ['text', 'image'],
  });
  assert.equal(updated.contextWindow, 1048576);
  assert.equal(updated.maxTokens, 3000);
  assert.deepEqual(updated.input, ['text', 'image']);
  assert.equal(template.contextWindow, 64000);
  assert.equal(updated.compat.supportsStore, false);
  const small = contextCompaction(16384, {
    reserveTokens: 100000,
    keepRecentTokens: 80000,
    enabled: false,
  });
  assert.ok(small.reserveTokens + small.keepRecentTokens < 16384);
  assert.equal(small.enabled, false);
});
