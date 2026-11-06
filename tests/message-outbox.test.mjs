import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageOutbox } from '../shared/message-outbox.mjs';
const tick = () => new Promise((r) => setImmediate(r));
const payload = (id, conversationId = 'one') => ({
  id,
  conversationId,
  input: id,
  attachments: [],
  mode: 'steer',
});
test('supplements leave the draft immediately, send FIFO by conversation and do not wait for task completion', async () => {
  const calls = [],
    pending = new Map(),
    box = createMessageOutbox({
      send: (p) => {
        calls.push(p.id);
        return new Promise((r) => pending.set(p.id, r));
      },
      lookup: async () => null,
    });
  box.add(payload('a'));
  box.add(payload('b'));
  box.add(payload('c', 'two'));
  assert.equal(box.snapshot().length, 3);
  await tick();
  assert.deepEqual(calls, ['a', 'c']);
  pending.get('a')({ task: { id: 'a', status: 'running' } });
  await tick();
  assert.deepEqual(calls, ['a', 'c', 'b']);
  assert.equal(box.snapshot()[0].status, 'accepted');
  box.confirm(['a']);
  assert.equal(
    box.snapshot().some((r) => r.payload.id === 'a'),
    false,
  );
  pending.get('b')({ task: { id: 'b', status: 'accepted' } });
  pending.get('c')({ task: { id: 'c', status: 'running' } });
  await tick();
  box.close();
});
test('unknown delivery blocks only that conversation, queries do not replay and explicit retry keeps the original ID', async () => {
  let attempts = 0,
    seen = [];
  const box = createMessageOutbox({
    send: async (p) => {
      seen.push(p.id);
      if (p.id === 'a' && attempts++ === 0) throw Error('network lost');
      return { task: { id: p.id } };
    },
    lookup: async () => null,
  });
  box.add(payload('a'));
  box.add(payload('b'));
  box.add(payload('c', 'other'));
  await tick();
  await tick();
  assert.equal(box.snapshot()[0].status, 'unknown');
  assert.deepEqual(seen, ['a', 'c']);
  await box.reconcile('a');
  assert.deepEqual(seen, ['a', 'c']);
  box.retry('a');
  await tick();
  await tick();
  assert.deepEqual(seen, ['a', 'c', 'a', 'b']);
  box.close();
});
test('restored messages only query for confirmation, preserve attachments and never auto-send', async () => {
  let sent = 0;
  const file = { id: 'file', name: 'note.txt' },
    saved = {
      payload: { ...payload('retained'), attachments: ['file'] },
      files: [file],
      status: 'sending',
    };
  const box = createMessageOutbox({
    initial: [saved],
    send: async () => {
      sent++;
    },
    lookup: async (id) => ({ task: { id, status: 'queued' } }),
  });
  await tick();
  assert.equal(sent, 0);
  assert.equal(box.snapshot()[0].status, 'unknown');
  assert.deepEqual(box.snapshot()[0].files, [file]);
  await box.reconcile('retained');
  assert.equal(box.snapshot()[0].status, 'accepted');
  assert.equal(sent, 0);
  box.close();
});
test('known rejection does not stall later supplements and only unsubmitted messages can be edited or removed', async () => {
  let release;
  const box = createMessageOutbox({
    send: (p) =>
      p.id === 'a'
        ? new Promise((r) => (release = r))
        : Promise.reject(Object.assign(Error('denied'), { status: 403 })),
    lookup: async () => null,
  });
  box.add(payload('a'));
  box.add(payload('b'));
  box.add(payload('c'));
  await tick();
  box.edit('b', 'edited');
  assert.equal(box.snapshot()[1].payload.input, 'edited');
  box.remove('c');
  assert.throws(() => box.edit('a', 'forbidden'));
  release({ task: { id: 'a' } });
  await tick();
  await tick();
  assert.equal(box.snapshot().find((r) => r.payload.id === 'b').status, 'rejected');
  box.remove('b');
  box.close();
});
