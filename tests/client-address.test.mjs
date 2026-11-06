import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../server/client-address.mjs';
test('only an explicitly trusted edge can provide client addresses, keeping public users out of one shared login quota', () => {
  const req = {
    socket: { remoteAddress: '::ffff:172.18.0.1' },
    headers: { 'x-real-ip': '198.51.100.1' },
  };
  assert.equal(clientAddress(req), '172.18.0.1');
  assert.equal(clientAddress(req, '172.18.0.1'), '198.51.100.1');
  assert.equal(
    clientAddress({ ...req, headers: { 'x-real-ip': '203.0.113.2' } }, '172.18.0.1'),
    '203.0.113.2',
  );
  assert.equal(
    clientAddress({ ...req, headers: { 'x-real-ip': '198.51.100.1, attacker' } }, '172.18.0.1'),
    '172.18.0.1',
  );
  assert.equal(
    clientAddress({ ...req, socket: { remoteAddress: '198.51.100.2' } }, '172.18.0.1'),
    '198.51.100.2',
  );
});
