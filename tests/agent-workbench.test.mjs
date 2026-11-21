import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentEventKinds,
  createSyntheticAgentEvents,
  createSyntheticWorkbenchSnapshot,
  projectWorkbenchSnapshot,
} from '../shared/agent-workbench.mjs';

const now = '2026-11-22T00:00:00.000Z';

test('P0 synthetic events project a deterministic read-only workbench snapshot', () => {
  const snapshot = createSyntheticWorkbenchSnapshot({ now });
  assert.equal(snapshot.mode, 'synthetic');
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.eventCount, 7);
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(snapshot.goals.length, 1);
  assert.equal(snapshot.schedules.length, 1);
  assert.equal(snapshot.attentions.length, 1);
  assert.equal(snapshot.finance.length, 1);
  assert.deepEqual(snapshot, createSyntheticWorkbenchSnapshot({ now }));
});

test('event projection deduplicates IDs and isolates owners', () => {
  const events = createSyntheticAgentEvents({ now, ownerId: 'alice' });
  const duplicate = events[0];
  const snapshot = projectWorkbenchSnapshot([...events, duplicate, { ...duplicate, ownerId: 'bob' }], { ownerId: 'alice' });
  assert.equal(snapshot.eventCount, events.length);
  assert.ok(snapshot.eventIds.includes(duplicate.id));
  assert.ok(snapshot.conversations.every((item) => item.id));
});

test('synthetic source kinds remain explicit and unsupported events are rejected', () => {
  assert.ok(agentEventKinds.includes('conversation.run_started'));
  assert.throws(
    () => projectWorkbenchSnapshot([{ id: 'bad', ownerId: 'demo-owner', type: 'unknown', source: 'x', sourceId: 'x', occurredAt: new Date().toISOString(), payload: {} }]),
    /unsupported agent event kind/,
  );
});
