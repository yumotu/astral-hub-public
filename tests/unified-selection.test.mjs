import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readUnifiedSelection,
  saveUnifiedSelection,
  unifiedSelectionKey,
  activeUnifiedSelection,
  createUnifiedOperationJournal,
} from '../shared/unified-selection.mjs';
const storage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
test('unified selection migrates actual legacy view once and stays scoped to account and server', () => {
  const disk = storage(),
    legacy = storage(),
    scope = { server: 'https://a', url: 'https://a/', owner: 'alice' },
    id = randomUUID();
  disk.setItem('astral.agent.last:https://a/:alice', 'dsh');
  legacy.setItem('astral.dsh.last:https://a/:alice', id);
  assert.deepEqual(readUnifiedSelection(disk, legacy, scope), { origin: 'remote', nativeId: id });
  assert.equal(legacy.getItem('astral.dsh.last:https://a/:alice'), null);
  disk.setItem('astral.agent.last:https://a/:alice', 'pi');
  assert.deepEqual(readUnifiedSelection(disk, legacy, scope), { origin: 'remote', nativeId: id });
  assert.equal(readUnifiedSelection(disk, legacy, { ...scope, owner: 'bob' }), null);
  assert.equal(
    readUnifiedSelection(disk, legacy, { ...scope, server: 'https://b', url: 'https://b/' }),
    null,
  );
  assert.equal(
    saveUnifiedSelection(disk, unifiedSelectionKey(scope.server, scope.owner), {
      origin: 'remote',
      nativeId: id,
      token: 'never',
    }),
    false,
  );
  assert.equal(
    saveUnifiedSelection(disk, unifiedSelectionKey(scope.server, scope.owner), null),
    true,
  );
  assert.equal(
    readUnifiedSelection(disk, legacy, scope),
    null,
    'explicit clearing cannot restore a deleted legacy selection',
  );
});
test('reopening an older segment follows the active engine but unavailable selections are retained', () => {
  const a = { origin: 'server', nativeId: randomUUID() },
    b = { origin: 'remote', nativeId: randomUUID() };
  assert.deepEqual(activeUnifiedSelection([{ segments: [a, b], active: b }], a), b);
  assert.deepEqual(activeUnifiedSelection([], a), a);
  assert.equal(activeUnifiedSelection([], null), null);
});
test('pending conversation operations retain their id across refresh and remain scoped without replay', () => {
  const disk = storage(),
    scope = unifiedSelectionKey('https://a', 'alice'),
    other = unifiedSelectionKey('https://a', 'bob');
  const first = createUnifiedOperationJournal(disk, scope),
    key = 'switch:owned-chat:pi-to-dsh';
  const id = first.id(key);
  assert.equal(first.id(key), id);
  const restored = createUnifiedOperationJournal(disk, scope);
  assert.equal(restored.id(key), id);
  assert.notEqual(createUnifiedOperationJournal(disk, other).id(key), id);
  restored.complete(key);
  assert.notEqual(createUnifiedOperationJournal(disk, scope).id(key), id);
  const privateStorage = {
    getItem() {
      throw Error('disabled');
    },
    setItem() {
      throw Error('disabled');
    },
  };
  const memory = createUnifiedOperationJournal(privateStorage, scope);
  assert.equal(memory.id(key), memory.id(key));
});
