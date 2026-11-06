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
