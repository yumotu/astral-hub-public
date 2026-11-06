import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pluginLoadPlan } from '../deploy/pi/plugin-load-plan.mjs';
import { longGoalEvent, customMessageText } from '../deploy/pi/rpc-prompt.mjs';
import { longGoalControl } from '../deploy/pi/long-goal-command.mjs';
import { messageDelivery } from '../shared/pi-conversation.mjs';
import {
  createGoalState,
  accountGoalTurn,
  parseTokenBudget,
} from '../deploy/pi/vendor/pi-goal/goal-state.ts';

test('the single long-goal plugin is pinned with intact upstream source and license in server and computer packages', async () => {
  const root = new URL('../deploy/pi/vendor/pi-goal/', import.meta.url);
  const upstream = JSON.parse(await readFile(new URL('UPSTREAM.json', root), 'utf8'));
  assert.equal(upstream.version, '0.1.7');
  assert.equal(upstream.license, 'MIT');
  for (const [name, expected] of Object.entries(upstream.files)) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
    assert.deepEqual(
      await readFile(new URL('../agent/assets/vendor/pi-goal/' + name, import.meta.url)),
      bytes,
    );
  }
  const plan = pluginLoadPlan(
    { extensions: ['/packages/node_modules/pi-goal/.pi/extensions/pi-goal/index.ts'] },
    { owner: true },
  );
  assert.equal(plan.extensions.filter((p) => p.endsWith('/long-goal.mjs')).length, 1);
  assert.ok(!plan.extensions.some((p) => p.includes('/node_modules/pi-goal/')));
});

test('goal mode has no implicit token budget and accounts real turn usage, with an optional explicit budget', () => {
  const goal = createGoalState('Verify a concrete result', null, 1000, 0.1);
  assert.equal(goal.tokenBudget, null);
  assert.equal(accountGoalTurn(goal, 1e8, 60, 2000).status, 'active');
  const limited = createGoalState('Explicit limit', 100, 1000, 0.1);
  assert.equal(accountGoalTurn(limited, 101, 60, 2000).status, 'budget_limited');
  assert.equal(parseTokenBudget('Verify a concrete result').tokenBudget, null);
  assert.equal(parseTokenBudget('--tokens 40k Verify a concrete result').tokenBudget, 40000);
});

test('explicit goal controls reach the live runtime even when ordinary messages are queued', () => {
  const active = { id: 'current', status: 'running' };
  for (const text of ['/long-goal', '/long-goal status', '/long-goal pause', '/long-goal clear']) {
    assert.equal(longGoalControl(text), text);
    assert.deepEqual(messageDelivery(active, 'queue', text), {
      mode: 'steer',
      parentId: 'current',
    });
  }
  for (const text of [
    '/long-goal resume',
    '/long-goal New goal',
    'please pause',
    '/long-goal pause extra',
  ]) {
    assert.equal(longGoalControl(text), null);
    assert.deepEqual(messageDelivery(active, 'queue', text), { mode: 'queue', parentId: null });
  }
});

test('RPC goal status is bounded and typed, while continuation instructions do not enter rendered chat', () => {
  const goal = createGoalState('Verify a concrete result', null, 1000, 0.1);
  const e = {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'astral-long-goal',
    statusText: JSON.stringify({ goal, triggerTurn: true }),
  };
  assert.equal(longGoalEvent(e).goal.objective, goal.objective);
  assert.equal(longGoalEvent(e).triggerTurn, true);
  assert.equal(
    longGoalEvent({ ...e, statusText: JSON.stringify({ goal: { ...goal, tokensUsed: -1 } }) }),
    null,
  );
  assert.equal(longGoalEvent({ ...e, statusKey: 'other' }), null);
  assert.equal(
    customMessageText({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'pi-goal-event',
        content: 'internal continuation',
        display: true,
      },
    }),
    '',
  );
});
