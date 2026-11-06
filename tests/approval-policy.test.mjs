import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createApprovalPolicy, commandFamily } from '../server/approval-policy.mjs';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  let time = 1000000;
  const p = createApprovalPolicy(db, () => time);
  t.after(() => db.close());
  return { p, tick: (n) => (time += n) };
}
const c = { target: 'pi', cwd: '/projects/a', command: 'git status --short' };
test('approval scopes bind account, conversation, environment, working directory and exact bytes', (t) => {
  const { p } = fixture(t);
  assert.equal(p.decide('a', 'one', c), null);
  p.remember('a', 'one', c, 'exact');
  assert.equal(p.decide('a', 'one', c).kind, 'rule');
  for (const [owner, conversation, command] of [
    ['b', 'one', c],
    ['a', 'two', c],
    ['a', 'one', { ...c, target: 'server' }],
    ['a', 'one', { ...c, cwd: '/projects/b' }],
    ['a', 'one', { ...c, command: 'git status --short; rm -rf /' }],
  ])
    assert.equal(p.decide(owner, conversation, command), null);
  p.save('request', p.decide('a', 'one', c));
  assert.equal(p.valid('a', 'one', 'request', c), true);
  p.set('a', 'one', { mode: 'manual' });
  assert.equal(p.valid('a', 'one', 'request', c), false);
});
test('assisted review only accepts bounded read inspections and never shell syntax, writing or external diff', (t) => {
  const { p } = fixture(t);
  p.set('a', 'one', { mode: 'assist', targets: ['pi'], minutes: 15 });
  for (const command of ['pwd', 'ls -la', 'git status --short', 'git diff --stat', 'npm --version'])
    assert.equal(p.decide('a', 'one', { ...c, command })?.kind, 'assist', command);
  for (const command of [
    'pwd; touch file',
    'pwd\ntouch file',
    'ls $(touch file)',
    'ls `touch file`',
    'ls > out',
    'node -e eval(code)',
    'npm install pkg',
    'git diff --output=foo',
    'git diff --ext-diff',
    'git show --textconv',
    'git -c core.pager=evil log',
    'git log -cevil',
    'curl http://host',
    'cat /secret',
  ])
    assert.equal(p.decide('a', 'one', { ...c, command }), null, command);
  assert.equal(p.decide('a', 'one', { ...c, target: 'server' }), null);
});
test('full access needs explicit acknowledgment, expires and invalidates already issued approvals after revocation', (t) => {
  const { p, tick } = fixture(t),
    command = { ...c, command: 'python3 install.py && npm audit' };
  assert.throws(() => p.set('a', 'one', { mode: 'full' }), { status: 400 });
  p.set('a', 'one', { mode: 'full', targets: ['pi'], minutes: 15, acknowledged: true });
  p.save('r', p.decide('a', 'one', command));
  assert.equal(p.valid('a', 'one', 'r', command), true);
  assert.equal(p.decide('a', 'one', { ...command, target: 'server' }), null);
  tick(15 * 60000);
  assert.equal(p.get('a', 'one').mode, 'manual');
  assert.equal(p.valid('a', 'one', 'r', command), false);
  p.set('a', 'one', { mode: 'full', targets: ['pi'], acknowledged: true });
  p.save('r2', p.decide('a', 'one', command));
  p.set('a', 'one', { mode: 'manual' });
  assert.equal(p.valid('a', 'one', 'r2', command), false);
});
test('similar command rules cannot broaden scripts or mutation families', (t) => {
  const { p } = fixture(t);
  p.remember('a', 'one', c, 'similar');
  assert.equal(p.decide('a', 'one', { ...c, command: 'git status --porcelain' })?.kind, 'rule');
  assert.equal(p.decide('a', 'one', { ...c, command: 'git reset --hard' }), null);
  for (const command of [
    'npm install foo',
    'node script.js',
    'sh -c command',
    'git diff > result',
  ]) {
    assert.equal(commandFamily(command), null);
    assert.throws(() => p.remember('a', 'one', { ...c, command }, 'similar'), { status: 400 });
  }
  p.remember('a', 'one', { ...c, target: 'server' }, '15m');
  assert.deepEqual(p.get('a', 'one').targets, ['server']);
});
