import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createGoals } from '../server/goals.mjs';
import { goalRequest, validateCreatedSkillName } from '../deploy/pi/goal-command.mjs';
import { selectionAnchor } from '../shared/selection-anchor.mjs';
test('goals persist across conversations and reopenings, isolate accounts and reject stale plans', () => {
  const db = new DatabaseSync(':memory:');
  const goals = createGoals(db);
  const id = randomUUID(),
    step = randomUUID();
  const created = goals.execute('alice', {
    action: 'create',
    goal: { id, title: '完成交付', steps: [{ id: step, title: '编译验收' }] },
  }).goal;
  assert.equal(created.steps[0].status, 'pending');
  assert.deepEqual(goals.list('bob'), []);
  assert.throws(() => goals.execute('bob', { action: 'inspect', id }), { status: 404 });
  goals.execute('alice', {
    action: 'update',
    id,
    patch: { revision: 1, steps: [{ id: step, title: '编译验收', status: 'done' }] },
  });
  assert.throws(
    () =>
      goals.execute('alice', { action: 'update', id, patch: { revision: 1, status: 'completed' } }),
    { status: 409 },
  );
  const reopened = createGoals(db);
  assert.equal(reopened.get('alice', id).steps[0].status, 'done');
  reopened.execute('alice', { action: 'update', id, patch: { revision: 2, status: 'archived' } });
  assert.equal(goals.list('alice').length, 0);
  assert.equal(goals.list('alice', true).length, 1);
  db.close();
});
test('Pi goal grants expire, revoke, and cannot cross accounts', async () => {
  const db = new DatabaseSync(':memory:');
  let now = 0;
  const goals = createGoals(db, { now: () => now });
  const grant = goals.grant('alice', {});
  let response;
  const req = { method: 'POST', headers: { authorization: 'Bearer ' + grant.token } };
  await goals.before(
    req,
    new URL('http://app/api/pi/goal-access'),
    (_code, r) => (response = r),
    async () => ({ action: 'list' }),
  );
  assert.deepEqual(response, { goals: [] });
  grant.revoke();
  await assert.rejects(
    () =>
      goals.before(
        req,
        new URL('http://app/api/pi/goal-access'),
        () => {},
        async () => ({ action: 'list' }),
      ),
    { status: 403 },
  );
  const expiring = goals.grant('bob', {});
  now = 31 * 60 * 1000;
  await assert.rejects(
    () =>
      goals.before(
        { ...req, headers: { authorization: 'Bearer ' + expiring.token } },
        new URL('http://app/api/pi/goal-access'),
        () => {},
        async () => ({ action: 'list' }),
      ),
    { status: 403 },
  );
  db.close();
});
test('goal and plan commands request real goal tools; new skill names omit redundant skill markers', () => {
  assert.match(goalRequest('/goal 建立目标'), /goal_manage/);
  assert.match(goalRequest('/plan'), /查看当前账号/);
  assert.equal(goalRequest('正常消息'), '正常消息');
  assert.equal(validateCreatedSkillName('pdf-reader'), 'pdf-reader');
  for (const name of ['pdf-skill', 'skills-pdf', 'skill-forge'])
    assert.throws(() => validateCreatedSkillName(name), /按用途命名/);
});
test('selection action stays near the selected text and inside narrow screens and mobile keyboards', () => {
  const rect = { left: 90, top: 200, bottom: 220 };
  assert.deepEqual(selectionAnchor(rect, { width: 900, height: 700 }), {
    left: 90,
    top: 144,
    maxWidth: 210,
  });
  const p = selectionAnchor({ left: 310, top: 15, bottom: 35 }, { width: 320, height: 600 });
  assert.ok(p.left + p.maxWidth <= 312);
  assert.equal(p.top, 47);
  const keyboard = selectionAnchor(
    { left: 20, top: 650, bottom: 680 },
    { width: 375, height: 350 },
  );
  assert.ok(keyboard.top + 44 <= 342);
  const touch = selectionAnchor(rect,{width:375,height:700,mobile:true});
  assert.ok(touch.top >= rect.bottom + 44, 'keep clear of native selection handles');
  assert.ok(touch.left + touch.maxWidth <= 363);
  const above = selectionAnchor({left:20,top:570,bottom:590},{width:375,height:650,mobile:true});
  assert.ok(above.top + 44 <= 570 - 88, 'leave space for the system selection menu');
  assert.equal(selectionAnchor({left:20,top:20,bottom:580},{width:320,height:600,mobile:true}),null);
});
