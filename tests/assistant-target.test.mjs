import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  assistantTargetStorageKey,
  readAssistantTarget,
  computerChatStorageKey,
  readComputerChatDraft,
} from '../shared/assistant-target.mjs';
import { readComputerDraft, computerFileDraft } from '../shared/computer-draft.mjs';

test('unified assistant target restore separates accounts and servers and rejects incomplete or expanded grants', () => {
  const map = new Map(),
    storage = { getItem: (key) => map.get(key) || null };
  const key = assistantTargetStorageKey('https://hub.example', 'alice');
  const target = { deviceId: randomUUID(), projectId: randomUUID(), conversationId: randomUUID() };
  map.set(key, JSON.stringify(target));
  assert.deepEqual(readAssistantTarget(storage, key), target);
  assert.equal(
    readAssistantTarget(storage, assistantTargetStorageKey('https://hub.example', 'bob')),
    null,
  );
  assert.equal(
    readAssistantTarget(storage, assistantTargetStorageKey('https://other.example', 'alice')),
    null,
  );
  for (const bad of [
    { deviceId: target.deviceId },
    { ...target, projectId: '../outside' },
    { ...target, allowExecute: true },
    { ...target, owner: 'bob' },
  ]) {
    map.set(key, JSON.stringify(bad));
    assert.equal(readAssistantTarget(storage, key), null);
  }
  map.set(key, 'invalid json');
  assert.equal(readAssistantTarget(storage, key), null);
  assert.equal(
    readAssistantTarget(
      {
        getItem() {
          throw new Error('storage disabled');
        },
      },
      key,
    ),
    null,
  );
});

test('computer editor draft restore keeps the original hash and never restores an invalid or oversized write', () => {
  const value = {
    file: { path: 'README.md', content: 'before', sha256: 'a'.repeat(64), readOnly: false },
    text: 'unsaved change',
  };
  assert.deepEqual(
    readComputerDraft({ getItem: () => JSON.stringify(value) }, 'scoped-key'),
    value,
  );
  const actualDocument = { ...value.file, totalLines: 3, futureMetadata: 'ignored' };
  const serialized = JSON.stringify(computerFileDraft(actualDocument, value.text));
  assert.deepEqual(readComputerDraft({ getItem: () => serialized }, 'scoped-key'), value);
  for (const invalid of [
    { ...value, text: 'x'.repeat(262145) },
    { ...value, file: { ...value.file, sha256: 'new' } },
    { ...value, allowExecute: true },
  ])
    assert.equal(readComputerDraft({ getItem: () => JSON.stringify(invalid) }, 'scoped-key'), null);
});

test('local unsent computer drafts retain their original conversation without creating server history', () => {
  const id = randomUUID(),
    map = new Map();
  const key = computerChatStorageKey('https://hub.example', 'alice', 'device-a', 'project-a');
  const storage = { getItem: (key) => map.get(key) || null };
  map.set(key, id);
  map.set(key + ':draft:' + id, 'pending question');
  assert.deepEqual(readComputerChatDraft(storage, key), { id, input: 'pending question' });
  assert.equal(
    readComputerChatDraft(
      storage,
      computerChatStorageKey('https://hub.example', 'alice', 'device-b', 'project-a'),
    ),
    null,
  );
  assert.equal(
    readComputerChatDraft(
      storage,
      computerChatStorageKey('https://hub.example', 'bob', 'device-a', 'project-a'),
    ),
    null,
  );
  map.set(key + ':draft:' + id, ' ');
  assert.equal(readComputerChatDraft(storage, key), null);
  map.set(key + ':attachments:' + id, JSON.stringify([{ id: randomUUID() }]));
  assert.deepEqual(readComputerChatDraft(storage, key), { id, input: '附件草稿' });
});
