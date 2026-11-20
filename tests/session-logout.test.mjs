import test from 'node:test';
import assert from 'node:assert/strict';
import { endSession } from '../web/src/session.ts';

test('local logout clears the session immediately while remote revocation is still pending', async () => {
  let clear = false,
    finish;
  const result = endSession(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {
      clear = true;
    },
  );
  assert.equal(clear, true);
  finish();
  assert.equal(await result, true);
});
test('expired credentials and offline revocation cannot trap users in an unusable signed-in state', async () => {
  for (const error of [
    Object.assign(new Error('expired'), { status: 401 }),
    new TypeError('network unavailable'),
  ]) {
    let clear = false;
    assert.equal(
      await endSession(
        async () => {
          throw error;
        },
        () => {
          clear = true;
        },
      ),
      false,
    );
    assert.equal(clear, true);
  }
});
