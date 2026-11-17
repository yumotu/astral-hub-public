import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesLocalProjectComputer } from '../shared/computer-project-setup.mjs';

test('local directory selection requires the exact Pi device and server, never a matching name', () => {
  const target = { origin: 'computer', deviceId: 'local-device' };
  const status = {
    configured: true,
    deviceId: 'local-device',
    name: '同名电脑',
    server: 'https://hub.example/',
  };
  assert.equal(matchesLocalProjectComputer(target, status, 'https://hub.example'), true);
  assert.equal(
    matchesLocalProjectComputer(target, { ...status, running: false }, 'https://hub.example'),
    true,
  );
  for (const value of [
    null,
    { ...status, configured: false },
    { ...status, deviceId: 'other-device' },
    { ...status, server: 'https://other.example' },
    { ...status, server: undefined },
  ]) {
    assert.equal(matchesLocalProjectComputer(target, value, 'https://hub.example'), false);
  }
  assert.equal(
    matchesLocalProjectComputer(
      { origin: 'remote', connectionId: 'local-device' },
      status,
      'https://hub.example',
    ),
    false,
  );
  assert.equal(
    matchesLocalProjectComputer(
      { origin: 'computer', deviceId: '' },
      status,
      'https://hub.example',
    ),
    false,
  );
});
