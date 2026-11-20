import test from 'node:test';
import assert from 'node:assert/strict';
import { computerInputAvailability } from '../shared/assistant-availability.mjs';

test('computer inputs follow announced capabilities, not a guessed version or a removed disabled flag', () => {
  assert.match(computerInputAvailability().thinking, /更新/);
  assert.match(computerInputAvailability().attachment, /更新/);
  const capabilities = ['thinking_levels', 'chat_inputs'];
  assert.deepEqual(computerInputAvailability({ capabilities }), { thinking: '', attachment: '' });
  assert.match(computerInputAvailability({ capabilities, working: true }).thinking, /队列/);
  assert.equal(computerInputAvailability({ capabilities, working: true }).attachment, '');
  assert.match(computerInputAvailability({ capabilities, uploading: true }).attachment, /上传/);
  assert.match(computerInputAvailability({ capabilities, fileCount: 8 }).attachment, /8/);
  assert.equal(computerInputAvailability({ capabilities, fileCount: 7 }).attachment, '');
});
