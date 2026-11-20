import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamWriter } from '../deploy/pi/stream-writer.mjs';

test('stream delivery exposes the first fragment immediately, coalesces tiny deltas and flushes at boundaries', () => {
  const events = [];
  let at = 0, callback;
  const stream = createStreamWriter((e) => events.push(e), {
    now: () => at,
    schedule: (f) => { callback = f; return 1; },
    unschedule: () => { callback = undefined; },
  });
  stream.write({ type: 'thinking_delta', delta: '首' });
  assert.equal(events.length, 1, 'first fragment must arrive before completion');
  for (let i = 0; i < 1000; i++) stream.write({ type: 'thinking_delta', delta: '想' });
  assert.equal(events.length, 1);
  at = 40;
  callback();
  assert.equal(events.length, 2);
  stream.write({ type: 'text_delta', delta: '正' });
  stream.write({ type: 'text_delta', delta: '文' });
  stream.write({ type: 'tool_start', id: 'one' });
  stream.write({ type: 'text_delta', delta: '续' });
  stream.write({ type: 'text_delta', delta: '写' });
  stream.write({ type: 'done', output: '正文续写' });
  stream.close();
  assert.deepEqual(events.map((e) => e.type), [
    'thinking_delta', 'thinking_delta', 'text_delta', 'text_delta', 'tool_start',
    'text_delta', 'text_delta', 'done',
  ]);
  assert.equal(events.filter((e) => e.type === 'thinking_delta').map((e) => e.delta).join(''), '首' + '想'.repeat(1000));
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), '正文续写');
  assert.equal(callback, undefined);
});

test('a slow stream is not delayed and cancellation flushes the last partial answer exactly once', async () => {
  const events = [];
  const stream = createStreamWriter((e) => events.push(e), { interval: 5, maxChars: 8 });
  stream.write({ type: 'text_delta', delta: 'a' });
  stream.write({ type: 'text_delta', delta: 'bc' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(events.length, 2);
  stream.write({ type: 'text_delta', delta: 'd' });
  stream.write({ type: 'text_delta', delta: 'efghijkl' });
  stream.write({ type: 'text_delta', delta: 'm' });
  stream.close();
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(events.map((e) => e.delta).join(''), 'abcdefghijklm');
  stream.write({ type: 'text_delta', delta: 'must not appear' });
  assert.equal(events.map((e) => e.delta).join(''), 'abcdefghijklm');
});
