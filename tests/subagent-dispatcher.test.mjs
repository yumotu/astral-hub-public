import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createSuperAgent } from '../server/superagent.mjs';
import { createSubagentDispatcher } from '../server/subagent-dispatcher.mjs';

test('subagent dispatcher starts one runtime, reports progress and never replays completion', async () => {
  const db = new DatabaseSync(':memory:');
  const ledger = createSuperAgent(db);
  const calls = [];
  const dispatcher = createSubagentDispatcher({
    ledger,
    adapters: {
      DPH: {
        async start({ report }) {
          calls.push('start');
          report({ status: 'running', progress: 50, report: '处理中' });
          return { status: 'succeeded', progress: 100, report: '已完成' };
        },
      },
    },
  });
  const id = randomUUID();
  ledger.create('alice', { id, title: '演示委派', input: '完成一个合成任务', runtime: 'DPH' });
  const first = await dispatcher.dispatch('alice', id);
  const second = await dispatcher.dispatch('alice', id);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.deepEqual(calls, ['start']);
  assert.equal(dispatcher.inFlight(), 0);
  db.close();
});

test('unconfigured runtimes remain queued and adapter failures become unknown', async () => {
  const db = new DatabaseSync(':memory:');
  const ledger = createSuperAgent(db);
  const dispatcher = createSubagentDispatcher({ ledger, adapters: { Remote: { start: async () => { throw new Error('连接中断'); } } } });
  const queuedId = randomUUID();
  ledger.create('alice', { id: queuedId, title: '未配置', input: '等待真实执行器', runtime: 'Pi' });
  assert.equal((await dispatcher.dispatch('alice', queuedId)).status, 'queued');
  const failedId = randomUUID();
  ledger.create('alice', { id: failedId, title: '连接失败', input: '模拟未知结果', runtime: 'Remote' });
  assert.equal((await dispatcher.dispatch('alice', failedId)).status, 'unknown');
  db.close();
});
