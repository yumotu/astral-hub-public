import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunPool } from '../deploy/pi/run-pool.mjs';

test('native session leases isolate controls and plugin credentials, enforce capacity and protect shared package changes', () => {
  const pool = createRunPool(2), a = {pluginToken:'token-a'}, b = {pluginToken:'token-b'};
  pool.acquire('session-a', a); pool.acquire('session-b', b);
  assert.equal(pool.get('session-a'), a);
  assert.equal(pool.byToken('token-b'), b);
  assert.equal(pool.byToken('token-c'), undefined);
  assert.throws(() => pool.acquire('session-a', {}), {status:429});
  assert.throws(() => pool.acquire('session-c', {}), {status:429});
  assert.throws(() => pool.maintenance('session-a', true), {status:409});
  pool.release('session-a', b); assert.equal(pool.size, 2);
  pool.release('session-b', b);
  pool.maintenance('session-a', true);
  assert.equal(pool.canRun('session-c'), false);
  pool.release('session-a', a);
  assert.equal(pool.canRun('session-c'), true);
});
