import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  promptAndSettle,
  customMessageText,
  extensionUiRequest,
  sessionPrompt,
} from '../deploy/pi/rpc-prompt.mjs';
test('native commands after custom-only turns are not hidden inside migrated history', async () => {
  const history = [{ input: '/notify test', output: '通知已提交' }];
  const client = fixture((p, emit) => {
    assert.equal(p.message, '/notify off');
    emit({ type: 'response', id: p.id, success: true, data: { disposition: 'handled' } });
  });
  await promptAndSettle(client, sessionPrompt('/notify off', history, 0), undefined, 100);
  assert.match(sessionPrompt('继续任务', history, 0), /迁移前的完整文本历史/);
  assert.equal(sessionPrompt('继续任务', history, 1), '继续任务');
});
function fixture(answer) {
  const listeners = new Set();
  const emit = (e) => {
    for (const fn of [...listeners]) fn(e);
  };
  const process = new EventEmitter();
  process.stdin = { writable: true, write: (line) => answer(JSON.parse(line), emit) };
  return {
    process,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    listeners,
  };
}
test('native handled commands finish without a model-settled event', async () => {
  const client = fixture((p, emit) =>
    emit({ type: 'response', id: p.id, success: true, data: { disposition: 'handled' } }),
  );
  assert.equal(await promptAndSettle(client, '/cron status', undefined, 100), 'handled');
  assert.equal(client.listeners.size, 0);
});
test('normal prompts wait for settlement, including settlement before acceptance', async () => {
  const client = fixture((p, emit) => {
    emit({ type: 'agent_settled' });
    emit({ type: 'response', id: p.id, success: true, data: { disposition: 'started' } });
  });
  assert.equal(await promptAndSettle(client, 'hello', undefined, 100), 'started');
  const late = fixture((p, emit) => {
    emit({ type: 'response', id: p.id, success: true, data: { disposition: 'started' } });
    setImmediate(() => emit({ type: 'agent_settled' }));
  });
  assert.equal(await promptAndSettle(late, 'hello', undefined, 100), 'started');
});
test('failed acceptance, process exit and deadlines terminate the wait and unsubscribe', async () => {
  const failed = fixture((p, emit) =>
    emit({ type: 'response', id: p.id, success: false, error: 'No command' }),
  );
  await assert.rejects(promptAndSettle(failed, '/invalid', undefined, 100), /No command/);
  const idle = fixture(() => {});
  await assert.rejects(promptAndSettle(idle, 'x', undefined, 5), /超时/);
  assert.equal(idle.listeners.size, 0);
});
test('custom messages and bounded dialog requests preserve plugin output', () => {
  assert.equal(
    customMessageText({
      type: 'message_end',
      message: { role: 'custom', content: 'Scheduler active', display: true },
    }),
    'Scheduler active',
  );
  assert.equal(
    customMessageText({
      type: 'message_end',
      message: { role: 'custom', content: 'hidden', display: false },
    }),
    '',
  );
  assert.deepEqual(
    extensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'unsupported' }),
    null,
  );
  assert.deepEqual(
    extensionUiRequest({
      type: 'extension_ui_request',
      id: 'x',
      method: 'select',
      options: ['a', 2],
    }).options,
    ['a'],
  );
});

test('RPC framing preserves Unicode separators and split UTF-8 while rejecting incomplete records', async () => {
  const { strictLines } = await import('../deploy/pi/rpc-prompt.mjs');
  const { Readable } = await import('node:stream');
  const line = JSON.stringify({ text: '中文\u2028继续\u2029完成' }),
    bytes = Buffer.from(line + '\n');
  const records = [];
  for await (const record of strictLines(
    Readable.from([bytes.subarray(0, 11), bytes.subarray(11)]),
  ))
    records.push(JSON.parse(record));
  assert.deepEqual(records, [{ text: '中文\u2028继续\u2029完成' }]);
  await assert.rejects(async () => {
    for await (const _ of strictLines(Readable.from(['{"bad":1}']))) {
    }
  }, /不完整/);
});

test('active long work refreshes silence deadlines; unanswered questions suspend them until a real answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let emit,
    prompt,
    replied = 0,
    completed = false;
  const client = fixture((p, fire) => {
    emit = fire;
    if (p.type === 'prompt') {
      prompt = p;
      fire({ type: 'response', id: p.id, success: true, data: { disposition: 'started' } });
    } else if (p.type === 'extension_ui_response') replied++;
  });
  const work = promptAndSettle(client, 'long work', undefined, 100).then(() => {
    completed = true;
  });
  for (let n = 0; n < 20; n++) {
    t.mock.timers.tick(90);
    emit({ type: 'message_update' });
  }
  emit({ type: 'extension_ui_request', id: 'question', method: 'input', title: 'Which result?' });
  t.mock.timers.tick(100000);
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(replied, 0, 'no automatic answer is permitted');
  const { writeRpcRecord } = await import('../deploy/pi/rpc-prompt.mjs');
  writeRpcRecord(client, { type: 'extension_ui_response', id: 'question', value: 'the second' });
  assert.equal(replied, 1);
  t.mock.timers.tick(99);
  emit({ type: 'agent_settled' });
  await work;
  assert.equal(completed, true);
  assert.equal(client.listeners.size, 0);
});

test('cancelling a process still ends a human-waiting prompt', async () => {
  const client = fixture((p, emit) => {
    emit({ type: 'response', id: p.id, success: true, data: { disposition: 'started' } });
    emit({ type: 'extension_ui_request', id: 'question', method: 'input' });
  });
  const work = promptAndSettle(client, 'wait', undefined, 100);
  client.process.emit('exit', 143);
  await assert.rejects(work, /进程已退出/);
  assert.equal(client.listeners.size, 0);
});

test('many bounded RPC result frames do not exhaust a lifetime byte counter', async () => {
  const { createCollector } = await import('../deploy/pi/protocol.mjs');
  const collector = createCollector({ maxBytes: 1000 });
  for (let n = 0; n < 50; n++)
    collector.push(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'turn ' + n }],
          stopReason: 'stop',
        },
      }) + '\n',
    );
  assert.equal(collector.result().output, 'turn 49');
  assert.throws(() => collector.push('x'.repeat(1001)), /单条输出过多/);
});

test('handled goal launch waits for its actual agent settlement while status-only commands return promptly', async () => {
  let emit,
    finished = false;
  const client = fixture((p, fire) => {
    emit = fire;
    const goal = {
      version: 1,
      id: 'goal',
      objective: 'verify',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };
    fire({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'astral-long-goal',
      statusText: JSON.stringify({ goal, triggerTurn: true }),
    });
    fire({ type: 'response', id: p.id, success: true, data: { disposition: 'handled' } });
  });
  const task = promptAndSettle(client, '/long-goal verify', undefined, 1000).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false, 'handled was mistaken for completed work');
  emit({ type: 'agent_start' });
  await Promise.resolve();
  assert.equal(finished, false);
  emit({ type: 'agent_settled' });
  await task;
  assert.equal(finished, true);
});
