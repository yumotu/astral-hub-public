import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMailReadFlag } from '../shared/mail-read.mjs';
test('read/unread flags execute immediately and recover lost receipts by lookup without replay', async () => {
  const calls = [];
  const request = async (path, data) => {
    calls.push({ path, data });
    if (path.endsWith('/prepare')) return { id: 'receipt', state: 'prepared' };
    if (path.endsWith('/confirm')) throw Error('lost acknowledgement');
    return { id: 'receipt', state: 'done' };
  };
  const r = await applyMailReadFlag(request, { action: 'read', mailbox: 'INBOX', uids: [101] });
  assert.equal(r.state, 'done');
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/mail/actions/prepare', '/mail/actions/receipt/confirm', '/mail/actions/receipt'],
  );
  await assert.rejects(
    () => applyMailReadFlag(request, { action: 'trash', mailbox: 'INBOX', uids: [101] }),
    /只修改/,
  );
});
test('unconfirmed read flags do not claim success or automatically repeat the mutation', async () => {
  let mutations = 0;
  await assert.rejects(
    () =>
      applyMailReadFlag(
        async (path) => {
          if (path.endsWith('/prepare')) return { id: 'unknown', state: 'prepared' };
          if (path.endsWith('/confirm')) {
            mutations++;
            throw Error('network');
          }
          return { state: 'unknown' };
        },
        { action: 'unread', mailbox: 'INBOX', uids: [101] },
      ),
    /未确认/,
  );
  assert.equal(mutations, 1);
});
