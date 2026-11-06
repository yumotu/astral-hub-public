import test from 'node:test';
import assert from 'node:assert/strict';
import { steeringUnavailable, settleSteeringAck } from '../deploy/pi/steer-controls.mjs';

test('startup non-delivery releases the control memo; accepted or uncertain controls stay deduplicated', async () => {
  const controls = new Map();
  const entry = () => {
    let accept, decline;
    const promise = new Promise((resolve, reject) => {
      accept = resolve;
      decline = reject;
    });
    const item = { promise, accept, decline };
    controls.set('supplement', item);
    return item;
  };
  const early = entry();
  const rejected = assert.rejects(early.promise, (e) => e.status === 503);
  settleSteeringAck(controls, { id: 'supplement', ...steeringUnavailable(false, false) });
  await rejected;
  assert.equal(controls.size, 0);
  assert.equal(steeringUnavailable(true, true), null);
  const retry = entry();
  settleSteeringAck(controls, { id: 'supplement', disposition: 'queued' });
  assert.deepEqual(await retry.promise, { disposition: 'queued' });
  assert.equal(controls.get('supplement'), retry);
  const ended = entry();
  const endedResult = assert.rejects(ended.promise, (e) => e.status === 409);
  settleSteeringAck(controls, { id: 'supplement', ...steeringUnavailable(false, true) });
  await endedResult;
  assert.equal(controls.get('supplement'), ended);
});
