import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { terminalNotifier, nativeNotification } from '../deploy/pi/notification-protocol.mjs';
import { notificationPayload, notificationLink } from '../shared/notifications.mjs';
test('native notification adaptation strips transport authority and leaves unrelated packages enabled', () => {
  for (const path of [
    '/x/node_modules/pi-desktop-notifications/index.ts',
    '/x/node_modules/@jmcombs/pi-notify/index.ts',
    'C:\\x\\node_modules\\@raidou\\pi-notify\\src\\index.ts',
  ])
    assert.equal(terminalNotifier(path), true);
  assert.equal(terminalNotifier('/x/node_modules/pi-desktop-notifications-other/index.ts'), false);
  assert.equal(terminalNotifier('/x/node_modules/pi-subagents/index.ts'), false);
  const id = randomUUID();
  const result = nativeNotification({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'astral-notification',
      details: { id, title: '测试', body: '正文', owner: 'injected', url: 'https://evil.test' },
    },
  });
  assert.deepEqual(result, { type: 'notification', id, title: '测试', body: '正文' });
  assert.equal(
    nativeNotification({ type: 'text_delta', delta: '\x1b]777;notify;title;body\x07' }),
    null,
  );
});
test('system notification previews default to generic text and links never contain external destinations', () => {
  const id = randomUUID(),
    conversationId = randomUUID(),
    taskId = randomUUID();
  const n = {
    id,
    kind: 'completed',
    title: 'private project',
    body: 'private result',
    conversationId,
    taskId,
    createdAt: new Date().toISOString(),
  };
  assert.doesNotMatch(JSON.stringify(notificationPayload(n, id)), /private/);
  assert.equal(notificationPayload(n, id, true).body, 'private result');
  assert.match(notificationLink(n), /^\?piConversation=/);
  assert.equal(notificationLink({ conversationId: 'https://evil.test' }), '');
});
