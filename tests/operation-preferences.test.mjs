import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operationPreferenceKey,
  readOperationPreferences,
  saveOperationPreferences,
} from '../shared/operation-preferences.mjs';

test('operation choices survive reopening while staying scoped to account, server and execution target', () => {
  const values = new Map(),
    storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) },
    key = operationPreferenceKey('https://astral.test/', 'alice', 'computer', [
      'device',
      'project',
      'chat',
    ]);
  const choices = {
    access: 'edit',
    execute: true,
    approvalMode: 'full',
    approvalTargets: ['pi'],
    approvalMinutes: 'always',
    networkMinutes: '60',
  };
  assert.equal(saveOperationPreferences(storage, key, choices), true);
  assert.deepEqual(readOperationPreferences(storage, key), choices);
  for (const other of [
    operationPreferenceKey('https://other.test', 'alice', 'computer', [
      'device',
      'project',
      'chat',
    ]),
    operationPreferenceKey('https://astral.test', 'bob', 'computer', ['device', 'project', 'chat']),
    operationPreferenceKey('https://astral.test', 'alice', 'server', ['device', 'project', 'chat']),
    operationPreferenceKey('https://astral.test', 'alice', 'computer', [
      'other',
      'project',
      'chat',
    ]),
  ])
    assert.deepEqual(readOperationPreferences(storage, other), {});
  saveOperationPreferences(storage, key, { execute: false });
  assert.deepEqual(readOperationPreferences(storage, key), { ...choices, execute: false });
  saveOperationPreferences(storage, key, { token: 'must-not-persist', acknowledged: true });
  assert.ok(!storage.getItem(key).includes('must-not-persist'));
  assert.ok(!storage.getItem(key).includes('acknowledged'));
});
test('damaged, unknown and unavailable storage never invent permissions or expose credentials', () => {
  assert.deepEqual(readOperationPreferences({ getItem: () => '{bad' }, 'k'), {});
  const storage = {
    getItem: () =>
      JSON.stringify({
        access: 'root',
        execute: 'true',
        networkMinutes: 'always',
        token: 'secret',
        approvalMode: 'unknown',
      }),
  };
  assert.deepEqual(readOperationPreferences(storage, 'k'), {});
  assert.equal(
    saveOperationPreferences(
      {
        getItem() {
          throw Error();
        },
        setItem() {
          throw Error();
        },
      },
      'k',
      { access: 'edit' },
    ),
    false,
  );
});
