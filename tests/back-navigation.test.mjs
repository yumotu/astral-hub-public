import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackStack } from '../shared/back-navigation.mjs';
test('back closes exactly one highest layer before returning through pages', () => {
  const stack = createBackStack(),
    calls = [];
  const page = stack.register(() => calls.push('page'), 10);
  const drawer = stack.register(() => calls.push('drawer'), 80);
  const dialog = stack.register(() => calls.push('dialog'), 100);
  assert.equal(stack.handle(), true);
  assert.deepEqual(calls, ['dialog']);
  dialog();
  stack.handle();
  assert.equal(calls.at(-1), 'drawer');
  drawer();
  stack.handle();
  assert.equal(calls.at(-1), 'page');
  page();
  assert.equal(stack.handle(), false);
  assert.equal(stack.size, 0);
});
test('newest peer wins, disabled layers fall through, unmount and guarded errors stay safe', () => {
  const stack = createBackStack(),
    calls = [];
  stack.register(() => calls.push('old'), 100);
  const peer = stack.register(() => calls.push('new'), 100);
  const ignored = stack.register(() => false, 110);
  stack.handle();
  assert.deepEqual(calls, ['new']);
  peer();
  ignored();
  stack.handle();
  assert.deepEqual(calls, ['new', 'old']);
  stack.register(() => {
    throw new Error('unsaved guard');
  }, 120);
  assert.equal(stack.handle(), true);
  assert.equal(calls.length, 2);
});
