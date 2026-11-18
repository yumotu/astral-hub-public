import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPiTimeline } from '../shared/pi-timeline.mjs';

test('1000 deltas replace only the affected tail while preserving frozen prior snapshots', () => {
  let items = Array.from({ length: 299 }, (_, i) =>
    Object.freeze({ kind: 'tool', id: String(i), status: 'done' }),
  );
  items.push(Object.freeze({ kind: 'text', text: '' }));
  let replaced = 0;
  for (let i = 0; i < 1000; i++) {
    const old = Object.freeze(items);
    items = applyPiTimeline(old, { type: 'text_delta', delta: 'x' });
    replaced += items.filter((item, n) => item !== old[n]).length;
    assert.equal(old.at(-1).text.length, i);
    assert.equal(items.at(-1).text.length, i + 1);
  }
  assert.equal(replaced, 1000);
  assert.equal(items.length, 300);
});
test('tool updates share unrelated items, normalize todos and preserve caps', () => {
  const text = Object.freeze({ kind: 'thinking', text: 'old' });
  const tool = Object.freeze({ kind: 'tool', id: 'a', status: 'running', output: 'old' });
  const old = Object.freeze([text, tool]);
  const next = applyPiTimeline(old, {
    type: 'tool_end',
    id: 'a',
    error: true,
    output: 'x'.repeat(13000),
    summary: 's'.repeat(600),
    added: 3,
    todos: [{ text: 'check', status: 'done' }],
  });
  assert.strictEqual(next[0], text);
  assert.notStrictEqual(next[1], tool);
  assert.equal(tool.status, 'running');
  assert.equal(next[1].status, 'error');
  assert.equal(next[1].output.length, 12000);
  assert.equal(next[1].summary.length, 500);
  assert.equal(next[1].added, 3);
  const long = applyPiTimeline([{ kind: 'text', text: 'a'.repeat(48000) }], {
    type: 'text_delta',
    delta: 'b',
  });
  assert.equal(long[0].text.length, 48000);
  assert.ok(long[0].text.endsWith('b'));
  assert.equal(
    applyPiTimeline(
      Array.from({ length: 300 }, (_, i) => ({ kind: 'tool', id: String(i) })),
      { type: 'text_delta', delta: 'new' },
    ).length,
    300,
  );
});
test('empty, unrelated and duplicate starts retain unchanged item references and values', () => {
  const tool = Object.freeze({ kind: 'tool', id: 'a', status: 'running' });
  const old = Object.freeze([tool]);
  for (const event of [
    {},
    { type: 'text_delta', delta: '' },
    { type: 'tool_start', id: 'a' },
    { type: 'tool_end', id: 'missing' },
  ]) {
    const next = applyPiTimeline(old, event);
    assert.deepEqual(next, old);
    assert.strictEqual(next[0], tool);
  }
});
