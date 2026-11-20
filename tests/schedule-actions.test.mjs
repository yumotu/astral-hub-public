import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleActionSchema, cronAction } from '../server/schedule-actions.mjs';
import { sameScheduleScope } from '../deploy/pi/cron-scope.mjs';
test('schedule actions strictly validate their operation and cannot select an execution target or broader permissions', () => {
  const input = {
    action: 'create',
    name: 'check',
    prompt: 'Verify the saved result',
    schedule: 'every 30m',
    longGoal: true,
  };
  const result = cronAction(input, 'stable-call');
  assert.equal(result.name, 'cron_create');
  assert.match(result.params.prompt, /^\/long-goal /);
  assert.deepEqual(result.params.deliver, []);
  for (const extra of [
    { deviceId: 'forged' },
    { ownerId: 'forged' },
    { access: 'edit' },
    { execute: true },
    { cwd: '/arbitrary' },
    { deliver: ['external'] },
  ])
    assert.equal(scheduleActionSchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(
    scheduleActionSchema.safeParse({ action: 'create', name: 'no task' }).success,
    false,
  );
  assert.throws(
    () => cronAction({ action: 'update', job: 'check', longGoal: true }, 'call'),
    /完整/,
  );
  assert.equal(cronAction({ action: 'pause', job: 'check' }, 'call').params.enabled, false);
  assert.equal(cronAction({ action: 'resume', job: 'check' }, 'call').params.enabled, true);
});
test('scheduled scope distinguishes conversation, device, project and command authorization even when labels match', () => {
  const a = {
    ownerId: 'owner',
    conversationId: 'chat',
    projectId: 'same-name',
    access: 'read',
    target: { kind: 'computer', deviceId: 'one', execute: false },
  };
  assert.equal(sameScheduleScope(a, structuredClone(a)), true);
  for (const b of [
    { ...a, conversationId: 'other' },
    { ...a, ownerId: 'other' },
    { ...a, projectId: 'other' },
    { ...a, access: 'edit' },
    { ...a, target: { ...a.target, deviceId: 'two' } },
    { ...a, target: { ...a.target, execute: true } },
    { ...a, target: { kind: 'server' } },
  ])
    assert.equal(sameScheduleScope(a, b), false);
});
