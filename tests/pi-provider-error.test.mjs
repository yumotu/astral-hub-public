import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../deploy/pi/provider-error.mjs';

test('DeepSeek insufficient balance yields a fixed actionable error without leaking provider details', () => {
  const value = providerError('402: {"message":"Insufficient Balance","request_id":"private-secret"}');
  assert.equal(value?.status, 402);
  assert.match(value.message, /余额不足/);
  assert.doesNotMatch(value.message, /private-secret/);
  assert.equal(providerError('upstream unavailable'), null);
});
