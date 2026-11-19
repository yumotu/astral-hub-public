import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
const source = readFileSync(new URL('../server/dsh-remote.mjs', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  async function catalogue('), source.indexOf('  function managedActor('));
function fixture(client, live = () => {}) {
  return new Function('connection', 'fail', 'z', 'workspace', 'session', 'live', 'agentCapabilities', code + '; return catalogue;')(
    async () => ({ client, row: { revision: 1 }, peer: {} }),
    (status, message) => Object.assign(Error(message), { status }), z, z.any(), z.any(), live, () => ({}),
  );
}
test('catalogue starts session directory while workspace baseline is pending and closes its stream', async () => {
  const workspace = Promise.withResolvers(), sessionsStarted = Promise.withResolvers();
  let closed = 0;
  const catalogue = fixture({
    workspaces: async () => ({ [Symbol.asyncIterator]: () => ({ next: () => workspace.promise }), close: async () => { closed++; } }),
    sessions: async () => { sessionsStarted.resolve(); return { items: [{ sessionId: 's' }] }; },
  });
  const pending = catalogue('alice', 'connection');
  await sessionsStarted.promise;
  workspace.resolve({ done: false, value: { type: 'baseline', value: { items: [{ workspaceId: 'p', sessionIds: ['s'] }] } } });
  const result = await pending;
  assert.deepEqual(result.sessions[0].workspaceIds, ['p']);
  assert.equal(closed, 1);
});
test('failed parallel session directory closes workspace source without publishing a catalogue', async () => {
  const baseline = Promise.withResolvers(), started = Promise.withResolvers();
  let closed = 0;
  const catalogue = fixture({
    workspaces: async () => ({ [Symbol.asyncIterator]: () => ({ next: () => baseline.promise }), close: async () => { closed++; } }),
    sessions: async () => { started.resolve(); throw Error('session failure'); },
  });
  const pending = catalogue('alice', 'connection');
  const rejected = assert.rejects(pending, /session failure/);
  await started.promise;
  baseline.resolve({ done: false, value: { type: 'baseline', value: { items: [] } } });
  await rejected;
  assert.equal(closed, 1);
});
test('session failure aborts a stalled workspace read and preserves the original error', async () => {
  const started = Promise.withResolvers();
  let closed = 0;
  const catalogue = fixture({
    workspaces: async () => ({ [Symbol.asyncIterator]: () => ({ next: () => { started.resolve(); return new Promise(() => {}); } }), close: async () => { closed++; } }),
    sessions: async () => { await started.promise; throw Object.assign(Error('directory unavailable'), { status: 503 }); },
  });
  await assert.rejects(catalogue('alice', 'connection'), { message: 'directory unavailable', status: 503 });
  assert.equal(closed, 1);
});
test('catalogue still rechecks live authorization after both reads', async () => {
  const catalogue = fixture({
    workspaces: async () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: { type: 'baseline', value: { items: [] } } }) }), close: async () => {} }),
    sessions: async () => ({ items: [] }),
  }, () => { throw Error('revoked'); });
  await assert.rejects(catalogue('alice', 'connection'), /revoked/);
});
