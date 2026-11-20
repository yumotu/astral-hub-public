import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readAssistantSelection, saveAssistantSelection } from '../shared/assistant-resume.mjs';

const storage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
test('assistant selections survive a new window without mixing accounts, servers or privileges', () => {
  const disk = storage(),
    window = storage(),
    key = 'server-a:alice';
  const target = { deviceId: randomUUID(), projectId: randomUUID(), conversationId: randomUUID() };
  for (const [kind, value] of [
    ['driver', 'dsh'],
    ['conversation', randomUUID()],
    ['computer', target],
  ]) {
    const k = key + kind;
    assert.equal(saveAssistantSelection(disk, k, kind, value), true);
    assert.deepEqual(readAssistantSelection(disk, storage(), k, kind), value);
    assert.equal(readAssistantSelection(disk, window, 'server-b:alice' + kind, kind), null);
    assert.equal(readAssistantSelection(disk, window, 'server-a:bob' + kind, kind), null);
  }
  assert.equal(
    saveAssistantSelection(disk, key, 'computer', { ...target, allowExecute: true }),
    false,
  );
  assert.equal(saveAssistantSelection(disk, key, 'conversation', '../other'), false);
  assert.equal(saveAssistantSelection(disk, key, 'computer', null), true);
  assert.equal(readAssistantSelection(disk, window, key, 'computer'), null);
});
test('legacy window selection migrates once; broken stores and stale window data cannot overwrite the last selection', () => {
  const disk = storage(),
    old = storage(),
    id = randomUUID();
  old.setItem('last', id);
  assert.equal(readAssistantSelection(disk, old, 'last', 'conversation'), id);
  assert.equal(old.getItem('last'), null);
  old.setItem('last', randomUUID());
  assert.equal(readAssistantSelection(disk, old, 'last', 'conversation'), id);
  disk.setItem('bad', '{');
  assert.equal(readAssistantSelection(disk, old, 'bad', 'computer'), null);
  const denied = {
    getItem() {
      throw Error('disabled');
    },
    setItem() {
      throw Error('disabled');
    },
  };
  assert.equal(readAssistantSelection(denied, denied, 'x', 'driver'), null);
  assert.equal(saveAssistantSelection(denied, 'x', 'driver', 'pi'), false);
});
